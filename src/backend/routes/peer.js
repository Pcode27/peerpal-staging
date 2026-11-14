const express = require('express');
const logger = require('../utils/logger');
const { notifyAllAdmins } = require('../utils/fcm');

const { query, getClient } = require('../db');
const auth = require('../middleware/auth');
const { peerRequestLimiter } = require('../middleware/rateLimit');
const { ICE_SERVERS } = require('../ws/signaling');
const cache = require('../services/cache');
const { deductCredit, refundCredit, getCreditCosts } = require('../utils/creditDeductor');
const { isPermissionActive } = require('../services/policyEngine');
const screening = require('../config/screening');
const { getRestClient } = require('../config/redis');
const { broadcastPeerRequestPush } = require('../services/peerRequestPush');

const PEER_EARNING_RATE   = 0.25;        // peer earns 25% of what requester spent
const CONVERSION_THRESHOLD = 2.0;        // pending credits unlock as spendable in batches of 2
const SESSION_DURATION_MS  = 30 * 60 * 1000; // 30-min session
const SESSION_WARNING_MS   = 25 * 60 * 1000; // warn at 25 min (5 min remaining)

const router = express.Router();

// In-process routing timers: { [request_id]: { broadenTimer, noPeerTimer, specialistIds } }
const routingTimers = new Map();
// In-process session timers: { [session_id]: { warning: Timeout, close: Timeout } }
const sessionTimers = new Map();

const VALID_CHANNELS = ['text', 'voice'];

// ─── Routing helpers (Phase 31.5) ─────────────────────────────────────────────

// Batch-insert in-app notifications for a list of user IDs and fire the urgent FCM push
// to eligible peers. Push eligibility, quiet hours, TTL and dedup live in
// services/peerRequestPush.js (see docs/peer-request-push.md).
// topicLabel is the human-readable label for the topic (e.g. "Grief & Loss"); may be null.
// escalateAt is the request's escalate_at; the push expires when the request does.
async function broadcastToUsers(userIds, requestId, channelPreference, topicSlug, topicLabel, escalateAt) {
  if (!userIds.length) return;
  const payload = JSON.stringify({ request_id: requestId, channel_preference: channelPreference, topic_slug: topicSlug || null });

  // In-app notification for all candidate peers (always — no quiet-hour suppression for in-app)
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     SELECT unnest($1::uuid[]), 'peer_request_broadcast', $2, 'in_app'`,
    [userIds, payload]
  );

  const { enqueuePushNotification, isPushEnabled } = require('../utils/fcm');
  await broadcastPeerRequestPush({
    userIds, requestId, channelPreference, topicLabel, escalateAt,
    query, enqueue: enqueuePushNotification, redis: getRestClient(), pushEnabled: isPushEnabled(),
  }).catch((err) => logger.warn('[broadcast] push error:', err.message));
}

// Returns IDs of peers eligible for the specialist tier.
// When PEER_SCREENING_LIVE=false: all active quiz-done members.
// When true: members with an active permission that covers this topic.
async function getSpecialistPeerIds(topicSlug, excludeUserId) {
  if (!screening.PEER_SCREENING_LIVE || !topicSlug) {
    const { rows } = await query(
      `SELECT id FROM users
       WHERE is_active = true AND role = 'member' AND peer_quiz_done = true AND id != $1`,
      [excludeUserId]
    );
    return rows.map(r => r.id);
  }
  const { rows } = await query(
    `SELECT DISTINCT pp.user_id
     FROM peer_permissions pp
     JOIN topics t ON pp.permission_id = t.required_permission_id
                   OR pp.permission_id = t.secondary_permission_id
     JOIN users u ON u.id = pp.user_id
     WHERE t.slug = $1
       AND pp.status = 'active'
       AND u.is_active = true
       AND u.peer_quiz_done = true
       AND pp.user_id != $2`,
    [topicSlug, excludeUserId]
  );
  return rows.map(r => r.user_id);
}

// Returns general_support peers not yet in alreadyNotifiedIds.
async function getGeneralPeerIds(excludeUserId, alreadyNotifiedIds) {
  if (!screening.PEER_SCREENING_LIVE) return []; // already notified all in tier 1
  const { rows } = await query(
    `SELECT DISTINCT pp.user_id
     FROM peer_permissions pp
     JOIN permissions p ON p.id = pp.permission_id
     JOIN users u ON u.id = pp.user_id
     WHERE p.slug = 'general_support'
       AND pp.status = 'active'
       AND u.is_active = true
       AND u.peer_quiz_done = true
       AND pp.user_id != $1`,
    [excludeUserId]
  );
  const alreadySet = new Set(alreadyNotifiedIds);
  return rows.map(r => r.user_id).filter(id => !alreadySet.has(id));
}

// Appends a JSONB object to routing_audit on a peer_request row.
async function appendRoutingAudit(requestId, entry) {
  await query(
    `UPDATE peer_requests
     SET routing_audit = routing_audit || $1::jsonb, updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify([entry]), requestId]
  );
}

