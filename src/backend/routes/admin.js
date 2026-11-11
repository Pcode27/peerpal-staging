const express = require('express');
const logger = require('../utils/logger');

const { query, transaction } = require('../db');
const adminAuth = require('../middleware/adminAuth');
const cache = require('../services/cache');
const { refundCredit } = require('../utils/creditDeductor');
const { getConfig, invalidateConfig } = require('../utils/config');
const { getSignedUrl } = require('../services/storage');

const router = express.Router();

// All routes in this file require admin role verified from DB.
router.use(adminAuth);

async function auditLog(adminId, action, targetType, targetId, targetAlias, beforeValue, afterValue) {
  await query(
    `INSERT INTO admin_audit_log
       (admin_id, action, target_type, target_id, target_alias, before_value, after_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [adminId, action, targetType || null, targetId != null ? String(targetId) : null,
     targetAlias || null, beforeValue || null, afterValue || null]
  ).catch((e) => logger.error(e.message));
}

// ─── GET /admin/reports ───────────────────────────────────────────────────────
router.get('/reports', async (req, res) => {
  const [groupResult, peerResult] = await Promise.all([
    query(
      `SELECT gr.id, 'group' AS report_type, gr.reason AS reason, gr.details, gr.status, gr.created_at,
              g.name AS group_name, NULL AS channel, NULL AS description,
              ru.alias AS reported_alias,
              rb.alias AS reporter_alias,
              gm.content AS message_preview
       FROM group_reports gr
       JOIN groups g ON g.id = gr.group_id
       JOIN users ru ON ru.id = gr.reported_user_id
       JOIN users rb ON rb.id = gr.reported_by
       LEFT JOIN group_messages gm ON gm.id = gr.message_id
       WHERE gr.status = 'pending'
       ORDER BY gr.created_at ASC`
    ),
    query(
      `SELECT pr.id, 'peer' AS report_type, NULL AS reason, NULL AS details, pr.status, pr.created_at,
              NULL AS group_name, pr.channel, pr.description,
              pr.peer_alias AS reported_alias,
              u.alias AS reporter_alias,
              NULL AS message_preview
       FROM peer_reports pr
       JOIN users u ON u.id = pr.reporter_id
       WHERE pr.status = 'open'
       ORDER BY pr.created_at ASC`
    ),
  ]);
  const reports = [...groupResult.rows, ...peerResult.rows]
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return res.status(200).json({ reports });
});

// ─── PATCH /admin/emergency/:id/acknowledge ───────────────────────────────────
router.patch('/emergency/:id/acknowledge', async (req, res) => {
  const { rows } = await query(
    `UPDATE emergency_logs
        SET status = 'acknowledged', acknowledged_at = NOW(), handled_by = $1
      WHERE id = $2 AND status = 'open'
      RETURNING acknowledged_at`,
    [req.user.id, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Log not found or already acknowledged', code: 'NOT_FOUND' });
  await auditLog(req.user.id, 'emergency.acknowledge', 'emergency', req.params.id, null, 'open', 'acknowledged');
  return res.status(200).json({ acknowledged_at: rows[0].acknowledged_at });
});

// ─── PATCH /admin/emergency/:id/resolve ──────────────────────────────────────
router.patch('/emergency/:id/resolve', async (req, res) => {
  const { rows } = await query(
    `UPDATE emergency_logs
        SET status = 'resolved', resolved_at = NOW()
      WHERE id = $1 AND status IN ('open', 'acknowledged')
      RETURNING resolved_at`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Log not found or already resolved', code: 'NOT_FOUND' });
  await auditLog(req.user.id, 'emergency.resolve', 'emergency', req.params.id, null, null, 'resolved');
  return res.status(200).json({ resolved_at: rows[0].resolved_at });
});

// ─── PATCH /admin/reports/:id/action ─────────────────────────────────────────
router.patch('/reports/:id/action', async (req, res) => {
  const { action, admin_notes } = req.body;
  if (!['warn', 'ban', 'dismiss'].includes(action)) {
    return res.status(400).json({ error: 'action must be one of: warn, ban, dismiss', code: 'INVALID_ACTION' });
  }

  const { rows: reportRows } = await query(
    `SELECT gr.id, gr.group_id, gr.reported_user_id, gr.status, u.alias AS reported_alias
     FROM group_reports gr
     JOIN users u ON u.id = gr.reported_user_id
     WHERE gr.id = $1`,
    [req.params.id]
  );
  if (!reportRows.length) return res.status(404).json({ error: 'Report not found', code: 'NOT_FOUND' });
  if (reportRows[0].status !== 'pending') {
    return res.status(409).json({ error: 'Report already actioned', code: 'ALREADY_REVIEWED' });
  }

  const { group_id, reported_user_id } = reportRows[0];

  if (action === 'warn') {
    await query(
      `UPDATE group_reports
          SET status = 'actioned', admin_action = 'warn', admin_notes = $1, reviewed_at = NOW()
        WHERE id = $2`,
      [admin_notes || null, req.params.id]
    );
    await query(
      `INSERT INTO notifications (user_id, type, payload, channel)
       VALUES ($1, 'group_warning', $2, 'in_app')`,
      [reported_user_id, JSON.stringify({ group_id, admin_notes })]
    );
  } else if (action === 'ban') {
    const banReason = admin_notes || 'Community guidelines violation';
    // Write ban record
    await query(
      `INSERT INTO group_bans (group_id, user_id, reason, banned_by)
       VALUES ($1, $2, $3, $4)`,
      [group_id, reported_user_id, banReason, req.user.id]
    );
    // Revoke membership
    await query(
      `UPDATE group_memberships SET status = 'banned'
       WHERE group_id = $1 AND user_id = $2`,
      [group_id, reported_user_id]
    );
    // Action the report
    await query(
      `UPDATE group_reports
          SET status = 'actioned', admin_action = 'ban', admin_notes = $1, reviewed_at = NOW()
        WHERE id = $2`,
      [admin_notes || null, req.params.id]
    );
    await query(
      `INSERT INTO notifications (user_id, type, payload, channel)
       VALUES ($1, 'group_warning', $2, 'in_app')`,
      [reported_user_id, JSON.stringify({ group_id, admin_notes: banReason, action: 'ban' })]
    );
  } else {
    // dismiss
    await query(
      `UPDATE group_reports
          SET status = 'dismissed', admin_action = 'dismiss', admin_notes = $1, reviewed_at = NOW()
        WHERE id = $2`,
      [admin_notes || null, req.params.id]
    );
  }

  await auditLog(req.user.id, `report.${action}`, 'report', req.params.id, reportRows[0].reported_alias, 'pending', action);
  return res.status(200).json({ action_taken: action });
});

// ─── GET /admin/emergency-queue ───────────────────────────────────────────────
router.get('/emergency-queue', async (req, res) => {
  const { rows } = await query(
    `SELECT el.id, el.status, el.trigger_type, el.triggered_at, el.acknowledged_at,
            u.alias
     FROM emergency_logs el
     JOIN users u ON u.id = el.user_id
     WHERE el.status IN ('open', 'acknowledged')
     ORDER BY el.triggered_at ASC`
  );
  return res.status(200).json({ queue: rows });
});

// ─── GET /admin/escalations ───────────────────────────────────────────────────
router.get('/escalations', async (req, res) => {
  const { rows } = await query(
    `SELECT pr.id, pr.channel_preference, pr.escalated_at, pr.created_at,
            u.alias
     FROM peer_requests pr
     JOIN users u ON u.id = pr.user_id
     WHERE pr.status = 'escalated'
     ORDER BY pr.escalated_at ASC`
  );
  return res.status(200).json({ escalations: rows });
});

// ─── PATCH /admin/escalations/:id/resolve ─────────────────────────────────────
router.patch('/escalations/:id/resolve', async (req, res) => {
  const { rowCount } = await query(
    `UPDATE peer_requests SET status = 'closed', updated_at = NOW()
     WHERE id = $1 AND status = 'escalated'`,
    [req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Escalation not found or already resolved', code: 'NOT_FOUND' });
  await auditLog(req.user.id, 'escalation.resolve', 'escalation', req.params.id, null, 'escalated', 'closed');
  return res.status(200).json({ resolved: true });
});

// ─── GET /admin/risk-flags ────────────────────────────────────────────────────
router.get('/risk-flags', async (req, res) => {
  const { rows } = await query(
    `SELECT alias, risk_level, updated_at
     FROM users WHERE risk_level IN ('high', 'critical') AND is_active = true
     ORDER BY risk_level DESC, updated_at DESC`
  );
  return res.status(200).json({ flagged_users: rows });
});

// ─── PATCH /admin/risk-flags/:alias/dismiss ───────────────────────────────────
// Manually clears a risk flag back to 'low'. Nightly classifier will re-evaluate.
router.patch('/risk-flags/:alias/dismiss', async (req, res) => {
  const { rows: riskRows } = await query(
    `SELECT risk_level FROM users WHERE alias = $1 AND risk_level IN ('high', 'critical')`,
    [req.params.alias]
  );
  if (!riskRows.length) return res.status(404).json({ error: 'Risk flag not found or already cleared', code: 'NOT_FOUND' });
  const beforeRiskLevel = riskRows[0].risk_level;
  await query(
    `UPDATE users SET risk_level = 'low', updated_at = NOW() WHERE alias = $1`,
    [req.params.alias]
  );
  await auditLog(req.user.id, 'risk_flag.dismiss', 'user', null, req.params.alias, beforeRiskLevel, 'low');
  return res.status(200).json({ dismissed: true });
});

// ─── POST /admin/users/:alias/message ────────────────────────────────────────
router.post('/users/:alias/message', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required', code: 'MISSING_MESSAGE' });
  }

  const { rows } = await query('SELECT id FROM users WHERE alias = $1', [req.params.alias]);
  if (!rows.length) return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });

  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     VALUES ($1, 'emergency_alert', $2, 'in_app')`,
    [rows[0].id, JSON.stringify({ admin_message: message.trim() })]
  );
  return res.status(200).json({ sent: true });
});

// ─── GET /admin/resources ─────────────────────────────────────────────────────
router.get('/resources', async (req, res) => {
  const { rows } = await query(
    `SELECT id, title, category, content_type, author_name, author_bio, source_url,
            estimated_read_minutes, tags, status, published_at, created_at, updated_at
     FROM psychoeducation_articles
     ORDER BY updated_at DESC`
  );
  return res.status(200).json({ articles: rows });
});