// Step 5 — widen to general_support after 5 min with no specialist accept.
// Already-notified peer IDs are derived from the notifications table so this
// is safe to call from the DB-polling cron job after a server restart.
async function broadenToGeneralTier(requestId, requesterId) {
  const { rows } = await query(
    `SELECT pr.status, pr.channel_preference, pr.topic_slug, pr.escalate_at, t.label AS topic_label
     FROM peer_requests pr
     LEFT JOIN topics t ON t.slug = pr.topic_slug
     WHERE pr.id = $1`,
    [requestId]
  );
  if (!rows.length || rows[0].status !== 'open') return;

  const { channel_preference, topic_slug, topic_label, escalate_at } = rows[0];

  // Derive already-notified IDs from the DB so we never need in-memory state
  const { rows: alreadyRows } = await query(
    `SELECT DISTINCT user_id FROM notifications
     WHERE type = 'peer_request_broadcast' AND payload::jsonb->>'request_id' = $1`,
    [String(requestId)]
  );
  const alreadyNotifiedIds = alreadyRows.map(r => r.user_id);

  const generalIds = await getGeneralPeerIds(requesterId, alreadyNotifiedIds);

  if (generalIds.length > 0) {
    await broadcastToUsers(generalIds, requestId, channel_preference, topic_slug, topic_label || null, escalate_at);
  }

  await appendRoutingAudit(requestId, { ts: new Date().toISOString(), event: 'tier2_broadcast', peer_count: generalIds.length });

  // Step 5 notification — requester told the search is widening
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     VALUES ($1, 'peer_matching_update', $2, 'in_app')`,
    [requesterId, JSON.stringify({
      request_id: requestId,
      status: 'widening',
      message: 'No specialist peer is available right now — we\'re looking for a general support peer instead.',
    })]
  );
}

// Step 7 — no peer found after full window: refund + fallback resources.
async function noMorePeers(requestId, requesterId) {
  const { rows } = await query(
    'SELECT status, channel_preference FROM peer_requests WHERE id = $1',
    [requestId]
  );
  if (!rows.length || rows[0].status !== 'open') return;

  const { channel_preference } = rows[0];

  await query(
    `UPDATE peer_requests SET status = 'escalated', escalated_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [requestId]
  );

  const amount = channel_preference === 'voice' ? 2 : 1;
  await refundCredit(
    requesterId, amount, null, channel_preference,
    `Your ${channel_preference === 'voice' ? 'voice call' : 'text chat'} request expired — no peer was available. ${amount} credit${amount > 1 ? 's' : ''} refunded.`
  );

  await appendRoutingAudit(requestId, { ts: new Date().toISOString(), event: 'no_peer_fallback' });

  // Step 7 — requester gets a calm space offer, never a dead end
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     VALUES ($1, 'peer_matching_update', $2, 'in_app')`,
    [requesterId, JSON.stringify({
      request_id: requestId,
      status: 'no_peer',
      cta: 'calm_space',
      message: "We couldn't find a peer right now. Your calm space is ready for you.",
    })]
  );

  // FCM push so the user is reached even if they closed the app while waiting
  const { rows: fcmRows } = await query('SELECT fcm_token FROM users WHERE id = $1', [requesterId]);
  const fcm_token = fcmRows[0]?.fcm_token;
  if (fcm_token) {
    const { enqueuePushNotification } = require('../utils/fcm');
    enqueuePushNotification(
      fcm_token,
      "Your calm space is ready",
      "We couldn't find a peer right now — tap to find support another way.",
      { type: 'peer_matching_update', cta: 'calm_space' }
    ).catch(err => logger.warn('[noMorePeers] FCM enqueue error:', err.message));
  }

  // Step 8 — admin escalation notification
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     SELECT id, 'peer_escalation', $1, 'in_app'
     FROM users WHERE role = 'admin' AND is_active = true`,
    [JSON.stringify({ request_id: requestId })]
  );
  notifyAllAdmins(query, '⚠️ Peer Escalation', 'A peer request found no match and has been escalated.', { type: 'escalation', request_id: requestId, _urgent: 'true' }).catch(() => {});

  // Step 9 — trusted contact no-peer alerts (fire-and-forget)
  setImmediate(async () => {
    try {
      const { rows: alertTargets } = await query(
        `SELECT tc.contact_user_id, u.alias
         FROM trusted_contacts tc
         JOIN users u ON u.id = tc.user_id
         WHERE tc.user_id = $1 AND tc.status = 'accepted' AND tc.no_peer_alerts = true`,
        [requesterId]
      );
      const { enqueuePushNotification } = require('../utils/fcm');
      for (const t of alertTargets) {
        const { rows: contactRows } = await query('SELECT fcm_token FROM users WHERE id = $1', [t.contact_user_id]);
        const token = contactRows[0]?.fcm_token;
        if (!token) continue;
        await enqueuePushNotification(
          token,
          `${t.alias} was looking for someone to talk to`,
          "They couldn't find anyone — they might need a message.",
          { type: 'trusted_contact_no_peer_alert', route: '/safety-plan' }
        );
        await query(
          `INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'trusted_contact_no_peer_alert', $2, 'push')`,
          [t.contact_user_id, JSON.stringify({ alias: t.alias })]
        );
      }
    } catch (err) {
      logger.warn('[noMorePeers] trusted contact alert error:', err.message);
    }
  });
}

// ─── autoCloseSession ─────────────────────────────────────────────────────────
// Called by the 30-min timer. Mirrors PATCH /close logic without HTTP context.
async function autoCloseSession(requestId, sessionId, requesterId, responderId, channelPreference) {
  const { rows: sessionRows, rowCount } = await query(
    `UPDATE sessions SET status = 'completed', ended_at = NOW()
     WHERE id = $1 AND status = 'active' RETURNING started_at, ended_at`,
    [sessionId]
  );
  if (!rowCount) return; // already manually closed — nothing to do

  await query(`UPDATE peer_requests SET status = 'closed', updated_at = NOW() WHERE id = $1`, [requestId]);

  if (sessionRows[0]?.started_at) {
    const durationMinutes = Math.round(
      (new Date(sessionRows[0].ended_at) - new Date(sessionRows[0].started_at)) / 60000
    );
    await query(
      `UPDATE credit_transactions SET duration_minutes = $1 WHERE session_id = $2 AND type = 'debit'`,
      [durationMinutes, sessionId]
    );
  }

  // Total requester spend — includes original deduction + any extensions
  const { rows: spentRows } = await query(
    `SELECT COALESCE(SUM(amount_credits), 0) AS total_spent
     FROM credit_transactions WHERE session_id = $1 AND user_id = $2 AND type = 'debit'`,
    [sessionId, requesterId]
  );
  const requesterSpent = parseFloat(spentRows[0].total_spent);

  if (responderId && requesterSpent > 0) {
    const earned = +(requesterSpent * PEER_EARNING_RATE).toFixed(2);
    const dbClient = await getClient();
    try {
      await dbClient.query('BEGIN');
      const { rows: statsRows } = await dbClient.query(
        `INSERT INTO peer_stats (user_id, sessions_completed, pending_credits, earned_credits_lifetime)
         VALUES ($1, 1, $2, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET sessions_completed      = peer_stats.sessions_completed + 1,
               pending_credits         = peer_stats.pending_credits + $2,
               earned_credits_lifetime = peer_stats.earned_credits_lifetime + $2,
               updated_at              = NOW()
         RETURNING pending_credits`,
        [responderId, earned]
      );
      const newPending = parseFloat(parseFloat(statsRows[0].pending_credits).toFixed(2));
      if (newPending >= CONVERSION_THRESHOLD) {
        const toConvert = Math.floor(newPending);
        const remaining = parseFloat((newPending - toConvert).toFixed(2));
        await dbClient.query(
          `UPDATE peer_stats SET pending_credits = $1, redeemed_credits_lifetime = redeemed_credits_lifetime + $2, updated_at = NOW() WHERE user_id = $3`,
          [remaining, toConvert, responderId]
        );
        await dbClient.query(
          'UPDATE credits SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
          [toConvert, responderId]
        );
        await dbClient.query(
          `INSERT INTO credit_transactions (user_id, type, amount_credits, payment_method, session_id, channel, status)
           VALUES ($1, 'peer_earning', $2, 'bonus', $3, 'peer_earning', 'confirmed')`,
          [responderId, toConvert, sessionId]
        );
        await cache.del(`credits:${responderId}`);
        await dbClient.query(
          `INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'milestone', $2, 'in_app')`,
          [responderId, JSON.stringify({ message: `You've earned ${toConvert} credit${toConvert > 1 ? 's' : ''} from supporting others. It's been added to your balance.` })]
        );
      }
      await dbClient.query('COMMIT');
    } catch (err) {
      await dbClient.query('ROLLBACK');
      logger.error('Peer earning error (auto-close):', err.message);
    } finally {
      dbClient.release();
    }
  }

  // Funnel step hook — advance both participants
  const funnelSql = `UPDATE users SET
     last_session_at = NOW(),
     first_session_completed_at = COALESCE(first_session_completed_at, NOW()),
     reengagement_step = CASE
       WHEN first_session_completed_at IS NULL THEN 'step3_incomplete'
       WHEN reengagement_step = 'step3_incomplete'
            AND first_session_completed_at >= NOW() - INTERVAL '7 days' THEN 'converted'
       ELSE reengagement_step
     END
   WHERE id = $1`;
  await query(funnelSql, [requesterId]).catch((e) => logger.error('[reengagement-hook/auto-close requester]', e.message));
  if (responderId) {
    await query(funnelSql, [responderId]).catch((e) => logger.error('[reengagement-hook/auto-close responder]', e.message));
  }

  // Notify both parties: session ended by time limit
  const endPayload = JSON.stringify({ session_id: sessionId, reason: 'time_limit' });
  await query(`INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'account_notice', $2, 'in_app')`, [requesterId, endPayload]);
  if (responderId) {
    await query(`INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'account_notice', $2, 'in_app')`, [responderId, endPayload]);
  }

  // Safety notice if requester balance is now 0
  const { rows: balRows } = await query('SELECT balance FROM credits WHERE user_id = $1', [requesterId]);
  if ((balRows[0]?.balance ?? 0) === 0) {
    await query(
      `INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'account_notice', $2, 'in_app')`,
      [requesterId, JSON.stringify({
        session_ended: true,
        emergency: true,
        message: 'Your session has ended. If you need immediate support: Befrienders Kenya 0800 723 253 (free, 24/7).',
      })]
    );
  }
}