// ─── POST /admin/resources ────────────────────────────────────────────────────
router.post('/resources', async (req, res) => {
  const { title, category, content, estimated_read_minutes, tags,
          content_type, author_name, author_bio, source_url } = req.body;
  if (!title || !category || !content || !estimated_read_minutes) {
    return res.status(400).json({ error: 'title, category, content, and estimated_read_minutes are required', code: 'MISSING_FIELDS' });
  }
  const type = content_type === 'story' ? 'story' : 'article';

  const { rows } = await query(
    `INSERT INTO psychoeducation_articles
       (title, category, content, estimated_read_minutes, tags, content_type, author_name, author_bio, source_url, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [title, category, content, estimated_read_minutes, tags || null,
     type, author_name || null, author_bio || null, source_url || null, req.user.id]
  );
  return res.status(201).json({ article_id: rows[0].id });
});

// ─── PATCH /admin/resources/:id ───────────────────────────────────────────────
router.patch('/resources/:id', async (req, res) => {
  const { title, category, content, estimated_read_minutes, tags,
          content_type, author_name, author_bio, source_url } = req.body;
  const setClauses = ['updated_at = NOW()'];
  const params = [];
  let idx = 1;

  if (title                  !== undefined) { setClauses.push(`title = $${idx++}`);                  params.push(title); }
  if (category               !== undefined) { setClauses.push(`category = $${idx++}`);               params.push(category); }
  if (content                !== undefined) { setClauses.push(`content = $${idx++}`);                params.push(content); }
  if (estimated_read_minutes !== undefined) { setClauses.push(`estimated_read_minutes = $${idx++}`); params.push(estimated_read_minutes); }
  if (tags                   !== undefined) { setClauses.push(`tags = $${idx++}`);                   params.push(tags); }
  if (content_type           !== undefined) { setClauses.push(`content_type = $${idx++}`);           params.push(content_type === 'story' ? 'story' : 'article'); }
  if (author_name            !== undefined) { setClauses.push(`author_name = $${idx++}`);            params.push(author_name || null); }
  if (author_bio             !== undefined) { setClauses.push(`author_bio = $${idx++}`);             params.push(author_bio || null); }
  if (source_url             !== undefined) { setClauses.push(`source_url = $${idx++}`);             params.push(source_url || null); }

  if (params.length === 0) {
    return res.status(400).json({ error: 'No fields to update', code: 'MISSING_FIELDS' });
  }

  params.push(req.params.id);
  const { rowCount } = await query(
    `UPDATE psychoeducation_articles SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    params
  );
  if (!rowCount) return res.status(404).json({ error: 'Article not found', code: 'NOT_FOUND' });
  await cache.delPattern('resources:');
  return res.status(200).json({ updated: true });
});

// ─── PATCH /admin/resources/:id/publish ──────────────────────────────────────
router.patch('/resources/:id/publish', async (req, res) => {
  const { rowCount } = await query(
    `UPDATE psychoeducation_articles
        SET status = 'published', published_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Article not found', code: 'NOT_FOUND' });
  await cache.delPattern('resources:');
  return res.status(200).json({ published: true });
});

// ─── PATCH /admin/resources/:id/archive ──────────────────────────────────────
router.patch('/resources/:id/archive', async (req, res) => {
  const { rowCount } = await query(
    `UPDATE psychoeducation_articles SET status = 'archived', updated_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Article not found', code: 'NOT_FOUND' });
  await cache.delPattern('resources:');
  return res.status(200).json({ archived: true });
});

// ─── GET /admin/feedback ─────────────────────────────────────────────────────
router.get('/feedback', async (req, res) => {
  const { rows: avgRows } = await query(
    `SELECT type, ROUND(AVG(rating)::numeric, 2) AS avg_rating, COUNT(*) AS count
     FROM feedback WHERE rating IS NOT NULL
     GROUP BY type ORDER BY type`
  );
  const { rows: comments } = await query(
    `SELECT type, rating, comment, created_at
     FROM feedback WHERE comment IS NOT NULL
     ORDER BY created_at DESC LIMIT 20`
  );
  return res.status(200).json({ averages: avgRows, recent_comments: comments });
});

// ─── GET /admin/stats ─────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const [dau, checkins, peerSessions, aiSessions, creditsPurchased] = await Promise.all([
    query(`SELECT COUNT(DISTINCT user_id) AS count FROM moods WHERE created_at::date = $1`, [today]),
    query(`SELECT COUNT(*) AS count FROM moods WHERE created_at::date = $1`, [today]),
    query(`SELECT COUNT(*) AS count FROM sessions WHERE type = 'peer' AND started_at::date = $1`, [today]),
    query(`SELECT COUNT(*) AS count FROM sessions WHERE type = 'ai' AND started_at::date = $1`, [today]),
    query(`SELECT COALESCE(SUM(amount_credits), 0) AS total FROM credit_transactions WHERE type = 'purchase' AND status = 'confirmed' AND created_at::date = $1`, [today]),
  ]);

  return res.status(200).json({
    date: today,
    daily_active_users: parseInt(dau.rows[0].count),
    checkins_today: parseInt(checkins.rows[0].count),
    peer_sessions_today: parseInt(peerSessions.rows[0].count),
    ai_sessions_today: parseInt(aiSessions.rows[0].count),
    credits_purchased_today: parseInt(creditsPurchased.rows[0].total),
  });
});

// ─── GET /admin/stats/growth ──────────────────────────────────────────────────
// Growth and sustainability signals: user totals, MAU, conversion, peer fulfillment, AI cost.
router.get('/stats/growth', async (req, res) => {
  try {
    const AI_COST_PER_SESSION_KSH = await getConfig('ai_cost_per_session_ksh', 2.60);

    const [totalRes, mauRes, paidRes, peerRes, aiRes] = await Promise.all([
      // Total registered members
      query(`SELECT COUNT(*) AS total FROM users WHERE role = 'member'`),

      // Monthly Active Users — any session or check-in in last 30 days
      query(`
        SELECT COUNT(DISTINCT user_id) AS mau FROM (
          SELECT user_id FROM sessions  WHERE started_at  > NOW() - INTERVAL '30 days'
          UNION
          SELECT user_id FROM moods     WHERE created_at  > NOW() - INTERVAL '30 days'
        ) a
      `),

      // Users with at least one confirmed purchase
      query(`SELECT COUNT(DISTINCT user_id) AS paid FROM credit_transactions WHERE type = 'purchase' AND status = 'confirmed'`),

      // Peer fulfillment: locked/active = matched, escalated = not matched (last 30 days, excluding still-open)
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('locked','active','closed') AND escalated_at IS NULL)::int AS fulfilled,
          COUNT(*) FILTER (WHERE status = 'escalated')::int AS escalated
        FROM peer_requests
        WHERE created_at > NOW() - INTERVAL '30 days' AND status != 'open'
      `),

      // AI sessions in last 30 days (for cost estimate)
      query(`SELECT COUNT(*) AS count FROM sessions WHERE type = 'ai' AND started_at > NOW() - INTERVAL '30 days'`),
    ]);

    const totalUsers  = parseInt(totalRes.rows[0].total);
    const mau         = parseInt(mauRes.rows[0].mau);
    const paidUsers   = parseInt(paidRes.rows[0].paid);
    const fulfilled   = peerRes.rows[0].fulfilled;
    const escalated   = peerRes.rows[0].escalated;
    const aiSessions  = parseInt(aiRes.rows[0].count);

    const conversionRate   = totalUsers > 0 ? parseFloat(((paidUsers / totalUsers) * 100).toFixed(1)) : 0;
    const totalPeerHandled = fulfilled + escalated;
    const fulfillmentRate  = totalPeerHandled > 0 ? parseFloat(((fulfilled / totalPeerHandled) * 100).toFixed(1)) : null;
    const aiCostKsh        = parseFloat((aiSessions * AI_COST_PER_SESSION_KSH).toFixed(0));
    const aiCostPerMau     = mau > 0 ? parseFloat((aiCostKsh / mau).toFixed(2)) : 0;

    return res.status(200).json({
      total_users: totalUsers,
      mau,
      paid_users: paidUsers,
      conversion_rate: conversionRate,
      peer_fulfillment_rate: fulfillmentRate,
      ai_sessions_30d: aiSessions,
      ai_cost_30d_ksh: aiCostKsh,
      ai_cost_per_mau_ksh: aiCostPerMau,
    });
  } catch (err) {
    logger.error('stats/growth error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch growth stats', code: 'QUERY_ERROR' });
  }
});

// ─── GET /admin/stats/daily ───────────────────────────────────────────────────
// Uses integer series offset (date - integer = date in PG) to avoid interval cast ambiguity
router.get('/stats/daily', async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));
  try {
    const { rows } = await query(
      `WITH date_series AS (
         SELECT (CURRENT_DATE - n)::date AS d
         FROM generate_series(0, $1::int - 1) AS gs(n)
       )
       SELECT
         ds.d::text AS date,
         COUNT(DISTINCT m.user_id)::int    AS dau,
         COUNT(DISTINCT s_ai.id)::int      AS ai_sessions,
         COUNT(DISTINCT s_peer.id)::int    AS peer_sessions,
         COUNT(DISTINCT el.id)::int        AS emergencies,
         COUNT(DISTINCT u.id)::int         AS new_users
       FROM date_series ds
       LEFT JOIN moods          m      ON m.created_at::date      = ds.d
       LEFT JOIN sessions       s_ai   ON s_ai.started_at::date   = ds.d AND s_ai.type  = 'ai'
       LEFT JOIN sessions       s_peer ON s_peer.started_at::date = ds.d AND s_peer.type = 'peer'
       LEFT JOIN emergency_logs el     ON el.triggered_at::date   = ds.d
       LEFT JOIN users          u      ON u.created_at::date      = ds.d AND u.role      = 'member'
       GROUP BY ds.d
       ORDER BY ds.d ASC`,
      [days]
    );
    return res.status(200).json({ days, series: rows });
  } catch (err) {
    logger.error('stats/daily error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch daily stats', code: 'QUERY_ERROR' });
  }
});

// ─── GET /admin/users/patterns ────────────────────────────────────────────────
router.get('/users/patterns', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         u.alias,
         u.last_checkin_at,
         (SELECT COUNT(*) FROM emergency_logs el WHERE el.user_id = u.id)::int AS emergency_count,
         (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.type = 'peer' AND s.started_at > NOW() - INTERVAL '7 days')::int AS peer_sessions_7d
       FROM users u
       WHERE u.role = 'member' AND u.is_active = true
         AND (
           (SELECT COUNT(*) FROM emergency_logs el WHERE el.user_id = u.id) >= 3
           OR
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.type = 'peer' AND s.started_at > NOW() - INTERVAL '7 days') >= 5
         )
       ORDER BY emergency_count DESC, peer_sessions_7d DESC`
    );
    return res.status(200).json({ patterns: rows });
  } catch (err) {
    logger.error('users/patterns error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch patterns', code: 'QUERY_ERROR' });
  }
});

// ─── GET /admin/therapist-categories ─────────────────────────────────────────
router.get('/therapist-categories', async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, description, icon_name, condition_tags, is_active, sort_order, created_at
     FROM therapist_categories
     ORDER BY sort_order ASC, name ASC`
  );
  return res.status(200).json({ categories: rows });
});

// ─── POST /admin/therapist-categories ────────────────────────────────────────
router.post('/therapist-categories', async (req, res) => {
  const { name, description, icon_name, condition_tags, sort_order } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required', code: 'MISSING_FIELDS' });
  }
  const { rows } = await query(
    `INSERT INTO therapist_categories (name, description, icon_name, condition_tags, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [name.trim(), description || null, icon_name || null, condition_tags || [], sort_order || 0]
  );
  await auditLog(req.user.id, 'therapist_category.create', 'therapist_category', rows[0].id, null, null, name.trim());
  return res.status(201).json({ category_id: rows[0].id });
});

// ─── PATCH /admin/therapist-categories/:id ───────────────────────────────────
router.patch('/therapist-categories/:id', async (req, res) => {
  const { name, description, icon_name, condition_tags, is_active, sort_order } = req.body;
  const setClauses = [];
  const params = [];
  let idx = 1;

  if (name           !== undefined) { setClauses.push(`name = $${idx++}`);           params.push(name); }
  if (description    !== undefined) { setClauses.push(`description = $${idx++}`);    params.push(description); }
  if (icon_name      !== undefined) { setClauses.push(`icon_name = $${idx++}`);      params.push(icon_name); }
  if (condition_tags !== undefined) { setClauses.push(`condition_tags = $${idx++}`); params.push(condition_tags); }
  if (is_active      !== undefined) { setClauses.push(`is_active = $${idx++}`);      params.push(is_active); }
  if (sort_order     !== undefined) { setClauses.push(`sort_order = $${idx++}`);     params.push(sort_order); }

  if (!setClauses.length) return res.status(400).json({ error: 'No fields to update', code: 'MISSING_FIELDS' });

  params.push(req.params.id);
  const { rowCount } = await query(
    `UPDATE therapist_categories SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    params
  );
  if (!rowCount) return res.status(404).json({ error: 'Category not found', code: 'NOT_FOUND' });
  await auditLog(req.user.id, 'therapist_category.edit', 'therapist_category', req.params.id, null, null, null);
  return res.status(200).json({ updated: true });
});

// ─── GET /admin/therapists ────────────────────────────────────────────────────
router.get('/therapists', async (req, res) => {
  const { rows } = await query(
    `SELECT tp.id, tp.user_id, tp.display_name, tp.full_name, tp.photo_url, tp.credentials,
            tp.years_experience, tp.languages, tp.session_formats, tp.category_ids,
            tp.location, tp.statement, tp.plain_language_intro, tp.cultural_competencies,
            tp.approach_plain, tp.availability_status, tp.is_active,
            tp.is_verified, tp.suspended,
            tp.gender, tp.age, tp.rate_per_session_kes,
            tp.kcpa_level, tp.kcpa_verified_at, tp.registration_number, tp.kmpdc_number,
            tp.indemnity_verified, tp.good_conduct_verified, tp.good_conduct_expires_at,
            tp.teletherapy_agreement_signed_at, tp.credentials_verified_at, tp.credentials_verified_by,
            tp.mpesa_number, tp.average_rating, tp.total_ratings_count, tp.total_sessions,
            COALESCE(tp.created_at, u.created_at) AS created_at,
            u.email, u.alias, u.id AS user_id_fallback,
            CASE WHEN tp.id IS NULL THEN true ELSE false END AS profile_missing
     FROM users u
     LEFT JOIN therapist_profiles tp ON tp.user_id = u.id
     WHERE u.role = 'therapist' OR tp.user_id IS NOT NULL
     ORDER BY COALESCE(tp.created_at, u.created_at) DESC`
  );
  return res.status(200).json({ therapists: rows });
});

// ─── POST /admin/therapists ───────────────────────────────────────────────────
// Checks therapist_profiles for duplicates (not users table) — supports dual-role.
// If email already has a users row (member), adds profile only. Otherwise creates user + profile.
// No password set by admin — invite email with set-password link sent instead.
router.post('/therapists', async (req, res) => {
  const {
    email,
    display_name, full_name, credentials, years_experience,
    languages, session_formats, location,
    statement, plain_language_intro, cultural_competencies, approach_plain,
    photo_url, availability_status, gender, age, rate_per_session_kes,
    mpesa_number, category_ids,
  } = req.body;

  if (!email || !display_name || !full_name || !credentials) {
    return res.status(400).json({
      error: 'email, display_name, full_name, and credentials are required',
      code: 'MISSING_FIELDS',
    });
  }

  const crypto = require('crypto');
  const bcrypt = require('bcrypt');
  const { generateAlias } = require('../utils/aliasGenerator');
  const { sendTherapistInvite } = require('../services/emailService');

  const emailLower = email.toLowerCase().trim();
  const inviteToken = crypto.randomBytes(32).toString('hex');
  const inviteHash  = crypto.createHash('sha256').update(inviteToken).digest('hex');

  // Shared profile INSERT values — same whether or not a users row already exists.
  const profileParams = (uId) => [
    uId, display_name.trim(), full_name.trim(), credentials.trim(),
    years_experience || 0, languages || [], session_formats || [],
    location || null, statement || null, plain_language_intro || null,
    cultural_competencies || [], approach_plain || null, photo_url || null,
    availability_status || 'available', gender || null, age || null,
    rate_per_session_kes || 0, mpesa_number || null, category_ids || [],
  ];

  try {
    // Duplicate check is against therapist_profiles, not users.
    const { rows: existingProfile } = await query(
      `SELECT tp.id FROM therapist_profiles tp
       JOIN users u ON u.id = tp.user_id
       WHERE u.email = $1`,
      [emailLower]
    );
    if (existingProfile.length) {
      return res.status(409).json({
        error: 'A therapist profile already exists for this email.',
        code: 'DUPLICATE_THERAPIST',
      });
    }

    const { rows: existingUser } = await query(
      'SELECT id, alias FROM users WHERE email = $1',
      [emailLower]
    );

    let userId, profileId, alias;

    if (existingUser.length) {
      // User already exists (member or otherwise) — add profile only, keep their role.
      userId = existingUser[0].id;
      alias  = existingUser[0].alias;
      ({ profileId } = await transaction(async (tx) => {
        await tx.query(
          `UPDATE users SET reset_token_hash = $1, reset_token_expires = NOW() + INTERVAL '72 hours'
           WHERE id = $2`,
          [inviteHash, userId]
        );
        const { rows } = await tx.query(
          `INSERT INTO therapist_profiles
             (user_id, display_name, full_name, credentials, years_experience,
              languages, session_formats, location, statement,
              plain_language_intro, cultural_competencies, approach_plain,
              photo_url, availability_status, gender, age, rate_per_session_kes,
              mpesa_number, category_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           RETURNING id`,
          profileParams(userId)
        );
        return { profileId: rows[0].id };
      }));
    } else {
      // Brand-new user — create users row + profile in one transaction.
      alias = await generateAlias();
      const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      ({ userId, profileId } = await transaction(async (tx) => {
        const { rows: uRows } = await tx.query(
          `INSERT INTO users (email, password_hash, alias, role, consent_version, email_verified)
           VALUES ($1, $2, $3, 'therapist', '1.0', true)
           RETURNING id`,
          [emailLower, placeholderHash, alias]
        );
        const uId = uRows[0].id;
        await tx.query(
          `UPDATE users SET reset_token_hash = $1, reset_token_expires = NOW() + INTERVAL '72 hours'
           WHERE id = $2`,
          [inviteHash, uId]
        );
        const { rows } = await tx.query(
          `INSERT INTO therapist_profiles
             (user_id, display_name, full_name, credentials, years_experience,
              languages, session_formats, location, statement,
              plain_language_intro, cultural_competencies, approach_plain,
              photo_url, availability_status, gender, age, rate_per_session_kes,
              mpesa_number, category_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           RETURNING id`,
          profileParams(uId)
        );
        return { userId: uId, profileId: rows[0].id };
      }));
    }

    try {
      await sendTherapistInvite(emailLower, display_name.trim(), inviteToken);
    } catch (err) {
      logger.error('[therapist.invite] Email failed:', err.message);
    }
    await auditLog(req.user.id, 'therapist.create', 'therapist', userId, alias, null, emailLower);
    return res.status(201).json({ therapist_id: profileId, alias });
  } catch (err) {
    logger.error('[admin/therapists POST]', err.message);
    return res.status(500).json({ error: 'Failed to create therapist.', code: 'SERVER_ERROR' });
  }
});

// ─── PATCH /admin/therapists/:id ─────────────────────────────────────────────
router.patch('/therapists/:id', async (req, res) => {
  const {
    display_name, full_name, credentials, years_experience,
    languages, session_formats, location, category_ids,
    statement, plain_language_intro, cultural_competencies, approach_plain,
    photo_url, availability_status, is_active,
    gender, age, rate_per_session_kes, mpesa_number,
    kcpa_level, registration_number, kmpdc_number,
  } = req.body;

  const setClauses = ['updated_at = NOW()'];
  const params = [];
  let idx = 1;

  if (display_name           !== undefined) { setClauses.push(`display_name = $${idx++}`);           params.push(display_name); }
  if (full_name              !== undefined) { setClauses.push(`full_name = $${idx++}`);              params.push(full_name); }
  if (credentials            !== undefined) { setClauses.push(`credentials = $${idx++}`);            params.push(credentials); }
  if (years_experience       !== undefined) { setClauses.push(`years_experience = $${idx++}`);       params.push(years_experience); }
  if (languages              !== undefined) { setClauses.push(`languages = $${idx++}`);              params.push(languages); }
  if (session_formats        !== undefined) { setClauses.push(`session_formats = $${idx++}`);        params.push(session_formats); }
  if (location               !== undefined) { setClauses.push(`location = $${idx++}`);               params.push(location); }
  if (statement              !== undefined) { setClauses.push(`statement = $${idx++}`);              params.push(statement); }
  if (plain_language_intro   !== undefined) { setClauses.push(`plain_language_intro = $${idx++}`);   params.push(plain_language_intro); }
  if (cultural_competencies  !== undefined) { setClauses.push(`cultural_competencies = $${idx++}`);  params.push(cultural_competencies); }
  if (approach_plain         !== undefined) { setClauses.push(`approach_plain = $${idx++}`);         params.push(approach_plain); }
  if (photo_url              !== undefined) { setClauses.push(`photo_url = $${idx++}`);              params.push(photo_url); }
  if (availability_status    !== undefined) { setClauses.push(`availability_status = $${idx++}`);    params.push(availability_status); }
  if (is_active              !== undefined) { setClauses.push(`is_active = $${idx++}`);              params.push(is_active); }
  if (category_ids           !== undefined) { setClauses.push(`category_ids = $${idx++}`);           params.push(category_ids); }
  if (gender                 !== undefined) { setClauses.push(`gender = $${idx++}`);                 params.push(gender); }
  if (age                    !== undefined) { setClauses.push(`age = $${idx++}`);                    params.push(age); }
  if (rate_per_session_kes   !== undefined) { setClauses.push(`rate_per_session_kes = $${idx++}`);   params.push(rate_per_session_kes); }
  if (mpesa_number           !== undefined) { setClauses.push(`mpesa_number = $${idx++}`);           params.push(mpesa_number); }
  if (kcpa_level             !== undefined) { setClauses.push(`kcpa_level = $${idx++}`);             params.push(kcpa_level); }
  if (registration_number    !== undefined) { setClauses.push(`registration_number = $${idx++}`);    params.push(registration_number); }
  if (kmpdc_number           !== undefined) { setClauses.push(`kmpdc_number = $${idx++}`);           params.push(kmpdc_number); }

  if (params.length === 0) return res.status(400).json({ error: 'No fields to update', code: 'MISSING_FIELDS' });

  params.push(req.params.id);
  try {
    const { rowCount } = await query(
      `UPDATE therapist_profiles SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      params
    );
    if (!rowCount) return res.status(404).json({ error: 'Therapist not found', code: 'NOT_FOUND' });
    await auditLog(req.user.id, 'therapist.edit', 'therapist', req.params.id, null, null, null);
    return res.status(200).json({ updated: true });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: 'Failed to update therapist', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /admin/therapists/:id/availability ─────────────────────────────────
router.patch('/therapists/:id/availability', async (req, res) => {
  const { availability_status } = req.body;
  if (!['available', 'limited', 'unavailable'].includes(availability_status)) {
    return res.status(400).json({ error: 'availability_status must be: available, limited, or unavailable', code: 'INVALID_STATUS' });
  }
  const { rowCount } = await query(
    'UPDATE therapist_profiles SET availability_status = $1, updated_at = NOW() WHERE id = $2',
    [availability_status, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Therapist not found', code: 'NOT_FOUND' });
  return res.status(200).json({ updated: true });
});

// ─── PATCH /admin/therapists/:id/verify ──────────────────────────────────────
// Checklist save + optional force-verify override.
// Pass force_verify: true to grant verification immediately regardless of checklist.
// Pass force_verify: false to revoke verification.
router.patch('/therapists/:id/verify', async (req, res) => {
  const {
    kcpa_level, registration_number, kmpdc_number,
    indemnity_verified, good_conduct_verified, good_conduct_expires_at,
    teletherapy_agreement_signed, force_verify,
  } = req.body;

  // ── Force-verify / revoke path ─────────────────────────────────────────────
  if (force_verify !== undefined) {
    const isVerified = Boolean(force_verify);
    try {
      await query(
        `UPDATE therapist_profiles
         SET is_verified = $1, credentials_verified_by = $2, credentials_verified_at = $3, updated_at = NOW()
         WHERE id = $4`,
        [isVerified, req.user.id, isVerified ? new Date().toISOString() : null, req.params.id]
      );
      if (isVerified) {
        query(
          `SELECT u.email, tp.display_name FROM therapist_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.id = $1`,
          [req.params.id]
        ).then(({ rows }) => {
          if (rows[0]?.email) {
            const { sendTherapistVerified } = require('../services/emailService');
            sendTherapistVerified(rows[0].email, rows[0].display_name || 'there').catch(() => {});
          }
        }).catch(() => {});
      }
      await auditLog(req.user.id, 'therapist.verify', 'therapist', req.params.id, null, null, isVerified ? 'force_verified' : 'revoked');
      return res.status(200).json({ updated: true, is_verified: isVerified });
    } catch (err) {
      logger.error(err.message);
      return res.status(500).json({ error: err.message, code: 'QUERY_ERROR' });
    }
  }

  // ── Checklist save path ────────────────────────────────────────────────────
  const setClauses = ['updated_at = NOW()'];
  const params = [];
  let idx = 1;

  if (kcpa_level                  !== undefined) { setClauses.push(`kcpa_level = $${idx++}`);                  params.push(kcpa_level); }
  if (registration_number         !== undefined) { setClauses.push(`registration_number = $${idx++}`);         params.push(registration_number); }
  if (kmpdc_number                !== undefined) { setClauses.push(`kmpdc_number = $${idx++}`);                params.push(kmpdc_number); }
  if (indemnity_verified          !== undefined) { setClauses.push(`indemnity_verified = $${idx++}`);          params.push(Boolean(indemnity_verified)); }
  if (good_conduct_verified       !== undefined) { setClauses.push(`good_conduct_verified = $${idx++}`);       params.push(Boolean(good_conduct_verified)); }
  if (good_conduct_expires_at     !== undefined) { setClauses.push(`good_conduct_expires_at = $${idx++}`);     params.push(good_conduct_expires_at); }
  if (teletherapy_agreement_signed) {
    setClauses.push(`teletherapy_agreement_signed_at = $${idx++}`);
    params.push(new Date().toISOString());
  }

  if (params.length === 0) return res.status(400).json({ error: 'No verification fields provided', code: 'MISSING_FIELDS' });

  params.push(req.params.id);
  try {
    await query(`UPDATE therapist_profiles SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
    await auditLog(req.user.id, 'therapist.verify', 'therapist', req.params.id, null, null, 'partial');
    return res.status(200).json({ updated: true, is_verified: false });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: err.message, code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /admin/therapists/:id/suspend ─────────────────────────────────────
// Suspends a therapist. Cancels all pending/confirmed future bookings and issues
// credit refunds to affected members. Completed sessions are unaffected — they
// continue through the normal payout flow.
router.patch('/therapists/:id/suspend', async (req, res) => {
  const { reason } = req.body;
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'reason is required', code: 'MISSING_FIELDS' });
  }

  try {
    const { rows: tpRows } = await query(
      `SELECT tp.id, tp.user_id, tp.display_name, u.email
       FROM therapist_profiles tp JOIN users u ON u.id = tp.user_id
       WHERE tp.id = $1`,
      [req.params.id]
    );
    if (!tpRows.length) return res.status(404).json({ error: 'Therapist not found', code: 'NOT_FOUND' });

    await query(
      `UPDATE therapist_profiles
       SET suspended = true, availability_status = 'unavailable', updated_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );

    const { rows: bookings } = await query(
      `UPDATE therapist_bookings
       SET status = 'cancelled', cancellation_reason = 'therapist_suspended', updated_at = NOW()
       WHERE therapist_id = $1
         AND status IN ('pending', 'confirmed')
         AND scheduled_at > NOW()
       RETURNING id, member_user_id, credit_charged`,
      [req.params.id]
    );

    await Promise.all(bookings.map(async (b) => {
      if (!b.member_user_id) return;
      if (b.credit_charged > 0) {
        await refundCredit(b.member_user_id, b.credit_charged, `booking_cancelled:${b.id}`).catch(
          (e) => logger.error(b.id, e.message)
        );
      }
      await query(
        `INSERT INTO notifications (user_id, type, payload, channel)
         VALUES ($1, 'therapist_update', $2, 'in_app')`,
        [b.member_user_id, JSON.stringify({ message: 'Your upcoming therapy session was cancelled. Any credits held have been returned to your balance.' })]
      ).catch(() => {});
    }));

    // Notify therapist — fire-and-forget, does not block response
    if (tpRows[0]?.email) {
      const { sendTherapistSuspended } = require('../services/emailService');
      sendTherapistSuspended(tpRows[0].email, tpRows[0].display_name || 'there').catch(() => {});
    }

    await auditLog(req.user.id, 'therapist.suspend', 'therapist', req.params.id, null, null, reason.trim());
    return res.status(200).json({ suspended: true, bookings_cancelled: bookings.length });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: 'Failed to suspend therapist', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /admin/therapists/:id/unsuspend ───────────────────────────────────
router.patch('/therapists/:id/unsuspend', async (req, res) => {
  try {
    const { rows: unsuspendRows } = await query(
      `UPDATE therapist_profiles tp
       SET suspended = false, availability_status = 'available', updated_at = NOW()
       FROM users u
       WHERE tp.id = $1 AND u.id = tp.user_id
       RETURNING tp.display_name, u.email`,
      [req.params.id]
    );
    if (!unsuspendRows.length) return res.status(404).json({ error: 'Therapist not found', code: 'NOT_FOUND' });

    // Notify therapist — fire-and-forget, does not block response
    if (unsuspendRows[0]?.email) {
      const { sendTherapistUnsuspended } = require('../services/emailService');
      sendTherapistUnsuspended(unsuspendRows[0].email, unsuspendRows[0].display_name || 'there').catch(() => {});
    }

    await auditLog(req.user.id, 'therapist.unsuspend', 'therapist', req.params.id, null, null, null);
    return res.status(200).json({ unsuspended: true });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: 'Failed to unsuspend therapist', code: 'QUERY_ERROR' });
  }
});

// ─── GET /admin/therapists/:id/documents ─────────────────────────────────────
// Returns signed read URLs (1-hour TTL) for all documents uploaded by the therapist.
router.get('/therapists/:id/documents', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT documents FROM therapist_profiles WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Therapist not found', code: 'NOT_FOUND' });

    const documents = rows[0].documents || [];
    if (!documents.length) return res.json({ documents: [] });

    const withUrls = await Promise.all(
      documents.map(async (doc) => {
        try {
          const signed_url = await getSignedUrl(doc.file_path);
          const expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          return { ...doc, signed_url, expires_at };
        } catch {
          return { ...doc, signed_url: null, error: 'Could not generate URL' };
        }
      })
    );

    return res.json({ documents: withUrls });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: 'Failed to load documents', code: 'QUERY_ERROR' });
  }
});

// ─── DELETE /admin/therapists/:id ────────────────────────────────────────────
router.delete('/therapists/:id', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT user_id FROM therapist_profiles WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Therapist not found', code: 'NOT_FOUND' });
    const userId = rows[0].user_id;
    const tId = req.params.id;

    await transaction(async (tx) => {
      // Delete in FK dependency order — tables without ON DELETE CASCADE first
      await tx.query('DELETE FROM therapist_ratings WHERE therapist_id = $1', [tId]);
      await tx.query('DELETE FROM therapist_payouts WHERE therapist_id = $1', [tId]);
      // commissions reference bookings (FK RESTRICT) — must go before bookings
      await tx.query('DELETE FROM therapist_commissions WHERE referred_therapist_id = $1', [tId]);
      // Deleting bookings cascades: therapy_sessions, therapy_session_notes, therapy_disputes
      await tx.query('DELETE FROM therapist_bookings WHERE therapist_id = $1', [tId]);
      // Deleting profile cascades: therapist_availability, booking_slot_locks
      await tx.query('DELETE FROM therapist_profiles WHERE id = $1', [tId]);
      if (userId) await tx.query('DELETE FROM users WHERE id = $1', [userId]);
    });

    await auditLog(req.user.id, 'therapist.delete', 'therapist', tId, null, null, null);
    return res.status(200).json({ deleted: true });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: 'Failed to delete therapist', code: 'QUERY_ERROR' });
  }
});