// ─── POST /peer/request ───────────────────────────────────────────────────────
router.post('/request', auth, peerRequestLimiter, async (req, res) => {
  const { channel_preference, topic_slug, secondary_topic_slug } = req.body;

  if (!VALID_CHANNELS.includes(channel_preference)) {
    return res.status(400).json({ error: `channel_preference must be one of: ${VALID_CHANNELS.join(', ')}`, code: 'INVALID_CHANNEL' });
  }

  // Idempotency: return existing open/locked request rather than creating a duplicate
  const { rows: existing } = await query(
    `SELECT id FROM peer_requests WHERE user_id = $1 AND status IN ('open', 'locked') ORDER BY created_at DESC LIMIT 1`,
    [req.user.id]
  );
  if (existing.length) {
    return res.status(200).json({ request_id: existing[0].id, reused: true });
  }

  // Cooldown: 2+ cancels within 10 minutes → 90s cooldown from the last cancel
  const { rows: recentCancels } = await query(
    `SELECT updated_at FROM peer_requests
     WHERE user_id = $1 AND status = 'cancelled' AND updated_at > NOW() - INTERVAL '10 minutes'
     ORDER BY updated_at DESC`,
    [req.user.id]
  );
  if (recentCancels.length >= 2) {
    const lastCancel = new Date(recentCancels[0].updated_at);
    const secondsElapsed = (Date.now() - lastCancel.getTime()) / 1000;
    const cooldownSeconds = 90;
    if (secondsElapsed < cooldownSeconds) {
      const retryAfter = Math.ceil(cooldownSeconds - secondsElapsed);
      return res.status(429).json({
        error: 'You have cancelled multiple requests. Please wait before trying again.',
        code: 'COOLDOWN_ACTIVE',
        retry_after: retryAfter,
      });
    }
  }

  // Validate topic_slug
  let topicRow = null;
  if (topic_slug) {
    const { rows } = await query('SELECT id, label FROM topics WHERE slug = $1 AND is_active = true', [topic_slug]);
    if (!rows.length) return res.status(400).json({ error: 'Invalid topic_slug', code: 'INVALID_TOPIC' });
    topicRow = rows[0];
  }

  // Step 1 — Crisis check: if user is at critical risk, include emergency resources in response.
  // Peer routing still proceeds — a crisis user getting peer support is better than none.
  const { rows: userRows } = await query('SELECT risk_level FROM users WHERE id = $1', [req.user.id]);
  const isCrisis = userRows[0]?.risk_level === 'critical';

  // Insert peer_request — broaden_at/escalate_at persist the routing schedule
  // so the cron job can fire them even if the server restarts before the timers fire.
  const { rows: reqRows } = await query(
    `INSERT INTO peer_requests (user_id, channel_preference, topic_slug, secondary_topic_slug, escalation_job_id, broaden_at, escalate_at)
     VALUES ($1, $2, $3, $4, gen_random_uuid()::text, NOW() + INTERVAL '1 minute', NOW() + INTERVAL '130 seconds') RETURNING id, escalate_at`,
    [req.user.id, channel_preference, topic_slug || null, secondary_topic_slug || null]
  );
  const requestId = reqRows[0].id;
  const requestEscalateAt = reqRows[0].escalate_at;

  // Deduct credits at submission: configurable per channel (default: 1cr text, 2cr voice)
  const _costs1 = await getCreditCosts();
  const creditCost = channel_preference === 'voice' ? _costs1.voice : _costs1.text;
  const { blocked } = await deductCredit(req.user.id, creditCost, null, channel_preference);
  if (blocked) {
    await query('DELETE FROM peer_requests WHERE id = $1', [requestId]);
    return res.status(402).json({ error: 'Insufficient credits — top up to request peer support', code: 'INSUFFICIENT_CREDITS' });
  }

  // Step 2 — Broadcast to specialist tier (permission-filtered when PEER_SCREENING_LIVE=true)
  const userId = req.user.id;
  const specialistIds = await getSpecialistPeerIds(topic_slug, userId);
  await broadcastToUsers(specialistIds, requestId, channel_preference, topic_slug, topicRow?.label || null, requestEscalateAt);
  await appendRoutingAudit(requestId, { ts: new Date().toISOString(), event: 'tier1_broadcast', peer_count: specialistIds.length, topic_slug: topic_slug || null });

  // Notify requester: search has started
  const searchMessage = screening.PEER_SCREENING_LIVE && topic_slug && topicRow
    ? `Looking for a peer with ${topicRow.label} awareness training...`
    : 'Looking for a peer...';
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'peer_matching_update', $2, 'in_app')`,
    [userId, JSON.stringify({ request_id: requestId, status: 'searching', message: searchMessage })]
  );

  // Start two-tier routing timers:
  // T+1 min  → widen to general_support peers (step 5)
  // T+2m10s  → no peer available, refund + fallback (step 7)
  // In-process fast-path timers — these fire immediately when the server is live.
  // The routingJob cron provides a persistent fallback if the server restarts first.
  const broadenTimer = setTimeout(async () => {
    try { await broadenToGeneralTier(requestId, userId); }
    catch (e) { logger.error('Broaden tier error:', e); }
  }, 60 * 1000);

  const noPeerTimer = setTimeout(async () => {
    routingTimers.delete(requestId);
    try { await noMorePeers(requestId, userId); }
    catch (e) { logger.error('No-peer error:', e); }
  }, 130 * 1000);

  routingTimers.set(requestId, { broadenTimer, noPeerTimer });

  const response = { request_id: requestId };
  if (isCrisis) {
    // Step 1 — crisis guard: surface emergency resources alongside peer routing
    response.crisis_resources = {
      message: 'If you need immediate support right now, these are available 24/7:',
      resources: [{ name: 'Befrienders Kenya', phone: '0800 723 253', availability: '24/7, free' }],
    };
  }

  return res.status(201).json(response);
});

// ─── GET /peer/requests/open ──────────────────────────────────────────────────
router.get('/requests/open', auth, async (req, res) => {
  let rows;
  if (screening.PEER_SCREENING_LIVE) {
    // Only surface requests the calling peer is qualified to handle:
    // either their permission covers the topic, or the topic is unset, or they hold general_support.
    ({ rows } = await query(
      `SELECT DISTINCT pr.id, pr.channel_preference, pr.topic_slug, pr.created_at
       FROM peer_requests pr
       WHERE pr.status = 'open' AND pr.user_id != $1
         AND (
           pr.topic_slug IS NULL
           OR EXISTS (
             SELECT 1 FROM peer_permissions pp
             JOIN topics t ON pp.permission_id = t.required_permission_id
                           OR pp.permission_id = t.secondary_permission_id
             WHERE pp.user_id = $1 AND pp.status = 'active' AND t.slug = pr.topic_slug
           )
           OR EXISTS (
             SELECT 1 FROM peer_permissions pp
             JOIN permissions p ON pp.permission_id = p.id
             WHERE pp.user_id = $1 AND pp.status = 'active' AND p.slug = 'general_support'
           )
         )
       ORDER BY pr.created_at ASC`,
      [req.user.id]
    ));
  } else {
    ({ rows } = await query(
      `SELECT id, channel_preference, topic_slug, created_at
       FROM peer_requests
       WHERE status = 'open' AND user_id != $1
       ORDER BY created_at ASC`,
      [req.user.id]
    ));
  }
  return res.status(200).json({ requests: rows });
});

// ─── GET /peer/quiz/status ────────────────────────────────────────────────────
router.get('/quiz/status', auth, async (req, res) => {
  const { rows } = await query('SELECT peer_quiz_done FROM users WHERE id = $1', [req.user.id]);
  return res.status(200).json({ peer_quiz_done: rows[0]?.peer_quiz_done ?? false });
});

// ─── POST /peer/quiz/complete ─────────────────────────────────────────────────
router.post('/quiz/complete', auth, async (req, res) => {
  await query('UPDATE users SET peer_quiz_done = true, peer_available_until = NOW() + INTERVAL \'10 years\', updated_at = NOW() WHERE id = $1', [req.user.id]);
  return res.status(200).json({ peer_quiz_done: true });
});

// ─── GET /peer/available-count ────────────────────────────────────────────────
router.get('/available-count', auth, async (req, res) => {
  const { rows } = await query(`
    SELECT COUNT(*) AS count
    FROM users
    WHERE peer_quiz_done = true
      AND is_active = true
      AND peer_available_until > NOW()
      AND notif_peer_broadcast = true
      AND id != $1
      AND NOT EXISTS (
        SELECT 1 FROM peer_requests pr
        WHERE pr.accepted_by = id AND pr.status = 'active'
      )
  `, [req.user.id]);
  return res.status(200).json({ count: parseInt(rows[0].count, 10) });
});

// ─── PATCH /peer/request/:id/accept ──────────────────────────────────────────
router.patch('/request/:id/accept', auth, async (req, res) => {
  // Quiz gate — must complete readiness check before first accept
  const { rows: quizRows } = await query('SELECT peer_quiz_done FROM users WHERE id = $1', [req.user.id]);
  if (!quizRows[0]?.peer_quiz_done) {
    return res.status(403).json({ error: 'Complete the peer readiness check first', code: 'QUIZ_REQUIRED' });
  }

  // When PEER_SCREENING_LIVE: check the peer holds the required permission for this topic.
  if (screening.PEER_SCREENING_LIVE) {
    const { rows: reqPreview } = await query(
      'SELECT topic_slug FROM peer_requests WHERE id = $1 AND status = $2',
      [req.params.id, 'open']
    );
    if (reqPreview.length && reqPreview[0].topic_slug) {
      const { rows: topicRows } = await query(
        'SELECT required_permission_id, secondary_permission_id FROM topics WHERE slug = $1',
        [reqPreview[0].topic_slug]
      );
      if (topicRows.length) {
        const { required_permission_id, secondary_permission_id } = topicRows[0];
        const permIds = [required_permission_id, secondary_permission_id].filter(Boolean);
        const { rows: permCheck } = await query(
          `SELECT 1 FROM peer_permissions WHERE user_id = $1 AND permission_id = ANY($2) AND status = 'active' LIMIT 1`,
          [req.user.id, permIds]
        );
        if (!permCheck.length) {
          return res.status(403).json({ error: 'You don\'t have the required permission for this topic', code: 'PERMISSION_REQUIRED' });
        }
      }
    }
  }

  // Atomic lock — only succeeds if status is still 'open'
  const { rows: locked, rowCount } = await query(
    `UPDATE peer_requests
        SET status = 'locked', accepted_by = $1, updated_at = NOW()
      WHERE id = $2 AND status = 'open'
      RETURNING id, channel_preference, user_id`,
    [req.user.id, req.params.id]
  );

  if (!rowCount) {
    const { rows: check } = await query('SELECT status, user_id FROM peer_requests WHERE id = $1', [req.params.id]);
    if (!check.length) return res.status(404).json({ error: 'Request not found', code: 'NOT_FOUND' });
    if (check[0].user_id === req.user.id) return res.status(403).json({ error: 'Cannot accept your own request', code: 'FORBIDDEN' });
    if (check[0].status === 'cancelled') return res.status(410).json({ error: 'This request was cancelled by the user', code: 'REQUEST_CANCELLED' });
    return res.status(409).json({ error: 'Request is no longer open', code: 'REQUEST_UNAVAILABLE' });
  }

  const { id: requestId, channel_preference, user_id: requesterId } = locked[0];

  // Own-request guard (belt-and-suspenders — the lock query doesn't catch this)
  if (requesterId === req.user.id) {
    await query(`UPDATE peer_requests SET status = 'open', accepted_by = NULL WHERE id = $1`, [requestId]);
    return res.status(403).json({ error: 'Cannot accept your own request', code: 'FORBIDDEN' });
  }

  // Cancel routing timers — request accepted, no need to widen or give up
  const routingState = routingTimers.get(requestId);
  if (routingState) {
    clearTimeout(routingState.broadenTimer);
    clearTimeout(routingState.noPeerTimer);
    routingTimers.delete(requestId);
  }

  // Update last_active_at on the peer's relevant permission (activity signal for inactivity job)
  if (screening.PEER_SCREENING_LIVE && locked[0]?.channel_preference) {
    const { rows: topicRows } = await query(
      'SELECT required_permission_id, secondary_permission_id FROM topics WHERE slug = (SELECT topic_slug FROM peer_requests WHERE id = $1)',
      [requestId]
    );
    if (topicRows.length) {
      const { required_permission_id, secondary_permission_id } = topicRows[0];
      const permIds = [required_permission_id, secondary_permission_id].filter(Boolean);
      if (permIds.length) {
        await query(
          `UPDATE peer_permissions SET last_active_at = NOW()
           WHERE user_id = $1 AND permission_id = ANY($2) AND status = 'active'`,
          [req.user.id, permIds]
        );
      }
    }
  }

  // Create the session (user_id = requester)
  let sessionId;
  try {
    const { rows: sessionRows } = await query(
      `INSERT INTO sessions (user_id, type, channel, status, peer_request_id)
       VALUES ($1, 'peer', $2, 'active', $3) RETURNING id`,
      [requesterId, channel_preference, requestId]
    );
    sessionId = sessionRows[0].id;
  } catch (err) {
    // Roll back the lock so another peer can accept
    await query(`UPDATE peer_requests SET status = 'open', accepted_by = NULL, updated_at = NOW() WHERE id = $1`, [requestId]);
    logger.error('Session insert failed, request unlocked:', err.message);
    return res.status(500).json({ error: 'Could not create session. Please try again.', code: 'SESSION_CREATE_FAILED' });
  }

  // Activate the peer request with the session
  await query(
    `UPDATE peer_requests SET session_id = $1, status = 'active', updated_at = NOW() WHERE id = $2`,
    [sessionId, requestId]
  );

  // Backfill session_id on the requester's debit transaction (created at submission with session_id=NULL)
  await query(
    `UPDATE credit_transactions
     SET session_id = $1
     WHERE id = (
       SELECT id FROM credit_transactions
       WHERE user_id = $2 AND channel = $3 AND type = 'debit' AND session_id IS NULL
       ORDER BY created_at DESC LIMIT 1
     )`,
    [sessionId, requesterId, channel_preference]
  );

  // Step 8 — audit log: accepted
  await appendRoutingAudit(requestId, { ts: new Date().toISOString(), event: 'accepted', responder_id: req.user.id });

  // Notify requester — in-app + FCM push so a backgrounded app wakes up
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     VALUES ($1, 'session_confirmation', $2, 'in_app')`,
    [requesterId, JSON.stringify({ session_id: sessionId, channel: channel_preference })]
  );
  {
    const { enqueuePushNotification } = require('../utils/fcm');
    const { rows: fcmRows } = await query('SELECT fcm_token FROM users WHERE id = $1', [requesterId]);
    const fcmToken = fcmRows[0]?.fcm_token;
    if (fcmToken) {
      const label = channel_preference === 'voice' ? 'Voice call' : 'Chat session';
      enqueuePushNotification(
        fcmToken,
        `Your peer is ready — ${label} starting`,
        'Tap to join your peer support session.',
        { type: 'session_confirmation', session_id: sessionId, channel: channel_preference, route: `/peer/session/${sessionId}/bridge` }
      ).catch(err => logger.warn('[accept] requester FCM error:', err.message));
    }
  }

  // Start 25-min warning + 30-min auto-close timers
  const responderId = req.user.id;
  const warnTimer = setTimeout(async () => {
    try {
      const warnPayload = JSON.stringify({ session_id: sessionId, minutes_remaining: 5, extendable: true });
      await query(`INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'account_notice', $2, 'push')`, [requesterId, warnPayload]);
      await query(`INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'account_notice', $2, 'push')`, [responderId, JSON.stringify({ session_id: sessionId, minutes_remaining: 5 })]);
    } catch (e) { logger.error('Session warning error:', e); }
  }, SESSION_WARNING_MS);

  const autoCloseTimer = setTimeout(async () => {
    sessionTimers.delete(sessionId);
    try { await autoCloseSession(requestId, sessionId, requesterId, responderId, channel_preference); }
    catch (e) { logger.error('Auto-close error:', e); }
  }, SESSION_DURATION_MS);

  sessionTimers.set(sessionId, { warning: warnTimer, close: autoCloseTimer });

  return res.status(200).json({ session_id: sessionId, channel: channel_preference, request_id: requestId });
});