// ─── POST /admin/therapists/:id/reset-password ───────────────────────────────
router.post('/therapists/:id/reset-password', async (req, res) => {
  const crypto = require('crypto');
  const { sendTherapistPasswordReset } = require('../services/emailService');
  try {
    const { rows } = await query(
      'SELECT u.id, u.email, tp.display_name FROM therapist_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Therapist not found', code: 'NOT_FOUND' });
    const token = crypto.randomBytes(32).toString('hex');
    const hash  = crypto.createHash('sha256').update(token).digest('hex');
    await query(
      `UPDATE users SET reset_token_hash = $1, reset_token_expires = NOW() + INTERVAL '72 hours' WHERE id = $2`,
      [hash, rows[0].id]
    );
    try {
      await sendTherapistPasswordReset(rows[0].email, rows[0].display_name, token);
    } catch (err) {
      logger.error('[therapist.reset_password] Email failed:', err.message);
    }
    await auditLog(req.user.id, 'therapist.reset_password', 'therapist', req.params.id, null, null, null);
    return res.status(200).json({ reset_token: token, email: rows[0].email });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: 'Failed to generate reset link', code: 'QUERY_ERROR' });
  }
});

// ─── GET /admin/peer-requests ────────────────────────────────────────────────
// Live view of all peer requests from the last 24 hours — open, stuck,
// escalated, and completed — so admins can see what's happening in the queue.
router.get('/peer-requests', async (req, res) => {
  const { rows } = await query(
    `SELECT pr.id, pr.status, pr.channel_preference, pr.topic_slug,
            pr.created_at, pr.broaden_at, pr.escalate_at, pr.escalated_at,
            pr.decline_count,
            u.alias AS requester_alias,
            au.alias AS accepted_by_alias,
            s.id AS session_id, s.status AS session_status,
            pr.routing_audit
     FROM peer_requests pr
     JOIN users u ON u.id = pr.user_id
     LEFT JOIN users au ON au.id = pr.accepted_by
     LEFT JOIN sessions s ON s.id = pr.session_id
     WHERE pr.created_at > NOW() - INTERVAL '24 hours'
     ORDER BY pr.created_at DESC
     LIMIT 100`
  );
  return res.status(200).json({ peer_requests: rows });
});

// ─── GET /admin/activity ──────────────────────────────────────────────────────
// Recent cross-app activity feed: sessions started/ended, emergencies,
// peer escalations, reports — gives admins a live pulse of the platform.
router.get('/activity', async (req, res) => {
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit) || 30));

  const [sessions, emergencies, escalations, reports] = await Promise.all([
    query(
      `SELECT 'session' AS event_type, s.id AS ref_id,
              s.type || '_' || s.channel AS sub_type,
              s.status, s.started_at AS event_at,
              u.alias
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.started_at > NOW() - INTERVAL '24 hours'
       ORDER BY s.started_at DESC LIMIT $1`,
      [limit]
    ),
    query(
      `SELECT 'emergency' AS event_type, el.id AS ref_id,
              el.trigger_type AS sub_type,
              el.status, el.triggered_at AS event_at,
              u.alias
       FROM emergency_logs el
       JOIN users u ON u.id = el.user_id
       WHERE el.triggered_at > NOW() - INTERVAL '24 hours'
       ORDER BY el.triggered_at DESC LIMIT $1`,
      [limit]
    ),
    query(
      `SELECT 'peer_escalation' AS event_type, pr.id AS ref_id,
              pr.channel_preference AS sub_type,
              pr.status, COALESCE(pr.escalated_at, pr.updated_at) AS event_at,
              u.alias
       FROM peer_requests pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.status = 'escalated'
         AND pr.updated_at > NOW() - INTERVAL '24 hours'
       ORDER BY pr.updated_at DESC LIMIT $1`,
      [limit]
    ),
    query(
      `SELECT 'report' AS event_type, pr.id AS ref_id,
              'peer' AS sub_type,
              pr.status, pr.created_at AS event_at,
              u.alias
       FROM peer_reports pr
       JOIN users u ON u.id = pr.reporter_id
       WHERE pr.created_at > NOW() - INTERVAL '24 hours'
       ORDER BY pr.created_at DESC LIMIT $1`,
      [limit]
    ),
  ]);

  const feed = [
    ...sessions.rows,
    ...emergencies.rows,
    ...escalations.rows,
    ...reports.rows,
  ].sort((a, b) => new Date(b.event_at) - new Date(a.event_at)).slice(0, limit);

  return res.status(200).json({ feed });
});

// ─── GET /admin/competency-stats ─────────────────────────────────────────────
router.get('/competency-stats', async (req, res) => {
  const since = req.query.since
    ? new Date(req.query.since).toISOString()
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [matchTime, fallback, abandoned, decline, unmet, skillRates] = await Promise.all([
    query(`
      SELECT pr.topic_slug,
             PERCENTILE_CONT(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (s.started_at - pr.created_at))
             )::int AS median_seconds
      FROM peer_requests pr
      JOIN sessions s ON s.id = pr.session_id
      WHERE pr.created_at >= $1 AND pr.accepted_by IS NOT NULL AND pr.topic_slug IS NOT NULL
      GROUP BY pr.topic_slug ORDER BY median_seconds`, [since]),

    query(`
      SELECT topic_slug,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE routing_audit::text LIKE '%tier2_broadcast%'
                                 OR routing_audit::text LIKE '%no_peer_fallback%') AS fallbacks
      FROM peer_requests
      WHERE created_at >= $1 AND topic_slug IS NOT NULL
      GROUP BY topic_slug`, [since]),

    query(`
      SELECT COALESCE(topic_slug,'unspecified') AS topic_slug, COUNT(*) AS count
      FROM peer_requests
      WHERE status = 'escalated' AND created_at >= $1
      GROUP BY topic_slug ORDER BY count DESC`, [since]),

    query(`
      SELECT COALESCE(SUM(decline_count),0) AS total_declines,
             COUNT(*) FILTER (WHERE decline_count > 0) AS requests_with_declines,
             COUNT(*) AS total_requests
      FROM peer_requests WHERE created_at >= $1`, [since]),

    query(`
      SELECT COALESCE(topic_slug,'unspecified') AS topic_slug, COUNT(*) AS unmet
      FROM peer_requests
      WHERE status = 'escalated' AND created_at >= $1
      GROUP BY topic_slug ORDER BY unmet DESC`, [since]),

    query(`
      SELECT s.name, s.slug, s.skill_group,
             COUNT(*) FILTER (WHERE sa.completed_at IS NOT NULL) AS attempts,
             COUNT(*) FILTER (WHERE sa.passed = true) AS passed,
             ROUND(
               COUNT(*) FILTER (WHERE sa.passed = true)::numeric /
               NULLIF(COUNT(*) FILTER (WHERE sa.completed_at IS NOT NULL), 0) * 100
             , 1) AS pass_rate_pct
      FROM skills s
      LEFT JOIN skill_scenarios ss ON ss.skill_id = s.id
      LEFT JOIN skill_attempts sa ON sa.scenario_id = ss.id
      WHERE s.is_active = true
      GROUP BY s.id, s.name, s.slug, s.skill_group
      ORDER BY s.skill_group, s.name`, []),
  ]);

  return res.json({
    since,
    match_time_by_topic: matchTime.rows,
    fallback_rate_by_topic: fallback.rows,
    abandoned_by_topic: abandoned.rows,
    confidence_decline: decline.rows[0] || { total_declines: 0, requests_with_declines: 0, total_requests: 0 },
    unmet_demand_by_topic: unmet.rows,
    skill_completion_rates: skillRates.rows,
  });
});

// ─── GET /admin/permission-flags ─────────────────────────────────────────────
router.get('/permission-flags', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;
  const resolved = req.query.resolved === 'true';

  const [{ rows: flags }, { rows: countRows }] = await Promise.all([
    query(
      `SELECT pf.id, pf.flagged_at, pf.signal_type, pf.signal_data,
              pf.resolved, pf.action_taken, pf.reviewed_at,
              u.alias AS peer_alias, u.email AS peer_email,
              p.slug AS permission_slug, p.name AS permission_name
       FROM permission_flags pf
       JOIN users u ON u.id = pf.user_id
       JOIN permissions p ON p.id = pf.permission_id
       WHERE pf.resolved = $1
       ORDER BY pf.flagged_at DESC
       LIMIT $2 OFFSET $3`,
      [resolved, limit, offset]
    ),
    query(
      `SELECT COUNT(*) AS total FROM permission_flags WHERE resolved = $1`,
      [resolved]
    ),
  ]);

  return res.json({
    flags,
    total: Number(countRows[0].total),
    page,
    pages: Math.ceil(Number(countRows[0].total) / limit),
  });
});

// ─── PATCH /admin/permission-flags/:id/resolve ───────────────────────────────
router.patch('/permission-flags/:id/resolve', async (req, res) => {
  const { action_taken } = req.body;
  const VALID_ACTIONS = [
    'no_action', 'refresher_recommended', 'refresher_required',
    'temporary_suspension', 'revocation',
  ];
  if (!VALID_ACTIONS.includes(action_taken)) {
    return res.status(400).json({
      error: `action_taken must be one of: ${VALID_ACTIONS.join(', ')}`,
      code: 'INVALID_ACTION',
    });
  }

  const { rows: flagRows } = await query(
    `SELECT pf.user_id, pf.permission_id, pf.resolved, u.alias AS peer_alias
     FROM permission_flags pf
     JOIN users u ON u.id = pf.user_id
     WHERE pf.id = $1`,
    [req.params.id]
  );
  if (!flagRows.length) {
    return res.status(404).json({ error: 'Flag not found', code: 'NOT_FOUND' });
  }
  if (flagRows[0].resolved) {
    return res.status(409).json({ error: 'Flag already resolved', code: 'ALREADY_RESOLVED' });
  }

  const { user_id, permission_id } = flagRows[0];
  const adminId = req.user.id;

  await query(
    `UPDATE permission_flags
     SET resolved = true, action_taken = $1, reviewer_id = $2, reviewed_at = NOW()
     WHERE id = $3`,
    [action_taken, adminId, req.params.id]
  );

  if (action_taken === 'refresher_required') {
    await query(
      `UPDATE peer_permissions SET status = 'inactive'
       WHERE user_id = $1 AND permission_id = $2 AND status = 'active'`,
      [user_id, permission_id]
    );
  } else if (action_taken === 'temporary_suspension') {
    await query(
      `UPDATE peer_permissions SET status = 'suspended'
       WHERE user_id = $1 AND permission_id = $2 AND status IN ('active', 'inactive')`,
      [user_id, permission_id]
    );
  } else if (action_taken === 'revocation') {
    await query(
      `UPDATE peer_permissions
       SET status = 'revoked', revoked_by = $3, revoked_at = NOW()
       WHERE user_id = $1 AND permission_id = $2`,
      [user_id, permission_id, adminId]
    );
  }

  await auditLog(req.user.id, 'permission_flag.resolve', 'permission_flag', req.params.id, flagRows[0].peer_alias, null, action_taken);
  return res.json({ resolved: true, action_taken });
});

// ─── GET /admin/group-categories ─────────────────────────────────────────────
router.get('/group-categories', async (req, res) => {
  const { rows } = await query(
    `SELECT slug, label, sort_order FROM group_categories ORDER BY sort_order ASC, slug ASC`
  );
  return res.status(200).json({ categories: rows });
});