// ─── GET /peer/request/active ─────────────────────────────────────────────────
// Returns the caller's current open/locked/active request — used by the
// connecting screen to recover state after refresh or remount.
router.get('/request/active', auth, async (req, res) => {
  const { rows } = await query(
    `SELECT pr.id, pr.status, pr.channel_preference, pr.topic_slug, pr.session_id,
            t.label AS topic_label
     FROM peer_requests pr
     LEFT JOIN topics t ON t.slug = pr.topic_slug
     WHERE pr.user_id = $1 AND pr.status IN ('open', 'locked', 'active')
     ORDER BY pr.created_at DESC LIMIT 1`,
    [req.user.id]
  );
  return res.status(200).json({ request: rows[0] || null });
});

// ─── GET /peer/request/:id/status ─────────────────────────────────────────────
// Polled by waiting screen to detect when request is accepted or escalated.
router.get('/request/:id/status', auth, async (req, res) => {
  const { rows } = await query(
    `SELECT pr.id, pr.status, pr.channel_preference, pr.session_id
     FROM peer_requests pr
     WHERE pr.id = $1 AND pr.user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  return res.status(200).json(rows[0]);
});

// ─── PATCH /peer/request/:id/close ───────────────────────────────────────────
router.patch('/request/:id/close', auth, async (req, res) => {
  const { never_connected } = req.body || {};

  const { rows } = await query(
    `SELECT pr.id, pr.session_id, pr.user_id, pr.accepted_by, pr.channel_preference
     FROM peer_requests pr WHERE pr.id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Request not found', code: 'NOT_FOUND' });

  const { session_id, user_id: requesterId, accepted_by: responderId, channel_preference } = rows[0];

  if (req.user.id !== requesterId && req.user.id !== responderId) {
    return res.status(403).json({ error: 'Not a participant in this session', code: 'FORBIDDEN' });
  }

  // ── User cancelled while still waiting (no session created yet) ────────────
  if (!session_id) {
    // Stop the in-process routing timers so broaden/no-peer don't fire after cancel
    const rTimers = routingTimers.get(req.params.id);
    if (rTimers) {
      clearTimeout(rTimers.broadenTimer);
      clearTimeout(rTimers.noPeerTimer);
      routingTimers.delete(req.params.id);
    }

    // Atomically cancel — idempotent if already cancelled/escalated
    const { rowCount } = await query(
      `UPDATE peer_requests SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status IN ('open', 'locked')`,
      [req.params.id]
    );

    if (rowCount) {
      const _costs2 = await getCreditCosts();
      const creditCost = channel_preference === 'voice' ? _costs2.voice : _costs2.text;
      await refundCredit(
        requesterId, creditCost, null, channel_preference,
        `Your ${channel_preference === 'voice' ? 'voice call' : 'text chat'} request was cancelled — ${creditCost} credit${creditCost > 1 ? 's' : ''} refunded.`
      );
      // Expire broadcast notifications so peers no longer see this request
      await query(
        `DELETE FROM notifications WHERE type = 'peer_request_broadcast' AND payload::jsonb->>'request_id' = $1`,
        [String(req.params.id)]
      ).catch(() => {});
    }

    return res.status(200).json({ cancelled: true });
  }

  // Clear session timers — manual close beats auto-close
  const timers = sessionTimers.get(session_id);
  if (timers) { clearTimeout(timers.warning); clearTimeout(timers.close); sessionTimers.delete(session_id); }

  // Only transition from active → completed; a second call is a no-op
  const { rows: sessionRows } = await query(
    `UPDATE sessions SET status = 'completed', ended_at = NOW()
     WHERE id = $1 AND status = 'active' RETURNING ended_at, started_at`,
    [session_id]
  );

  if (!sessionRows.length) {
    // Already closed — return without re-running earning logic
    return res.status(200).json({ ended_at: null });
  }

  await query(
    `UPDATE peer_requests SET status = 'closed', updated_at = NOW() WHERE id = $1`,
    [req.params.id]
  );

  // Notify the other party that this party has left
  const closingUserId = req.user.id;
  const otherPartyId = closingUserId === requesterId ? responderId : requesterId;
  if (otherPartyId) {
    const leavePayload = JSON.stringify({ session_id, reason: 'peer_left' });
    await query(
      `INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'account_notice', $2, 'in_app')`,
      [otherPartyId, leavePayload]
    ).catch(() => {});
    const { rows: otherRows } = await query('SELECT fcm_token FROM users WHERE id = $1', [otherPartyId]);
    if (otherRows[0]?.fcm_token) {
      const { enqueuePushNotification } = require('../utils/fcm');
      await enqueuePushNotification(
        otherRows[0].fcm_token,
        'Session ended',
        'Your peer has left the session.',
        { type: 'peer_left', session_id: String(session_id) }
      ).catch(() => {});
    }
  }

  // If WebRTC never connected, refund the requester (only within 90s of session start)
  const sessionAgeSeconds = sessionRows[0].started_at
    ? (Date.now() - new Date(sessionRows[0].started_at).getTime()) / 1000
    : 0;
  if (never_connected && req.user.id === requesterId && sessionAgeSeconds < 90) {
    const _costs3 = await getCreditCosts();
    const creditCost = channel_preference === 'voice' ? _costs3.voice : _costs3.text;
    await refundCredit(
      requesterId, creditCost, session_id, channel_preference,
      `Your ${channel_preference === 'voice' ? 'voice call' : 'text chat'} could not connect — ${creditCost} credit${creditCost > 1 ? 's' : ''} refunded.`
    );
    return res.status(200).json({ ended_at: sessionRows[0].ended_at, refunded: true });
  }

  // Record duration on the requester's debit transaction
  if (sessionRows[0]?.started_at && sessionRows[0]?.ended_at) {
    const durationMinutes = Math.round(
      (new Date(sessionRows[0].ended_at) - new Date(sessionRows[0].started_at)) / 60000
    );
    await query(
      `UPDATE credit_transactions SET duration_minutes = $1 WHERE session_id = $2 AND type = 'debit'`,
      [durationMinutes, session_id]
    );
  }

  // Fractional peer earning — 25% of requester spend, accumulates to threshold of 2.0
  // Query total spend so extensions are included automatically
  if (responderId) {
    const { rows: spentRows } = await query(
      `SELECT COALESCE(SUM(amount_credits), 0) AS total_spent
       FROM credit_transactions WHERE session_id = $1 AND user_id = $2 AND type = 'debit'`,
      [session_id, requesterId]
    );
    const requesterSpent = parseFloat(spentRows[0].total_spent);
    const earned = +(requesterSpent * PEER_EARNING_RATE).toFixed(2);

    const dbClient = await getClient();
    try {
      await dbClient.query('BEGIN');

      const { rows: statsRows } = await dbClient.query(
        `INSERT INTO peer_stats (user_id, sessions_completed, pending_credits, earned_credits_lifetime)
         VALUES ($1, 1, $2, $2)
         ON CONFLICT (user_id) DO UPDATE
           SET sessions_completed       = peer_stats.sessions_completed + 1,
               pending_credits          = peer_stats.pending_credits + $2,
               earned_credits_lifetime  = peer_stats.earned_credits_lifetime + $2,
               updated_at               = NOW()
         RETURNING pending_credits`,
        [responderId, earned]
      );

      const newPending = parseFloat(parseFloat(statsRows[0].pending_credits).toFixed(2));

      if (newPending >= CONVERSION_THRESHOLD) {
        const toConvert = Math.floor(newPending);
        const remaining = parseFloat((newPending - toConvert).toFixed(2));

        await dbClient.query(
          `UPDATE peer_stats
             SET pending_credits          = $1,
                 redeemed_credits_lifetime = redeemed_credits_lifetime + $2,
                 updated_at               = NOW()
           WHERE user_id = $3`,
          [remaining, toConvert, responderId]
        );

        await dbClient.query(
          'UPDATE credits SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
          [toConvert, responderId]
        );

        await dbClient.query(
          `INSERT INTO credit_transactions
             (user_id, type, amount_credits, payment_method, session_id, channel, status)
           VALUES ($1, 'peer_earning', $2, 'bonus', $3, 'peer_earning', 'confirmed')`,
          [responderId, toConvert, session_id]
        );

        await cache.del(`credits:${responderId}`);

        await dbClient.query(
          `INSERT INTO notifications (user_id, type, payload, channel)
           VALUES ($1, 'milestone', $2, 'in_app')`,
          [responderId, JSON.stringify({
            message: `You've earned ${toConvert} credit${toConvert > 1 ? 's' : ''} from supporting others. It's been added to your balance.`,
          })]
        );
      }

      await dbClient.query('COMMIT');
    } catch (err) {
      await dbClient.query('ROLLBACK');
      logger.error('Peer earning error:', err.message);
    } finally {
      dbClient.release();
    }
  }

  // Funnel step hook — advance both participants (requester + responder)
  const funnelHookSql = `UPDATE users SET
     last_session_at = NOW(),
     first_session_completed_at = COALESCE(first_session_completed_at, NOW()),
     reengagement_step = CASE
       WHEN first_session_completed_at IS NULL THEN 'step3_incomplete'
       WHEN reengagement_step = 'step3_incomplete'
            AND first_session_completed_at >= NOW() - INTERVAL '7 days' THEN 'converted'
       ELSE reengagement_step
     END
   WHERE id = $1`;
  await query(funnelHookSql, [requesterId]).catch((e) => logger.error('[reengagement-hook/peer-close requester]', e.message));
  if (responderId) {
    await query(funnelHookSql, [responderId]).catch((e) => logger.error('[reengagement-hook/peer-close responder]', e.message));
  }

  return res.status(200).json({ ended_at: sessionRows[0]?.ended_at });
});

// ─── GET /peer/session/:id ────────────────────────────────────────────────────
router.get('/session/:id', auth, async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.type, s.channel, s.status, s.credit_cost, s.started_at, s.ended_at,
            pr.id AS request_id, pr.channel_preference, pr.user_id AS requester_id, pr.accepted_by AS responder_id,
            pr.topic_slug,
            t.label AS topic_label,
            CASE WHEN s.user_id = $2 THEN u_peer.alias ELSE u_req.alias END AS peer_alias
     FROM sessions s
     JOIN peer_requests pr ON pr.session_id = s.id
     LEFT JOIN topics t ON t.slug = pr.topic_slug
     LEFT JOIN users u_req ON u_req.id = pr.user_id
     LEFT JOIN users u_peer ON u_peer.id = pr.accepted_by
     WHERE s.id = $1 AND s.type = 'peer'
       AND (s.user_id = $2 OR pr.accepted_by = $2)`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });

  const session = rows[0];
  return res.status(200).json({ session, ice_servers: ICE_SERVERS });
});

// ─── GET /peer/history ────────────────────────────────────────────────────────
router.get('/history', auth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  const { rows } = await query(
    `SELECT s.id, s.channel, s.status, s.created_at, s.ended_at
     FROM sessions s
     WHERE s.user_id = $1 AND s.type = 'peer'
     ORDER BY s.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]
  );
  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM sessions WHERE user_id = $1 AND type = 'peer'`,
    [req.user.id]
  );
  const total = parseInt(countRows[0].count);

  return res.status(200).json({ sessions: rows, total, page, pages: Math.ceil(total / limit) });
});

// ─── GET /peer/has-completed-session ─────────────────────────────────────────
// Single boolean — used by dashboard to gate the first-call card.
router.get('/has-completed-session', auth, async (req, res) => {
  const { rows } = await query(
    `SELECT 1 FROM sessions
     WHERE user_id = $1 AND status = 'completed'
     LIMIT 1`,
    [req.user.id]
  );
  return res.json({ hasCompletedSession: rows.length > 0 });
});

// ─── GET /peer/stats ─────────────────────────────────────────────────────────
router.get('/stats', auth, async (req, res) => {
  // sessions_completed from peer_requests — authoritative, includes pre-Phase 27 history
  const { rows: completedRows } = await query(
    `SELECT COUNT(*) AS sessions_completed
     FROM peer_requests WHERE accepted_by = $1 AND status = 'closed'`,
    [req.user.id]
  );
  const sessionsCompleted = parseInt(completedRows[0].sessions_completed);

  // Earning stats from peer_stats (starts accumulating from Phase 27 onward)
  const { rows: earningRows } = await query(
    `SELECT pending_credits, earned_credits_lifetime, redeemed_credits_lifetime
     FROM peer_stats WHERE user_id = $1`,
    [req.user.id]
  );
  const earning = earningRows[0] || {
    pending_credits: 0,
    earned_credits_lifetime: 0,
    redeemed_credits_lifetime: 0,
  };

  // Rank: how many other peers have more completed sessions + 1
  const { rows: rankRows } = await query(
    `SELECT COUNT(*) + 1 AS rank
     FROM (
       SELECT accepted_by, COUNT(*) AS cnt
       FROM peer_requests WHERE status = 'closed' AND accepted_by IS NOT NULL
       GROUP BY accepted_by
     ) sub
     WHERE sub.cnt > $1`,
    [sessionsCompleted]
  );

  return res.status(200).json({
    sessions_completed: sessionsCompleted,
    pending_credits: parseFloat(earning.pending_credits),
    earned_credits_lifetime: parseFloat(earning.earned_credits_lifetime),
    redeemed_credits_lifetime: parseFloat(earning.redeemed_credits_lifetime),
    credits_earned: parseFloat(earning.redeemed_credits_lifetime), // backward compat for PeerRequestScreen
    rank: parseInt(rankRows[0].rank),
  });
});

// ─── POST /peer/request/:id/extend ───────────────────────────────────────────
router.post('/request/:id/extend', auth, peerRequestLimiter, async (req, res) => {
  const { rows } = await query(
    `SELECT pr.session_id, pr.user_id, pr.accepted_by, pr.channel_preference
     FROM peer_requests pr WHERE pr.id = $1 AND pr.status = 'active'`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Active session not found', code: 'NOT_FOUND' });

  const { session_id, user_id: requesterId, accepted_by: responderId, channel_preference } = rows[0];

  if (req.user.id !== requesterId) {
    return res.status(403).json({ error: 'Only the requester can extend a session', code: 'FORBIDDEN' });
  }

  const _costs4 = await getCreditCosts();
  const extensionCost = channel_preference === 'voice' ? _costs4.voice : _costs4.text;
  const { blocked } = await deductCredit(req.user.id, extensionCost, session_id, channel_preference);
  if (blocked) {
    return res.status(402).json({ error: 'Insufficient credits to extend session', code: 'INSUFFICIENT_CREDITS' });
  }

  // Reset timers for another 30 min
  const existing = sessionTimers.get(session_id);
  if (existing) { clearTimeout(existing.warning); clearTimeout(existing.close); }

  const warnTimer = setTimeout(async () => {
    try {
      const warnPayload = JSON.stringify({ session_id, minutes_remaining: 5, extendable: true });
      await query(`INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'account_notice', $2, 'push')`, [requesterId, warnPayload]);
    } catch (e) { logger.error('Session warning error:', e); }
  }, SESSION_WARNING_MS);

  const autoCloseTimer = setTimeout(async () => {
    sessionTimers.delete(session_id);
    try { await autoCloseSession(req.params.id, session_id, requesterId, responderId, channel_preference); }
    catch (e) { logger.error('Auto-close error:', e); }
  }, SESSION_DURATION_MS);

  sessionTimers.set(session_id, { warning: warnTimer, close: autoCloseTimer });

  // Notify peer that session was extended
  if (responderId) {
    await query(
      `INSERT INTO notifications (user_id, type, payload, channel) VALUES ($1, 'account_notice', $2, 'in_app')`,
      [responderId, JSON.stringify({ session_id, extended: true, message: 'Session extended for 30 more minutes.' })]
    );
  }

  return res.status(200).json({ extended: true, new_end_time: new Date(Date.now() + SESSION_DURATION_MS) });
});

// ─── GET /peer/leaderboard ────────────────────────────────────────────────────
router.get('/leaderboard', auth, async (req, res) => {
  const { rows } = await query(
    `SELECT u.alias, COUNT(pr.id) AS sessions_completed
     FROM peer_requests pr
     JOIN users u ON u.id = pr.accepted_by
     WHERE pr.status = 'closed' AND pr.accepted_by IS NOT NULL
     GROUP BY u.alias
     ORDER BY sessions_completed DESC
     LIMIT 10`
  );
  return res.status(200).json({ leaderboard: rows });
});

// ─── GET /peer/topics ────────────────────────────────────────────────────────
router.get('/topics', auth, async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.slug, t.label, p.name AS required_permission_name
     FROM topics t
     LEFT JOIN permissions p ON p.id = t.required_permission_id
     WHERE t.is_active = true
     ORDER BY t.label`,
    []
  );
  return res.json({ topics: rows });
});