// ─── POST /admin/group-categories ────────────────────────────────────────────
router.post('/group-categories', async (req, res) => {
  const { slug, label } = req.body;
  if (!slug || !/^[a-z0-9_]+$/.test(slug)) {
    return res.status(400).json({ error: 'slug must be lowercase letters, digits, or underscores', code: 'INVALID_SLUG' });
  }
  if (!label || !label.trim()) {
    return res.status(400).json({ error: 'label is required', code: 'MISSING_FIELD' });
  }
  const { rows: maxRows } = await query(`SELECT COALESCE(MAX(sort_order), 0) AS max FROM group_categories`);
  const nextOrder = (maxRows[0].max || 0) + 1;
  try {
    const { rows } = await query(
      `INSERT INTO group_categories (slug, label, sort_order) VALUES ($1, $2, $3) RETURNING *`,
      [slug.toLowerCase(), label.trim(), nextOrder]
    );
    return res.status(201).json({ category: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Category slug already exists', code: 'DUPLICATE' });
    throw err;
  }
});

// ─── PATCH /admin/group-categories/:slug ─────────────────────────────────────
router.patch('/group-categories/:slug', async (req, res) => {
  const { label, sort_order } = req.body;
  const setClauses = [];
  const params = [];
  let idx = 1;
  if (label !== undefined)      { setClauses.push(`label = $${idx++}`);      params.push(label.trim()); }
  if (sort_order !== undefined) { setClauses.push(`sort_order = $${idx++}`); params.push(sort_order); }
  if (!setClauses.length) return res.status(400).json({ error: 'No fields to update', code: 'MISSING_FIELDS' });
  params.push(req.params.slug);
  const { rowCount } = await query(
    `UPDATE group_categories SET ${setClauses.join(', ')} WHERE slug = $${idx}`,
    params
  );
  if (!rowCount) return res.status(404).json({ error: 'Category not found', code: 'NOT_FOUND' });
  return res.status(200).json({ updated: true });
});

// ─── DELETE /admin/group-categories/:slug ────────────────────────────────────
router.delete('/group-categories/:slug', async (req, res) => {
  const { rows: usageRows } = await query(
    `SELECT COUNT(*) AS cnt FROM groups WHERE category_slug = $1`,
    [req.params.slug]
  );
  if (parseInt(usageRows[0].cnt) > 0) {
    return res.status(409).json({ error: 'Category is in use by one or more groups', code: 'IN_USE' });
  }
  const { rowCount } = await query(`DELETE FROM group_categories WHERE slug = $1`, [req.params.slug]);
  if (!rowCount) return res.status(404).json({ error: 'Category not found', code: 'NOT_FOUND' });
  return res.status(200).json({ deleted: true });
});

// ─── POST /admin/groups ──────────────────────────────────────────────────────
router.post('/groups', async (req, res) => {
  const { name, category_slug, description } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'name is required', code: 'MISSING_FIELD' });
  }

  const { rows: catRows } = await query(
    `SELECT slug FROM group_categories WHERE slug = $1`, [category_slug]
  );
  if (!catRows.length) {
    return res.status(400).json({ error: 'category_slug is not a valid category', code: 'INVALID_CATEGORY' });
  }

  const { rows } = await query(
    `INSERT INTO groups (name, category_slug, description, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name.trim(), category_slug, description?.trim() || null, req.user.id]
  );
  return res.status(201).json({ group_id: rows[0].id });
});

// ─── GET /admin/groups ───────────────────────────────────────────────────────
router.get('/groups', async (req, res) => {
  const { rows } = await query(
    `SELECT g.id, g.name, g.category_slug, gc.label AS category_label,
            g.description, g.is_active, g.created_at,
            COUNT(gm.id) FILTER (WHERE gm.status = 'active') AS member_count,
            (SELECT MAX(gm2.created_at) FROM group_messages gm2
             WHERE gm2.group_id = g.id AND gm2.is_deleted = false) AS last_post_at
     FROM groups g
     JOIN group_categories gc ON gc.slug = g.category_slug
     LEFT JOIN group_memberships gm ON gm.group_id = g.id
     GROUP BY g.id, gc.label
     ORDER BY g.name ASC`
  );
  return res.status(200).json({ groups: rows });
});

// ─── PATCH /admin/groups/:id ─────────────────────────────────────────────────
router.patch('/groups/:id', async (req, res) => {
  const { name, category_slug, description } = req.body;
  const setClauses = ['updated_at = NOW()'];
  const params = [];
  let idx = 1;

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty', code: 'MISSING_FIELD' });
    setClauses.push(`name = $${idx++}`); params.push(name.trim());
  }
  if (category_slug !== undefined) {
    const { rows: catRows } = await query(`SELECT slug FROM group_categories WHERE slug = $1`, [category_slug]);
    if (!catRows.length) return res.status(400).json({ error: 'category_slug is not valid', code: 'INVALID_CATEGORY' });
    setClauses.push(`category_slug = $${idx++}`); params.push(category_slug);
  }
  if (description !== undefined) { setClauses.push(`description = $${idx++}`); params.push(description?.trim() || null); }

  if (params.length === 0) return res.status(400).json({ error: 'No fields to update', code: 'MISSING_FIELDS' });

  params.push(req.params.id);
  const { rowCount } = await query(
    `UPDATE groups SET ${setClauses.join(', ')} WHERE id = $${idx}`, params
  );
  if (!rowCount) return res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
  return res.status(200).json({ updated: true });
});

// ─── PATCH /admin/groups/:id/status ──────────────────────────────────────────
router.patch('/groups/:id/status', async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be boolean', code: 'INVALID_FIELD' });
  }
  const { rowCount } = await query(
    `UPDATE groups SET is_active = $1, updated_at = NOW() WHERE id = $2`,
    [is_active, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
  return res.status(200).json({ updated: true, is_active });
});

// ─── DELETE /admin/groups/:id ─────────────────────────────────────────────────
router.delete('/groups/:id', async (req, res) => {
  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS cnt FROM group_memberships WHERE group_id = $1 AND status = 'active'`,
    [req.params.id]
  );
  if (parseInt(countRows[0].cnt) > 0) {
    return res.status(409).json({ error: 'Cannot delete a group that has active members', code: 'HAS_MEMBERS' });
  }
  const { rowCount } = await query(`DELETE FROM groups WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
  return res.status(200).json({ deleted: true });
});

// ─── GET /admin/groups/:id/feed ───────────────────────────────────────────────
// Group state for admin panel — no membership check. Returns live content + held responses.
router.get('/groups/:id/feed', async (req, res) => {
  const [groupResult, announcementResult, promptResult, pollResult, heldResult] = await Promise.all([
    query(
      `SELECT g.id, g.name, g.category_slug, gc.label AS category_label, g.description,
              COUNT(gm.id) FILTER (WHERE gm.status = 'active') AS member_count
       FROM groups g
       JOIN group_categories gc ON gc.slug = g.category_slug
       LEFT JOIN group_memberships gm ON gm.group_id = g.id
       WHERE g.id = $1
       GROUP BY g.id, gc.label`,
      [req.params.id]
    ),
    query(
      `SELECT id, content, created_at
       FROM group_messages
       WHERE group_id = $1 AND post_type = 'announcement' AND is_deleted = false
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    ),
    query(
      `SELECT gm.id, gm.content, gm.created_at,
              (SELECT COUNT(*)::int FROM group_messages r
               WHERE r.parent_id = gm.id AND r.post_type = 'response' AND r.is_deleted = false
              ) AS response_count
       FROM group_messages gm
       WHERE gm.group_id = $1 AND gm.post_type = 'prompt' AND gm.is_deleted = false
       ORDER BY gm.created_at DESC LIMIT 1`,
      [req.params.id]
    ),
    query(
      `SELECT gp.id, gp.question, gp.min_votes_to_show,
              (SELECT COUNT(*)::int FROM group_poll_votes WHERE poll_id = gp.id) AS total_votes,
              json_agg(
                json_build_object('id', gpo.id, 'label', gpo.label,
                  'votes', (SELECT COUNT(*)::int FROM group_poll_votes WHERE option_id = gpo.id)
                ) ORDER BY gpo.position
              ) AS options
       FROM group_polls gp
       JOIN group_poll_options gpo ON gpo.poll_id = gp.id
       WHERE gp.group_id = $1 AND gp.is_active = true
       GROUP BY gp.id
       ORDER BY gp.created_at DESC LIMIT 1`,
      [req.params.id]
    ),
    query(
      `SELECT gm.id, gm.content, gm.created_at, gm.risk_flagged, u.alias
       FROM group_messages gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 AND gm.post_type = 'response' AND gm.is_deleted = true
       ORDER BY gm.created_at DESC
       LIMIT 30`,
      [req.params.id]
    ),
  ]);

  if (!groupResult.rows.length) {
    return res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
  }

  return res.status(200).json({
    group: groupResult.rows[0],
    announcement: announcementResult.rows[0] || null,
    prompt: promptResult.rows[0] || null,
    poll: pollResult.rows[0] || null,
    held: heldResult.rows,
  });
});

// ─── GET /admin/groups/held ───────────────────────────────────────────────────
// All held group responses (is_deleted=true, post_type=response) across all groups.
router.get('/groups/held', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  const [dataResult, countResult] = await Promise.all([
    query(
      `SELECT gm.id, gm.content, gm.created_at, gm.risk_flagged,
              u.alias,
              g.id AS group_id, g.name AS group_name,
              p.content AS prompt_content
       FROM group_messages gm
       JOIN users u ON u.id = gm.user_id
       JOIN groups g ON g.id = gm.group_id
       LEFT JOIN group_messages p ON p.id = gm.parent_id
       WHERE gm.post_type = 'response' AND gm.is_deleted = true
       ORDER BY gm.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    query(
      `SELECT COUNT(*) FROM group_messages WHERE post_type = 'response' AND is_deleted = true`
    ),
  ]);

  return res.status(200).json({
    held: dataResult.rows,
    total: parseInt(countResult.rows[0].count),
    page,
    pages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
  });
});

// ─── POST /admin/groups/held/:msgId/publish ───────────────────────────────────
// Publish a held response (set is_deleted=false).
router.post('/groups/held/:msgId/publish', async (req, res) => {
  const { rowCount } = await query(
    `UPDATE group_messages SET is_deleted = false
     WHERE id = $1 AND post_type = 'response' AND is_deleted = true`,
    [req.params.msgId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Held response not found', code: 'NOT_FOUND' });
  return res.status(200).json({ published: true });
});

// ─── DELETE /admin/groups/held/:msgId ────────────────────────────────────────
// Hard-delete a held response (confirmed harmful content).
router.delete('/groups/held/:msgId', async (req, res) => {
  const { rowCount } = await query(
    `DELETE FROM group_messages WHERE id = $1 AND post_type = 'response'`,
    [req.params.msgId]
  );
  if (!rowCount) return res.status(404).json({ error: 'Response not found', code: 'NOT_FOUND' });
  return res.status(200).json({ deleted: true });
});

// ─── GET /admin/audit-log ────────────────────────────────────────────────────
router.get('/audit-log', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = 30;
  const offset = (page - 1) * limit;
  const action = req.query.action || null;

  const params = [];
  let where = '';
  if (action) {
    params.push(`${action}%`);
    where = `WHERE al.action LIKE $${params.length}`;
  }

  const [logsRes, countRes] = await Promise.all([
    query(
      `SELECT al.id, al.action, al.target_type, al.target_id, al.target_alias,
              al.before_value, al.after_value, al.created_at,
              u.alias AS admin_alias
       FROM admin_audit_log al
       JOIN users u ON u.id = al.admin_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    query(
      `SELECT COUNT(*) AS total FROM admin_audit_log al ${where}`,
      params
    ),
  ]);

  return res.json({
    logs:  logsRes.rows,
    total: parseInt(countRes.rows[0].total),
    page,
    pages: Math.ceil(parseInt(countRes.rows[0].total) / limit),
  });
});

// ─── GET /admin/config ────────────────────────────────────────────────────────
// Returns all platform_config keys and their current values.
router.get('/config', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT key, value, updated_at FROM platform_config ORDER BY key ASC`
    );
    return res.json({ config: rows });
  } catch (err) {
    logger.error('admin/config GET error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch config', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /admin/config/:key ─────────────────────────────────────────────────
// Upserts a single config key. Body: { value: any }
router.patch('/config/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (value === undefined) {
    return res.status(400).json({ error: 'value is required', code: 'MISSING_VALUE' });
  }
  try {
    const { rows } = await query(
      `INSERT INTO platform_config (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(value)]
    );
    await invalidateConfig(key);
    await auditLog(req.user.id, `config.update`, 'config', key, key, null, JSON.stringify(value));
    return res.json({ config: rows[0] });
  } catch (err) {
    logger.error('admin/config PATCH error:', err.message);
    return res.status(500).json({ error: 'Failed to update config', code: 'QUERY_ERROR' });
  }
});

// ─── GET /admin/therapy/disputes ─────────────────────────────────────────────
router.get('/therapy/disputes', async (req, res) => {
  try {
    const { status = 'open', limit = 50, offset = 0 } = req.query;
    const { rows } = await query(
      `SELECT td.id, td.booking_id, td.raised_by, td.raised_by_role, td.reason,
              td.status, td.outcome, td.admin_notes, td.resolved_at, td.created_at,
              tb.scheduled_at, tb.rate_kes, tb.escrow_status,
              u.alias AS member_alias, tp.display_name AS therapist_name
       FROM therapy_disputes td
       JOIN therapist_bookings tb ON td.booking_id = tb.id
       JOIN users u ON tb.member_user_id = u.id
       JOIN therapist_profiles tp ON tb.therapist_id = tp.id
       WHERE ($1 = 'all' OR td.status = $1)
       ORDER BY td.created_at DESC
       LIMIT $2 OFFSET $3`,
      [status, parseInt(limit), parseInt(offset)]
    );
    return res.json({ disputes: rows, count: rows.length });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: 'Failed to load disputes', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /admin/therapy/disputes/:id/resolve ────────────────────────────────
router.patch('/therapy/disputes/:id/resolve', async (req, res) => {
  const { outcome, notes } = req.body;
  if (!outcome) return res.status(400).json({ error: 'outcome is required', code: 'MISSING_FIELDS' });
  const validOutcomes = ['full_refund', 'partial_refund', 'no_refund', 'therapist_penalty'];
  if (!validOutcomes.includes(outcome)) {
    return res.status(400).json({ error: `outcome must be one of: ${validOutcomes.join(', ')}`, code: 'INVALID_OUTCOME' });
  }
  try {
    const { rows: dispRows } = await query(
      `SELECT td.*, tb.member_user_id, tb.credit_charged, tb.rate_kes, tb.therapist_id
       FROM therapy_disputes td JOIN therapist_bookings tb ON td.booking_id = tb.id
       WHERE td.id = $1 AND td.status = 'open'`,
      [req.params.id]
    );
    if (!dispRows.length) return res.status(404).json({ error: 'Dispute not found or already resolved', code: 'NOT_FOUND' });
    const disp = dispRows[0];

    // Map outcome to DB status
    const statusMap = {
      full_refund: 'resolved_refund',
      partial_refund: 'resolved_partial',
      no_refund: 'resolved_release',
      therapist_penalty: 'resolved_release',
    };
    const newStatus = statusMap[outcome];

    // Resolve dispute
    await query(
      `UPDATE therapy_disputes SET status=$1, outcome=$2, admin_notes=$3,
       resolved_at=NOW(), resolved_by=$4 WHERE id=$5`,
      [newStatus, outcome, notes || null, req.user.id, disp.id]
    );

    // Update escrow on booking
    const newEscrow = outcome === 'no_refund' ? 'released' : 'refunded';
    await query(
      `UPDATE therapist_bookings SET escrow_status=$1, updated_at=NOW() WHERE id=$2`,
      [newEscrow, disp.booking_id]
    );

    // Credit refund if applicable
    if ((outcome === 'full_refund' || outcome === 'partial_refund') && disp.credit_charged > 0) {
      const { refundCredit } = require('../utils/creditDeductor');
      const refundAmt = outcome === 'full_refund' ? disp.credit_charged : Math.ceil(disp.credit_charged / 2);
      await refundCredit(disp.member_user_id, refundAmt, null, 'therapy_dispute_refund',
        `Dispute resolved: ${outcome}`).catch((e) => logger.error(e.message));
    }

    await auditLog(req.user.id, 'therapy.dispute.resolve', 'dispute', disp.id, null, null,
      JSON.stringify({ outcome, booking_id: disp.booking_id }));

    return res.json({ resolved: true, outcome, dispute_id: disp.id });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: 'Failed to resolve dispute', code: 'QUERY_ERROR' });
  }
});

// ─── GET /admin/referrals ─────────────────────────────────────────────────────
router.get('/referrals', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT tr.id, tr.status, tr.admin_notes, tr.created_at,
              u.alias,
              COALESCE(
                json_agg(
                  json_build_object('therapist_id', ti.therapist_id, 'display_name', tp.display_name)
                ) FILTER (WHERE ti.therapist_id IS NOT NULL), '[]'
              ) AS interests
         FROM therapist_referrals tr
         JOIN users u ON u.id = tr.user_id
         LEFT JOIN therapist_interests ti ON ti.referral_id = tr.id
         LEFT JOIN therapist_profiles tp ON tp.therapist_user_id = ti.therapist_id
        GROUP BY tr.id, u.alias
        ORDER BY tr.created_at DESC`
    );
    return res.json({ referrals: rows });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: 'Failed to fetch referrals', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /admin/referrals/:id ───────────────────────────────────────────────
router.patch('/referrals/:id', async (req, res) => {
  const { id } = req.params;
  const { status, admin_notes } = req.body;

  const VALID_STATUSES = ['pending', 'in_review', 'arranged', 'escalated', 'closed'];
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status', code: 'INVALID_STATUS' });
  }

  try {
    const { rows } = await query(
      `UPDATE therapist_referrals
          SET status      = COALESCE($1, status),
              admin_notes = COALESCE($2, admin_notes),
              updated_at  = NOW()
        WHERE id = $3
        RETURNING id, status, admin_notes`,
      [status || null, admin_notes !== undefined ? admin_notes : null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Referral not found', code: 'NOT_FOUND' });

    await auditLog(req.user.id, 'referral.update', 'referral', id, null,
      null, JSON.stringify({ status, admin_notes }));

    return res.json({ updated: true, referral: rows[0] });
  } catch (err) {
    logger.error(err.message);
    return res.status(500).json({ error: 'Failed to update referral', code: 'QUERY_ERROR' });
  }
});

// ─── Promo codes ──────────────────────────────────────────────────────────────

router.get('/promo-codes', adminAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, code, credit_value, max_uses, uses_count,
            valid_from, valid_until, campaign_label, is_active, created_at
     FROM promo_codes ORDER BY created_at DESC`
  );
  return res.json({ codes: rows });
});

router.get('/promo-codes/check', adminAuth, async (req, res) => {
  const code = (req.query.code || '').trim().toUpperCase();
  if (!code) return res.json({ exists: false });
  const { rows } = await query('SELECT 1 FROM promo_codes WHERE code = $1', [code]);
  return res.json({ exists: rows.length > 0 });
});

router.post('/promo-codes', adminAuth, async (req, res) => {
  const { code, credit_value, max_uses, valid_until, campaign_label } = req.body;
  if (!code || !credit_value) {
    return res.status(400).json({ error: 'code and credit_value are required' });
  }
  const clean = code.toString().trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(clean)) {
    return res.status(400).json({ error: 'Code must be uppercase alphanumeric only' });
  }
  if (parseInt(credit_value, 10) < 1) {
    return res.status(400).json({ error: 'credit_value must be at least 1' });
  }
  try {
    const { rows } = await query(
      `INSERT INTO promo_codes (code, credit_value, max_uses, valid_until, campaign_label, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [clean, parseInt(credit_value, 10), max_uses || null, valid_until || null, campaign_label || null, req.user.id]
    );
    return res.status(201).json({ code: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That code already exists' });
    }
    throw err;
  }
});

router.patch('/promo-codes/:id', adminAuth, async (req, res) => {
  const { is_active, valid_until, max_uses } = req.body;
  const { rows } = await query(
    `UPDATE promo_codes
     SET is_active   = COALESCE($1, is_active),
         valid_until = COALESCE($2::timestamptz, valid_until),
         max_uses    = COALESCE($3, max_uses)
     WHERE id = $4 RETURNING *`,
    [
      is_active !== undefined ? is_active : null,
      valid_until || null,
      max_uses !== undefined ? max_uses : null,
      req.params.id,
    ]
  );
  if (!rows.length) return res.status(404).json({ error: 'Code not found' });
  return res.json({ code: rows[0] });
});

router.get('/promo-codes/:id/redemptions', adminAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT u.alias, r.credits_awarded, r.redeemed_at
     FROM promo_code_redemptions r
     JOIN users u ON u.id = r.user_id
     WHERE r.promo_code_id = $1
     ORDER BY r.redeemed_at DESC`,
    [req.params.id]
  );
  return res.json({ redemptions: rows });
});

// ─── GET /admin/members ───────────────────────────────────────────────────────
// Search users by email or alias. Returns all roles so admin can find conflicts.
router.get('/members', async (req, res) => {
  const { email, alias } = req.query;
  if (!email && !alias) {
    return res.status(400).json({ error: 'email or alias query param required', code: 'MISSING_PARAM' });
  }
  try {
    let rows;
    if (email) {
      ({ rows } = await query(
        `SELECT u.id, u.alias, u.email, u.role, u.is_active, u.email_verified, u.created_at,
                u.peer_quiz_done, c.balance AS credit_balance
         FROM users u
         LEFT JOIN credits c ON c.user_id = u.id
         WHERE u.email = $1`,
        [email.toLowerCase().trim()]
      ));
    } else {
      // Escape ILIKE wildcards in user input to prevent unintended broad matches
      const escaped = alias.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      ({ rows } = await query(
        `SELECT u.id, u.alias, u.email, u.role, u.is_active, u.email_verified, u.created_at,
                u.peer_quiz_done, c.balance AS credit_balance
         FROM users u
         LEFT JOIN credits c ON c.user_id = u.id
         WHERE u.alias ILIKE $1 ESCAPE '\\'
         LIMIT 20`,
        [`%${escaped}%`]
      ));
    }
    return res.json({ members: rows });
  } catch (err) {
    logger.error('admin/members GET error:', err.message);
    return res.status(500).json({ error: 'Failed to search members', code: 'QUERY_ERROR' });
  }
});