// ─── PATCH /peer/request/:id/decline ─────────────────────────────────────────
// Called when a peer dismisses the confidence-to-accept overlay. Non-fatal analytics only.
router.patch('/request/:id/decline', auth, async (req, res) => {
  await query(
    `UPDATE peer_requests SET decline_count = decline_count + 1 WHERE id = $1 AND status = 'open'`,
    [req.params.id]
  ).catch(() => {});
  return res.json({ ok: true });
});

// ─── POST /peer/session/:id/reflection ───────────────────────────────────────
router.post('/session/:id/reflection', auth, async (req, res) => {
  const sessionId = req.params.id;
  const {
    topic_stayed_in_category,
    unexpected_topic_arose,
    felt_prepared,
    additional_training_wanted,
  } = req.body;

  const { rows: sessionRows } = await query(
    `SELECT pr.accepted_by FROM peer_requests pr WHERE pr.session_id = $1`,
    [sessionId]
  );
  if (!sessionRows.length) {
    return res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
  }
  if (sessionRows[0].accepted_by !== req.user.id) {
    return res.status(403).json({ error: 'Only the peer for this session can submit a reflection', code: 'FORBIDDEN' });
  }

  const { rows } = await query(
    `INSERT INTO session_reflections
       (session_id, peer_user_id,
        topic_stayed_in_category, unexpected_topic_arose,
        felt_prepared, additional_training_wanted)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (session_id) DO NOTHING
     RETURNING id`,
    [sessionId, req.user.id,
     topic_stayed_in_category ?? null, unexpected_topic_arose ?? null,
     felt_prepared ?? null, additional_training_wanted ?? null]
  );
  if (!rows.length) {
    return res.status(409).json({ error: 'Reflection already submitted for this session', code: 'ALREADY_SUBMITTED' });
  }
  return res.status(201).json({ reflection_id: rows[0].id });
});