// ─── GET /admin/members/suggest ───────────────────────────────────────────────
// Typeahead: returns up to 8 matching emails or aliases (min 2 chars).
router.get('/members/suggest', async (req, res) => {
  const { q, field } = req.query;
  if (!q || q.trim().length < 2) return res.json({ suggestions: [] });
  if (field !== 'email' && field !== 'alias') return res.status(400).json({ error: 'field must be email or alias', code: 'INVALID_FIELD' });
  try {
    const escaped = q.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const col = field === 'email' ? 'email' : 'alias';
    const { rows } = await query(
      `SELECT ${col} AS value FROM users WHERE ${col} ILIKE $1 ESCAPE '\\' ORDER BY ${col} LIMIT 8`,
      [`%${escaped}%`]
    );
    return res.json({ suggestions: rows.map((r) => r.value) });
  } catch (err) {
    logger.error('admin/members/suggest error:', err.message);
    return res.status(500).json({ error: 'Suggest failed', code: 'QUERY_ERROR' });
  }
});

// ─── DELETE /admin/members/:id ────────────────────────────────────────────────
// Soft-deletes (deactivates) a member account — preserves payment history and
// FK-linked records. Does not free the email; email is freed only if needed via
// a direct DB update. Hard-delete was unsafe due to cascade/restrict FK mix.
router.delete('/members/:id', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE users SET is_active = false
       WHERE id = $1 AND role = 'member'
       RETURNING alias, email, role`,
      [req.params.id]
    );
    if (!rows.length) {
      // Either not found or not a member — check which
      const { rows: check } = await query('SELECT role FROM users WHERE id = $1', [req.params.id]);
      if (!check.length) return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
      return res.status(409).json({ error: 'Only member accounts can be deactivated here. Use the Therapists tab for therapist accounts.', code: 'WRONG_ROLE' });
    }
    const user = rows[0];
    await auditLog(req.user.id, 'member.deactivate', 'user', req.params.id, user.alias,
      JSON.stringify({ email: user.email }), JSON.stringify({ is_active: false }));
    return res.json({ deactivated: true, alias: user.alias });
  } catch (err) {
    logger.error('admin/members DELETE error:', err.message);
    return res.status(500).json({ error: 'Failed to deactivate member', code: 'QUERY_ERROR' });
  }
});

// ─── POST /admin/members/:id/grant-peer-status ───────────────────────────────
// Grants peer status to a vetted member without requiring the peer quiz.
// Writes the same two fields that POST /peer/quiz/complete writes.
router.post('/members/:id/grant-peer-status', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT alias, email, peer_quiz_done FROM users WHERE id = $1 AND role = 'member'`,
      [req.params.id]
    );
    if (!rows.length) {
      const { rows: any } = await query('SELECT role FROM users WHERE id = $1', [req.params.id]);
      if (!any.length) return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
      return res.status(409).json({ error: 'Only member accounts can be granted peer status here.', code: 'WRONG_ROLE' });
    }
    if (rows[0].peer_quiz_done) {
      return res.status(409).json({ error: 'User is already a peer.', code: 'ALREADY_PEER' });
    }
    await query(
      `UPDATE users SET peer_quiz_done = true, peer_available_until = NOW() + INTERVAL '10 years', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    await auditLog(req.user.id, 'member.grant_peer_status', 'user', req.params.id, rows[0].alias,
      JSON.stringify({ peer_quiz_done: false }), JSON.stringify({ peer_quiz_done: true }));
    return res.json({ granted: true, alias: rows[0].alias });
  } catch (err) {
    logger.error('admin/members/grant-peer-status error:', err.message);
    return res.status(500).json({ error: 'Failed to grant peer status', code: 'QUERY_ERROR' });
  }
});

// ─── GET /admin/referral-applications ────────────────────────────────────────
const REFERRAL_APP_STATUSES = ['pending', 'account_created', 'rejected'];
router.get('/referral-applications', async (req, res) => {
  const { status } = req.query;
  if (status && !REFERRAL_APP_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${REFERRAL_APP_STATUSES.join(', ')}`, code: 'INVALID_STATUS' });
  }
  try {
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE a.status = $1`;
    }
    const { rows } = await query(
      `SELECT a.id, a.full_legal_name, a.email, a.phone, a.signature_name,
              a.doc_version, a.status, a.admin_notes, a.ip_address,
              a.agreement_signed_at, a.created_at, a.therapist_profile_id,
              a.referrer_therapist_id,
              tp.display_name AS referrer_name,
              tp.addendum_signed_at AS referrer_addendum_signed_at,
              tp2.display_name AS linked_therapist_name
       FROM therapist_referral_applications a
       LEFT JOIN therapist_profiles tp  ON tp.id  = a.referrer_therapist_id
       LEFT JOIN therapist_profiles tp2 ON tp2.id = a.therapist_profile_id
       ${where}
       ORDER BY a.created_at DESC`,
      params
    );
    return res.status(200).json({ applications: rows });
  } catch (err) {
    logger.error('admin/referral-applications GET error:', err.message);
    return res.status(500).json({ error: 'Failed to load applications', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /admin/referral-applications/:id ───────────────────────────────────
router.patch('/referral-applications/:id', async (req, res) => {
  const { status, admin_notes, therapist_profile_id } = req.body;
  const VALID = ['pending', 'account_created', 'rejected'];
  if (!status || !VALID.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}`, code: 'INVALID_STATUS' });
  }
  try {
    const { rows } = await query(
      `UPDATE therapist_referral_applications
         SET status = $1,
             admin_notes = COALESCE($2, admin_notes),
             therapist_profile_id = COALESCE($3::uuid, therapist_profile_id)
       WHERE id = $4
       RETURNING id, email, status`,
      [status, admin_notes || null, therapist_profile_id || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Application not found' });
    await auditLog(req.user.id, 'referral_application.update', 'referral_application',
      req.params.id, rows[0].email, null, JSON.stringify({ status }));
    return res.status(200).json({ updated: true, application: rows[0] });
  } catch (err) {
    logger.error('admin/referral-applications PATCH error:', err.message);
    return res.status(500).json({ error: 'Failed to update application', code: 'QUERY_ERROR' });
  }
});

// ─── POST /admin/referral-applications/:id/create-account ────────────────────
// Creates a therapist account from a referral application.
// Sets referred_by_therapist_id on the new profile so the commission engine fires.
// Idempotent — 409 if the application is already linked to a profile.
router.post('/referral-applications/:id/create-account', async (req, res) => {
  const crypto = require('crypto');
  const bcrypt = require('bcrypt');
  const { generateAlias } = require('../utils/aliasGenerator');
  const { sendTherapistInvite } = require('../services/emailService');

  try {
    const { rows: appRows } = await query(
      `SELECT id, email, full_legal_name, referrer_therapist_id, therapist_profile_id
       FROM therapist_referral_applications WHERE id = $1`,
      [req.params.id]
    );
    if (!appRows.length) return res.status(404).json({ error: 'Application not found', code: 'NOT_FOUND' });
    const app = appRows[0];
    if (app.therapist_profile_id) {
      return res.status(409).json({ error: 'Account already created for this application', code: 'ALREADY_CREATED' });
    }

    const emailLower = app.email.toLowerCase().trim();
    const displayName = app.full_legal_name.trim();
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const inviteHash  = crypto.createHash('sha256').update(inviteToken).digest('hex');

    const { rows: existingProfile } = await query(
      `SELECT tp.id FROM therapist_profiles tp JOIN users u ON u.id = tp.user_id WHERE u.email = $1`,
      [emailLower]
    );
    if (existingProfile.length) {
      return res.status(409).json({ error: 'A therapist profile already exists for this email.', code: 'DUPLICATE_THERAPIST' });
    }

    const { rows: existingUser } = await query('SELECT id, alias FROM users WHERE email = $1', [emailLower]);

    let userId, profileId, alias;

    if (existingUser.length) {
      userId = existingUser[0].id;
      alias  = existingUser[0].alias;
      ({ profileId } = await transaction(async (tx) => {
        await tx.query(
          `UPDATE users SET reset_token_hash = $1, reset_token_expires = NOW() + INTERVAL '72 hours' WHERE id = $2`,
          [inviteHash, userId]
        );
        const { rows } = await tx.query(
          `INSERT INTO therapist_profiles (user_id, display_name, full_name, credentials, referred_by_therapist_id)
           VALUES ($1, $2, $3, '', $4) RETURNING id`,
          [userId, displayName, displayName, app.referrer_therapist_id || null]
        );
        return { profileId: rows[0].id };
      }));
    } else {
      alias = await generateAlias();
      const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      ({ userId, profileId } = await transaction(async (tx) => {
        const { rows: uRows } = await tx.query(
          `INSERT INTO users (email, password_hash, alias, role, consent_version, email_verified)
           VALUES ($1, $2, $3, 'therapist', '1.0', true) RETURNING id`,
          [emailLower, placeholderHash, alias]
        );
        const uId = uRows[0].id;
        await tx.query(
          `UPDATE users SET reset_token_hash = $1, reset_token_expires = NOW() + INTERVAL '72 hours' WHERE id = $2`,
          [inviteHash, uId]
        );
        const { rows } = await tx.query(
          `INSERT INTO therapist_profiles (user_id, display_name, full_name, credentials, referred_by_therapist_id)
           VALUES ($1, $2, $3, '', $4) RETURNING id`,
          [uId, displayName, displayName, app.referrer_therapist_id || null]
        );
        return { userId: uId, profileId: rows[0].id };
      }));
    }

    await query(
      `UPDATE therapist_referral_applications
         SET therapist_profile_id = $1, status = 'account_created'
       WHERE id = $2`,
      [profileId, app.id]
    );

    try {
      await sendTherapistInvite(emailLower, displayName, inviteToken);
    } catch (err) {
      logger.error('[referral-application.create-account] Email failed:', err.message);
    }

    await auditLog(req.user.id, 'referral_application.create_account', 'therapist',
      userId, alias, null, JSON.stringify({ application_id: app.id, referrer: app.referrer_therapist_id }));

    return res.status(201).json({ therapist_id: profileId, alias });
  } catch (err) {
    logger.error('[admin/referral-applications create-account]', err.message);
    return res.status(500).json({ error: 'Failed to create therapist account.', code: 'SERVER_ERROR' });
  }
});

module.exports = router;