// ─── POST /peer/session/:id/requester-feedback ───────────────────────────────
router.post('/session/:id/requester-feedback', auth, async (req, res) => {
  const sessionId = req.params.id;
  const { rating, comment } = req.body;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be an integer 1–5', code: 'INVALID_RATING' });
  }

  const { rows: reqRows } = await query(
    `SELECT pr.user_id FROM peer_requests pr WHERE pr.session_id = $1`,
    [sessionId]
  );
  if (!reqRows.length) {
    return res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
  }
  if (reqRows[0].user_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the session requester can submit feedback', code: 'FORBIDDEN' });
  }

  const { rows } = await query(
    `INSERT INTO feedback (type, rating, comment, session_id)
     SELECT 'peer_session', $1, $2, $3
     WHERE NOT EXISTS (
       SELECT 1 FROM feedback WHERE session_id = $3 AND type = 'peer_session'
     )
     RETURNING id`,
    [rating, comment?.trim() || null, sessionId]
  );
  if (!rows.length) {
    return res.status(409).json({ error: 'Feedback already submitted for this session', code: 'ALREADY_SUBMITTED' });
  }
  return res.status(201).json({ feedback_id: rows[0].id });
});

// ─── POST /peer/availability ─────────────────────────────────────────────────
// Opt in to FCM push broadcasts. mode='all_day' sets until midnight (Nairobi),
// mode='hours' sets a timed window (default 2h, max 8h).
router.post('/availability', auth, async (req, res) => {
  let until;
  if (req.body.mode === 'all_day') {
    // End of today in Africa/Nairobi (UTC+3): 23:59:59 EAT = 20:59:59 UTC
    const nairobiNow = new Date(Date.now() + 3 * 3600 * 1000);
    nairobiNow.setUTCHours(20, 59, 59, 999);
    until = nairobiNow;
  } else {
    const hours = Math.min(8, Math.max(0.5, parseFloat(req.body.hours) || 2));
    until = new Date(Date.now() + hours * 3600 * 1000);
  }
  await query(
    'UPDATE users SET peer_available_until = $1, updated_at = NOW() WHERE id = $2',
    [until.toISOString(), req.user.id]
  );
  return res.status(200).json({ available_until: until });
});

// ─── DELETE /peer/availability ────────────────────────────────────────────────
// Cancel the current availability window early.
router.delete('/availability', auth, async (req, res) => {
  await query(
    'UPDATE users SET peer_available_until = NULL, updated_at = NOW() WHERE id = $1',
    [req.user.id]
  );
  return res.status(200).json({ ok: true });
});

// ─── GET /peer/availability ───────────────────────────────────────────────────
// Returns current availability state for the authenticated user.
router.get('/availability', auth, async (req, res) => {
  const { rows } = await query(
    'SELECT peer_available_until, notif_peer_night FROM users WHERE id = $1',
    [req.user.id]
  );
  const until = rows[0]?.peer_available_until;
  const isActive = until && new Date(until) > new Date();
  return res.status(200).json({
    available: !!isActive,
    available_until: isActive ? until : null,
    night_alerts: !!rows[0]?.notif_peer_night,
  });
});

// ─── Ephemeral transcript store ───────────────────────────────────────────────
// Holds both peers' entries for 1 hour. Never persisted unless a report is filed.
const transcriptStore = new Map();
const TRANSCRIPT_TTL_MS = 60 * 60 * 1000;

function storeTranscriptHalf(sessionId, userId, entries) {
  if (!sessionId || !Array.isArray(entries) || !entries.length) return;
  if (!transcriptStore.has(sessionId)) {
    transcriptStore.set(sessionId, { halves: new Map(), timer: null });
  }
  const record = transcriptStore.get(sessionId);
  record.halves.set(String(userId), entries);
  clearTimeout(record.timer);
  record.timer = setTimeout(() => transcriptStore.delete(sessionId), TRANSCRIPT_TTL_MS);
}

async function tryMerge(sessionId) {
  const record = transcriptStore.get(sessionId);
  if (!record || record.halves.size < 2) return;
  try {
    const { rows: reports } = await query(
      `SELECT pr.id FROM peer_reports pr
       WHERE pr.session_id = $1 AND pr.status = 'open'
       ORDER BY pr.created_at DESC LIMIT 1`,
      [sessionId]
    );
    if (!reports.length) return;

    const userIds = [...record.halves.keys()];
    const { rows: users } = await query(
      `SELECT id, alias FROM users WHERE id = ANY($1)`,
      [userIds]
    );
    const aliasMap = Object.fromEntries(users.map((u) => [u.id, u.alias]));

    const merged = [];
    for (const [userId, entries] of record.halves) {
      for (const e of entries) {
        merged.push({ ts: e.ts, speaker: aliasMap[userId] || 'Unknown', text: e.text });
      }
    }
    merged.sort((a, b) => a.ts - b.ts);

    await query(
      `UPDATE peer_reports SET transcript = $1 WHERE id = $2`,
      [JSON.stringify(merged), reports[0].id]
    );
    clearTimeout(record.timer);
    transcriptStore.delete(sessionId);
  } catch (e) {
    logger.error('Transcript merge error:', e.message);
  }
}

// ─── POST /peer/session/:id/transcript ───────────────────────────────────────
// Called by each peer when their session ends. Stored ephemerally;
// merged into peer_reports if a report exists for the session.
router.post('/session/:id/transcript', auth, async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries) || !entries.length) {
    return res.status(200).json({ stored: false });
  }
  storeTranscriptHalf(req.params.id, req.user.id, entries);
  tryMerge(req.params.id).catch(() => {});
  return res.status(200).json({ stored: true });
});

// ─── POST /peer/report ────────────────────────────────────────────────────────
router.post('/report', auth, async (req, res) => {
  const { session_id, peer_alias, channel, description, transcript } = req.body;
  if (!description?.trim()) {
    return res.status(400).json({ error: 'Description is required.', code: 'MISSING_DESCRIPTION' });
  }

  // Store reporter's transcript half; the other peer's half arrives when their session ends
  let parsedEntries = null;
  if (transcript) {
    try {
      parsedEntries = JSON.parse(transcript);
      if (Array.isArray(parsedEntries)) storeTranscriptHalf(session_id, req.user.id, parsedEntries);
    } catch { /* malformed transcript — skip */ }
  }

  // Look up peer alias from the session so the admin always sees who was reported
  let resolvedPeerAlias = peer_alias || null;
  if (session_id && !resolvedPeerAlias) {
    try {
      const { rows: sr } = await query(
        `SELECT CASE WHEN s.user_id = $2 THEN u_peer.alias ELSE u_req.alias END AS peer_alias
         FROM sessions s
         JOIN users u_req  ON u_req.id  = s.user_id
         JOIN peer_requests pr2 ON pr2.session_id = s.id
         JOIN users u_peer ON u_peer.id = pr2.accepted_by
         WHERE s.id = $1 LIMIT 1`,
        [session_id, req.user.id]
      );
      if (sr.length) resolvedPeerAlias = sr[0].peer_alias;
    } catch { /* non-fatal — alias stays null */ }
  }

  const { rows } = await query(
    `INSERT INTO peer_reports (reporter_id, session_id, peer_alias, channel, description)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.user.id, session_id || null, resolvedPeerAlias, channel || null, description.trim()]
  );

  // Attempt immediate merge if other half already arrived
  if (session_id) await tryMerge(session_id).catch(() => {});

  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     SELECT id, 'emergency_alert', $1, 'in_app'
     FROM users WHERE role = 'admin' AND is_active = true`,
    [JSON.stringify({ source: 'peer_report', report_id: rows[0].id, channel: channel || null })]
  ).catch((e) => logger.error('Peer report admin notify error:', e.message));
  notifyAllAdmins(query, '🚩 New Peer Report', 'A session report has been filed and needs review.', { type: 'report', report_id: String(rows[0].id), _urgent: 'true' }).catch(() => {});

  return res.status(201).json({ report_id: rows[0].id });
});

module.exports = router;
// Exported for use by the routing cron job
module.exports.broadenToGeneralTier = broadenToGeneralTier;
module.exports.noMorePeers = noMorePeers;
