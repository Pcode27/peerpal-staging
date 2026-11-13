'use strict';

const express  = require('express');
const logger = require('../utils/logger');

const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../db');
const auth     = require('../middleware/auth');
const therapistAuth = require('../middleware/therapistAuth');
const { deductCredit, refundCredit } = require('../utils/creditDeductor');
const { initiatePayment, verifyWebhook } = require('../services/payment');
const { calculateTherapyPricing } = require('../services/pricing');
const { paymentLimiter, publicFormLimiter } = require('../middleware/rateLimit');
const { parseB2CCallback } = require('../utils/therapistPayout');
const { issueFullRefund } = require('../utils/therapyRefund');
const { getTurnCredentialsWithFallback } = require('../utils/turnCredentials');
const bcrypt = require('bcrypt');
const { therapyRooms } = require('../ws/signaling');
const { encrypt, decrypt } = require('../utils/encryption');
const { initiatePayout } = require('../utils/therapistPayout');
const { enqueuePushNotification, notifyAllAdmins } = require('../utils/fcm');

const router = express.Router();

const THERAPY_CONSENT_VERSION = '2.0';
const UUID_RE                  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLOT_LOCK_MINUTES        = 5;
const SLOT_DURATION_MINUTES    = 60; // default slot duration when generating grid
const DISPUTE_WINDOW_HOURS     = 24;
const BAYESIAN_C               = 10;
const BAYESIAN_MEAN            = 3.5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function notifyUser(user_id, type, payload) {
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     VALUES ($1, $2, $3, 'in_app')`,
    [user_id, type, JSON.stringify(payload)]
  ).catch((e) => logger.error(e.message));
}

// ─── GET /therapy/categories ─────────────────────────────────────────────────
router.get('/categories', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT tc.id, tc.name, tc.description, tc.icon_name, tc.condition_tags, tc.sort_order,
              (SELECT COUNT(*) FROM therapist_profiles tp
               WHERE tp.is_active = true AND tp.is_verified = true AND tp.suspended = false
                 AND tc.id::text = ANY(tp.category_ids::text[])) AS therapist_count
       FROM therapist_categories tc
       WHERE tc.is_active = true
       ORDER BY tc.sort_order ASC, tc.name ASC`
    );
    return res.status(200).json({ categories: rows });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load categories', code: 'QUERY_ERROR' });
  }
});

// ─── DELETE /therapy/slot-lock/:id ───────────────────────────────────────────
// Release lock on back-navigation — only lock owner can delete.
router.delete('/slot-lock/:id', auth, async (req, res) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM booking_slot_locks WHERE id = $1 AND locked_by = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Lock not found or not yours', code: 'NOT_FOUND' });
    return res.status(200).json({ released: true });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to release lock', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapists ──────────────────────────────────────────────────
// Discovery list — verified, active, non-suspended therapists.
// Filters: category_id, session_format, language, gender, max_rate_kes
router.get('/therapists', auth, async (req, res) => {
  try {
    const { category_id, session_format, language, gender, max_rate_kes } = req.query;

    const conditions = [
      'tp.is_active = true',
      'tp.is_verified = true',
      'tp.suspended = false',
    ];
    const params = [];
    let idx = 1;

    if (category_id)    { params.push(category_id);    conditions.push(`$${idx++} = ANY(tp.category_ids::text[])`); }
    if (session_format) { params.push(session_format); conditions.push(`$${idx++} = ANY(tp.session_formats)`); }
    if (language)       { params.push(language);       conditions.push(`$${idx++} = ANY(tp.languages)`); }
    if (gender)         { params.push(gender);         conditions.push(`tp.gender = $${idx++}`); }
    if (max_rate_kes)   { params.push(parseInt(max_rate_kes)); conditions.push(`tp.rate_per_session_kes <= $${idx++}`); }

    const { rows } = await query(
      `SELECT tp.id, tp.display_name, tp.photo_url, tp.credentials, tp.years_experience,
              tp.languages, tp.session_formats, tp.category_ids, tp.location,
              tp.plain_language_intro, tp.approach_plain, tp.cultural_competencies,
              tp.availability_status, tp.average_rating, tp.total_ratings_count,
              tp.total_sessions, tp.rate_per_session_kes, tp.gender, tp.age
       FROM therapist_profiles tp
       WHERE ${conditions.join(' AND ')}
       ORDER BY
         CASE tp.availability_status WHEN 'available' THEN 0 WHEN 'limited' THEN 1 ELSE 2 END,
         tp.average_rating DESC,
         tp.total_sessions DESC`,
      params
    );
    return res.status(200).json({ therapists: rows });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load therapists', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapists/:id ─────────────────────────────────────────────
router.get('/therapists/:id', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT tp.id, tp.display_name, tp.photo_url, tp.credentials,
              tp.years_experience, tp.languages, tp.session_formats, tp.category_ids,
              tp.location, tp.plain_language_intro, tp.approach_plain,
              tp.cultural_competencies, tp.availability_status, tp.average_rating,
              tp.total_ratings_count, tp.total_sessions, tp.rate_per_session_kes,
              tp.gender, tp.age, tp.kcpa_level
       FROM therapist_profiles tp
       WHERE tp.id = $1 AND tp.is_active = true AND tp.is_verified = true AND tp.suspended = false`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Therapist not found', code: 'NOT_FOUND' });
    return res.status(200).json({ therapist: rows[0] });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load therapist', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapists/:id/availability ─────────────────────────────────
// Returns available ISO datetime slots for the next 14 days based on
// therapist_availability weekly schedule, minus already-booked and locked slots.
router.get('/therapists/:id/availability', auth, async (req, res) => {
  try {
    const therapistId = req.params.id;

    const [scheduleResult, bookedResult, lockedResult] = await Promise.all([
      query(
        `SELECT day_of_week, start_time, end_time
         FROM therapist_availability
         WHERE therapist_id = $1 AND is_active = true`,
        [therapistId]
      ),
      query(
        `SELECT scheduled_at FROM therapist_bookings
         WHERE therapist_id = $1
           AND status NOT IN ('cancelled', 'therapist_no_show', 'member_no_show')
           AND scheduled_at > NOW()
           AND scheduled_at < NOW() + INTERVAL '14 days'`,
        [therapistId]
      ),
      query(
        `SELECT scheduled_at FROM booking_slot_locks
         WHERE therapist_id = $1 AND expires_at > NOW()`,
        [therapistId]
      ),
    ]);

    const schedule = scheduleResult.rows;   // [{day_of_week, start_time, end_time}]
    const booked   = new Set(bookedResult.rows.map((r) => new Date(r.scheduled_at).toISOString()));
    const locked   = new Set(lockedResult.rows.map((r) => new Date(r.scheduled_at).toISOString()));

    const slots = [];
    const now   = new Date();

    for (let d = 1; d <= 14; d++) {
      const date = new Date(now);
      date.setDate(now.getDate() + d);
      date.setHours(0, 0, 0, 0);

      const dayOfWeek = date.getDay(); // 0=Sunday
      const daySchedules = schedule.filter((s) => s.day_of_week === dayOfWeek);

      for (const slot of daySchedules) {
        // Parse HH:MM start/end
        const [sh, sm] = slot.start_time.split(':').map(Number);
        const [eh, em] = slot.end_time.split(':').map(Number);

        let cur = new Date(date);
        cur.setHours(sh, sm, 0, 0);
        const end = new Date(date);
        end.setHours(eh, em, 0, 0);

        while (cur < end) {
          const iso = cur.toISOString();
          if (cur > now && !booked.has(iso) && !locked.has(iso)) {
            slots.push(iso);
          }
          cur = new Date(cur.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);
        }
      }
    }

    return res.status(200).json({ slots });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load availability', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/slot-lock ──────────────────────────────────────────────────
// Acquires a 5-min lock on a slot. Returns 409 if taken.
router.post('/slot-lock', auth, async (req, res) => {
  const { therapist_id, scheduled_at } = req.body;
  if (!therapist_id || !scheduled_at) {
    return res.status(400).json({ error: 'therapist_id and scheduled_at are required', code: 'MISSING_FIELDS' });
  }
  try {
    const lockId    = uuidv4();
    const expiresAt = new Date(Date.now() + SLOT_LOCK_MINUTES * 60 * 1000).toISOString();
    await query(
      `INSERT INTO booking_slot_locks (id, therapist_id, scheduled_at, locked_by, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [lockId, therapist_id, scheduled_at, req.user.id, expiresAt]
    );
    return res.status(200).json({ lock_id: lockId, expires_at: expiresAt });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'This slot is already taken', code: 'SLOT_TAKEN' });
    }
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to acquire slot lock', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/consent ────────────────────────────────────────────────────
router.post('/consent', auth, async (req, res) => {
  const { consent_version } = req.body;
  if (consent_version !== THERAPY_CONSENT_VERSION) {
    return res.status(400).json({
      error: `consent_version must be "${THERAPY_CONSENT_VERSION}"`,
      code: 'INVALID_CONSENT_VERSION',
    });
  }
  try {
    const { rows } = await query(
      `UPDATE users
       SET therapy_consent_version = $1, therapy_consented_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING therapy_consented_at`,
      [THERAPY_CONSENT_VERSION, req.user.id]
    );
    return res.status(200).json({ consented_at: rows[0].therapy_consented_at });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to record consent', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/booking/quote ───────────────────────────────────────────────
// Stateless — returns the authoritative server-computed price for a session.
// Frontend must display this value; must never compute pricing independently.
// Client submits expected_client_charge_kes when creating the booking; if the
// live price has changed, the server rejects with PRICE_CHANGED so the user
// can reconfirm before payment is initiated.
router.get('/booking/quote', auth, async (req, res) => {
  const { therapist_id, duration_minutes: durationParam } = req.query;
  if (!therapist_id) {
    return res.status(400).json({ error: 'therapist_id is required', code: 'MISSING_FIELDS' });
  }
  const durationMinutes = parseInt(durationParam, 10) || 60;
  if (![45, 60].includes(durationMinutes)) {
    return res.status(400).json({ error: 'duration_minutes must be 45 or 60', code: 'INVALID_FIELDS' });
  }
  try {
    const { rows } = await query(
      'SELECT rate_per_session_kes FROM therapist_profiles WHERE id = $1 AND is_active = true AND is_verified = true AND suspended = false',
      [therapist_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Therapist not available', code: 'NOT_FOUND' });
    const pricing = await calculateTherapyPricing(rows[0].rate_per_session_kes, durationMinutes);
    return res.json({ ...pricing, duration_minutes: durationMinutes });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to compute quote', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/bookings ───────────────────────────────────────────────────
// Creates a draft booking and fires an M-Pesa STK push via IntaSend.
// No credit deducted here — only on payment webhook success.
// STK fires FIRST; booking is only inserted if STK succeeds (atomic, no orphans).
router.post('/bookings', auth, paymentLimiter, async (req, res) => {
  const {
    therapist_id, category_id, session_format,
    scheduled_at, duration_minutes = 60,
    lock_id, phone, notes,
    expected_client_charge_kes,
  } = req.body;

  if (!therapist_id || !category_id || !session_format || !scheduled_at || !lock_id || !phone) {
    return res.status(400).json({
      error: 'therapist_id, category_id, session_format, scheduled_at, lock_id, and phone are required',
      code: 'MISSING_FIELDS',
    });
  }

  if (!['video', 'in_person'].includes(session_format)) {
    return res.status(400).json({ error: 'session_format must be video or in_person', code: 'INVALID_FORMAT' });
  }

  try {
    // Therapy consent check
    const { rows: userRows } = await query(
      'SELECT therapy_consent_version, email FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
    if (userRows[0].therapy_consent_version !== THERAPY_CONSENT_VERSION) {
      return res.status(403).json({ error: 'Therapy consent required', code: 'THERAPY_CONSENT_REQUIRED' });
    }

    // Verify slot lock belongs to this user and is still valid
    const { rows: lockRows } = await query(
      `SELECT id FROM booking_slot_locks
       WHERE id = $1 AND therapist_id = $2 AND scheduled_at = $3
         AND locked_by = $4 AND expires_at > NOW()`,
      [lock_id, therapist_id, scheduled_at, req.user.id]
    );
    if (!lockRows.length) {
      return res.status(409).json({ error: 'Slot lock expired or invalid', code: 'LOCK_INVALID' });
    }

    // Fetch therapist rate and compute authoritative pricing server-side
    const { rows: tpRows } = await query(
      'SELECT rate_per_session_kes FROM therapist_profiles WHERE id = $1 AND is_active = true AND is_verified = true AND suspended = false',
      [therapist_id]
    );
    if (!tpRows.length) return res.status(404).json({ error: 'Therapist not available', code: 'NOT_FOUND' });

    const pricing = await calculateTherapyPricing(tpRows[0].rate_per_session_kes, duration_minutes);
    const { clientChargeKes, platformFeeKes, therapistPayoutKes, therapistRateKes, feeRateBps } = pricing;

    // If client sent an expected price and it no longer matches, reject so they can reconfirm
    if (expected_client_charge_kes != null && expected_client_charge_kes !== clientChargeKes) {
      return res.status(409).json({
        error: 'Session price has changed. Please review the new price and confirm to proceed.',
        code:  'PRICE_CHANGED',
        client_charge_kes: clientChargeKes,
      });
    }

    const bookingId      = uuidv4();
    const draftExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10-minute payment window

    // 1. Fire payment FIRST — if it fails, no booking is created (clean state)
    const { reference: paymentReference, checkoutUrl } = await initiatePayment({
      amount:    clientChargeKes,
      phone,
      email:     userRows[0].email,
      bookingId,
    });

    // 2. Atomically insert draft with payment_reference already populated
    await query(
      `INSERT INTO therapist_bookings
         (id, member_user_id, therapist_id, category_id, session_format,
          scheduled_at, duration_minutes,
          rate_kes, platform_fee_kes, therapist_payout_kes,
          therapist_rate_kes, client_charge_kes, fee_rate_bps,
          status, payment_status, escrow_status, credit_charged, notes, idempotency_key,
          payment_reference, expires_at, slot_lock_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'draft','unpaid','held',0,$14,$15,$16,$17,$18)`,
      [
        bookingId, req.user.id, therapist_id, category_id, session_format,
        scheduled_at, duration_minutes,
        clientChargeKes, platformFeeKes, therapistPayoutKes,
        therapistRateKes, clientChargeKes, feeRateBps,
        notes || null, bookingId, paymentReference, draftExpiresAt, lock_id,
      ]
    );

    return res.status(201).json({
      booking_id:   bookingId,
      expires_at:   draftExpiresAt.toISOString(),
      // checkoutUrl present only for redirect-based providers (Paystack)
      ...(checkoutUrl ? { checkout_url: checkoutUrl } : {}),
    });
  } catch (err) {
    logger.error({ err }, err.message);
    if (err.message.includes('IntaSend') || err.message.includes('Paystack')) {
      return res.status(502).json({ error: 'Payment initiation failed. Please try again.', code: 'PAYMENT_ERROR' });
    }
    return res.status(500).json({ error: 'Failed to create booking', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/payment-webhook ───────────────────────────────────────────
// Public — called by IntaSend (challenge) or Paystack (HMAC-SHA512).
// Respond 200 immediately, process async. rawBody available via express.json verify callback.
router.post('/payment-webhook', async (req, res) => {
  // Always acknowledge immediately so the provider doesn't retry on our processing time
  res.status(200).json({ received: true });

  let event;
  try {
    // req.rawBody is a Buffer captured by express.json({ verify }) in app.js
    const rawBody = req.rawBody;
    if (!rawBody) throw new Error('rawBody not available — check express.json verify callback');
    event = verifyWebhook(rawBody, req.headers);
  } catch (err) {
    logger.error({ err }, err.message);
    return;
  }

  if (!event.success) {
    // Payment failed or cancelled — mark payment_status=failed so UI can show retry
    await query(
      `UPDATE therapist_bookings SET payment_status = 'failed', updated_at = NOW()
       WHERE payment_reference = $1 AND status = 'draft'`,
      [event.reference]
    ).catch(e => logger.error(e.message));
    return;
  }

  // Atomically promote draft → pending; WHERE status='draft' acts as idempotency guard
  // (duplicate webhook fires find no rows and exit cleanly)
  const { rows } = await query(
    `UPDATE therapist_bookings
       SET status = 'pending', payment_status = 'paid', credit_charged = 1,
           expires_at = NULL, updated_at = NOW()
     WHERE payment_reference = $1 AND status = 'draft'
     RETURNING id, member_user_id, therapist_id, scheduled_at, session_format, slot_lock_id`,
    [event.reference]
  ).catch(e => {
    logger.error(e.message);
    return { rows: [] };
  });

  if (!rows.length) {
    // Either already promoted (duplicate webhook) or reference not found — both are fine
    return;
  }
  const b = rows[0];
  logger.info(`[therapy.payment-webhook] Promoted booking ${b.id} to pending (ref=${event.reference})`);

  // Release the slot lock held during the payment window
  if (b.slot_lock_id) {
    await query('DELETE FROM booking_slot_locks WHERE id = $1', [b.slot_lock_id])
      .catch(e => logger.error(e.message));
  }

  // Deduct 1 credit — after status is already 'pending', so a failed deduction
  // leaves the booking promoted but credit undeducted (flag for reconciliation)
  const creditOk = await deductCredit(b.member_user_id, 1, null, 'therapy_booking').then(() => true).catch(e => {
    logger.error('[therapy.payment-webhook.credit] RECONCILIATION NEEDED booking=%s err=%s', b.id, e.message);
    return false;
  });

  // Notify member
  await notifyUser(b.member_user_id, 'therapist_update', {
    message: 'Payment confirmed! Your booking is awaiting therapist approval.',
  });

  // Notify therapist (in-app + push)
  const { rows: tpRows } = await query(
    'SELECT user_id, fcm_token FROM therapist_profiles WHERE id = $1', [b.therapist_id]
  ).catch(() => ({ rows: [] }));

  if (tpRows.length) {
    const { rows: mRows } = await query('SELECT alias FROM users WHERE id = $1', [b.member_user_id])
      .catch(() => ({ rows: [{ alias: 'a member' }] }));
    const msgBody = `New booking from ${mRows[0]?.alias ?? 'a member'}. Session: ${new Date(b.scheduled_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })} (${b.session_format}).`;
    await notifyUser(tpRows[0].user_id, 'therapist_update', { message: msgBody });
    if (tpRows[0].fcm_token) {
      enqueuePushNotification(tpRows[0].fcm_token, 'New Booking', msgBody, { type: 'therapist_update' }).catch(() => {});
    }
  }
});

// ─── POST /therapy/bookings/:id/retry-payment ─────────────────────────────────
// Member retriggers STK push on their own draft booking (e.g. missed the first prompt).
router.post('/bookings/:id/retry-payment', auth, paymentLimiter, async (req, res) => {
  const bookingId = req.params.id;
  const { phone } = req.body; // member may supply a different number for retry
  try {
    const { rows } = await query(
      `SELECT b.id, COALESCE(b.client_charge_kes, b.rate_kes) AS charge_kes,
              b.slot_lock_id, sl.expires_at AS lock_expires_at,
              u.email, u.phone
       FROM therapist_bookings b
       JOIN users u ON u.id = b.member_user_id
       LEFT JOIN booking_slot_locks sl ON sl.id = b.slot_lock_id
       WHERE b.id = $1 AND b.member_user_id = $2 AND b.status = 'draft'`,
      [bookingId, req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Draft booking not found', code: 'NOT_FOUND' });
    }
    const b = rows[0];

    // lock_expires_at is null when lock was already consumed (LEFT JOIN miss) — treat as still valid
    if (b.lock_expires_at !== null && new Date(b.lock_expires_at) < new Date()) {
      return res.status(410).json({ error: 'Booking slot has expired — please rebook', code: 'BOOKING_EXPIRED' });
    }

    const stkPhone = phone || b.phone;
    if (!stkPhone) {
      return res.status(400).json({ error: 'Phone number required for retry', code: 'MISSING_FIELDS' });
    }

    const { reference: paymentReference, checkoutUrl } = await initiatePayment({
      amount:    b.charge_kes,
      phone:     stkPhone,
      email:     b.email,
      bookingId,
    });

    // Update payment_reference so new STK invoice is tracked
    await query(
      'UPDATE therapist_bookings SET payment_reference = $1, payment_status = $2, updated_at = NOW() WHERE id = $3',
      [paymentReference, 'unpaid', bookingId]
    );

    return res.status(200).json({
      booking_id: bookingId,
      ...(checkoutUrl ? { checkout_url: checkoutUrl } : {}),
    });
  } catch (err) {
    logger.error({ err }, err.message);
    if (err.message.includes('IntaSend') || err.message.includes('Paystack')) {
      return res.status(502).json({ error: 'Payment initiation failed. Please try again.', code: 'PAYMENT_ERROR' });
    }
    return res.status(500).json({ error: 'Failed to retry payment', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/bookings/drafts ─────────────────────────────────────────────
// Returns the member's current draft bookings with slot lock countdown.
router.get('/bookings/drafts', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.id, b.therapist_id, b.scheduled_at, b.session_format, b.rate_kes,
              b.expires_at, b.payment_status,
              tp.display_name AS therapist_display_name,
              tp.photo_url    AS therapist_photo_url,
              sl.expires_at   AS slot_expires_at
       FROM therapist_bookings b
       JOIN therapist_profiles tp ON tp.id = b.therapist_id
       LEFT JOIN booking_slot_locks sl ON sl.id = b.slot_lock_id
       WHERE b.member_user_id = $1 AND b.status = 'draft'
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    return res.status(200).json({ drafts: rows });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to fetch drafts', code: 'QUERY_ERROR' });
  }
});


// ─── POST /therapy/b2c-callback ───────────────────────────────────────────────
// Public — Daraja B2C result callback for therapist payouts.
router.post('/b2c-callback', async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  let parsed;
  try {
    parsed = parseB2CCallback(req.body);
  } catch (err) {
    logger.error({ err }, err.message);
    return;
  }

  const { success, idempotencyKey, mpesaReference } = parsed;

  if (success) {
    await query(
      `UPDATE therapist_payouts
       SET status = 'completed', completed_at = NOW(), mpesa_reference = $1, updated_at = NOW()
       WHERE idempotency_key = $2`,
      [mpesaReference, idempotencyKey]
    ).catch((e) => logger.error(e.message));
  } else {
    await query(
      `UPDATE therapist_payouts
       SET status = 'failed', updated_at = NOW()
       WHERE idempotency_key = $1 AND status = 'processing'`,
      [idempotencyKey]
    ).catch((e) => logger.error(e.message));
  }
});

// ─── PATCH /therapy/bookings/:id/confirm ─────────────────────────────────────
router.patch('/bookings/:id/confirm', therapistAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE therapist_bookings
       SET status = 'confirmed', updated_at = NOW()
       WHERE id = $1 AND therapist_id = $2 AND status = 'pending' AND payment_status = 'paid'
       RETURNING member_user_id, scheduled_at, session_format`,
      [req.params.id, req.therapist.profile_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Booking not found or not confirmable', code: 'NOT_FOUND' });
    }
    const b = rows[0];
    await notifyUser(b.member_user_id, 'therapist_update', {
      message: `Your therapy session is confirmed for ${new Date(b.scheduled_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })} (${b.session_format}).`,
    });
    return res.status(200).json({ confirmed_at: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to confirm booking', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /therapy/bookings/:id/decline ─────────────────────────────────────
router.patch('/bookings/:id/decline', therapistAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE therapist_bookings
       SET status = 'cancelled', cancelled_by = 'therapist',
           cancellation_reason = 'therapist_declined', updated_at = NOW()
       WHERE id = $1 AND therapist_id = $2 AND status IN ('pending','confirmed')
       RETURNING id, member_user_id`,
      [req.params.id, req.therapist.profile_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found', code: 'NOT_FOUND' });

    await issueFullRefund(rows[0].id).catch((e) => logger.error(e.message));
    await notifyUser(rows[0].member_user_id, 'therapist_update', {
      message: 'Your booking was declined by the therapist. A full refund has been issued.',
    });

    // Flag therapist if second decline within 30 days
    const { rows: recentDeclines } = await query(
      `SELECT COUNT(*) AS cnt FROM therapist_bookings
       WHERE therapist_id = $1 AND cancelled_by = 'therapist'
         AND cancellation_reason = 'therapist_declined'
         AND updated_at > NOW() - INTERVAL '30 days'`,
      [req.therapist.profile_id]
    );
    if (parseInt(recentDeclines[0].cnt) >= 2) {
      logger.warn('[therapy.decline] Therapist flagged — 2+ declines in 30 days:', req.therapist.profile_id);
      // Admin notification via notifications to all admins would go here
    }

    return res.status(200).json({ declined: true });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to decline booking', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /therapy/bookings/:id/cancel ──────────────────────────────────────
// Member cancellation policy:
//   >24hr + fewer than 2 cancellations in 30 days → full credit refund to platform balance
//   >24hr + repeat canceller (2+ in 30 days)       → no refund
//   <24hr or no-show                                → no refund
//   Refunds are always platform credit — no M-Pesa reversals.
router.patch('/bookings/:id/cancel', auth, async (req, res) => {
  try {
    const { rows: bookingRows } = await query(
      `SELECT id, therapist_id, scheduled_at, payment_status, credit_charged
       FROM therapist_bookings
       WHERE id = $1 AND member_user_id = $2 AND status IN ('pending','confirmed')`,
      [req.params.id, req.user.id]
    );
    if (!bookingRows.length) return res.status(404).json({ error: 'Booking not found', code: 'NOT_FOUND' });

    const b = bookingRows[0];
    const hoursUntil = (new Date(b.scheduled_at) - Date.now()) / (1000 * 60 * 60);

    // Count member's cancellations in the last 30 days
    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS cnt FROM therapist_bookings
       WHERE member_user_id = $1 AND cancelled_by = 'member'
         AND updated_at > NOW() - INTERVAL '30 days'`,
      [req.user.id]
    );
    const recentCancellations = parseInt(countRows[0].cnt);
    const isRepeatCanceller = recentCancellations >= 2;

    // Determine refund eligibility
    const eligibleForRefund = hoursUntil > 24 && !isRepeatCanceller;

    const cancellationReason = hoursUntil <= 24
      ? 'late_cancellation'
      : isRepeatCanceller
        ? 'repeat_cancellation'
        : 'member_cancelled';

    await query(
      `UPDATE therapist_bookings
       SET status = 'cancelled', cancelled_by = 'member',
           cancellation_reason = $1, updated_at = NOW()
       WHERE id = $2`,
      [cancellationReason, b.id]
    );

    if (eligibleForRefund && b.credit_charged > 0) {
      await refundCredit(req.user.id, b.credit_charged, null, 'therapy_booking_cancel').catch(
        (e) => logger.error(e.message)
      );
    }

    // Notify therapist
    const { rows: tpRows } = await query('SELECT user_id FROM therapist_profiles WHERE id = $1', [b.therapist_id]);
    if (tpRows.length) {
      await notifyUser(tpRows[0].user_id, 'therapist_update', {
        message: `A member cancelled their booking for ${new Date(b.scheduled_at).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}.`,
      });
    }

    return res.status(200).json({
      cancelled: true,
      credit_refunded: eligibleForRefund,
      refund_reason: eligibleForRefund
        ? 'Credit restored to your PeerPal balance.'
        : hoursUntil <= 24
          ? 'Cancellations within 24 hours are non-refundable.'
          : 'Refund not issued — you have had 2 or more cancellations in the last 30 days.',
    });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to cancel booking', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/bookings ────────────────────────────────────────────────────
router.get('/bookings', auth, async (req, res) => {
  try {
    const { status } = req.query;
    const conditions = ['b.member_user_id = $1'];
    const params = [req.user.id];
    let idx = 2;

    if (status) { params.push(status); conditions.push(`b.status = $${idx++}`); }

    const { rows } = await query(
      `SELECT b.id, b.therapist_id, b.category_id, b.session_format, b.scheduled_at,
              b.duration_minutes, b.rate_kes, b.status, b.payment_status, b.escrow_status,
              b.cancellation_reason, b.credit_charged, b.created_at,
              tp.display_name AS therapist_display_name, tp.photo_url AS therapist_photo_url,
              tc.name AS category_name,
              ts.duration_billed_minutes,
              tr.rating, tr.comment AS rating_comment
       FROM therapist_bookings b
       JOIN therapist_profiles tp ON tp.id = b.therapist_id
       JOIN therapist_categories tc ON tc.id = b.category_id
       LEFT JOIN therapy_sessions ts ON ts.booking_id = b.id
       LEFT JOIN therapist_ratings tr ON tr.booking_id = b.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY b.scheduled_at DESC`,
      params
    );
    return res.status(200).json({ bookings: rows });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load bookings', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/bookings/stats ──────────────────────────────────────────────
router.get('/bookings/stats', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE b.status = 'completed')                         AS total_sessions,
         COALESCE(SUM(ts.duration_billed_minutes) FILTER (WHERE b.status = 'completed'), 0) AS total_minutes_billed,
         COUNT(DISTINCT b.therapist_id) FILTER (WHERE b.status = 'completed')   AS therapists_seen,
         COUNT(*) FILTER (WHERE b.status IN ('cancelled','member_no_show'))      AS cancellations,
         MIN(b.scheduled_at) FILTER (WHERE b.status = 'completed')              AS first_session_at,
         MAX(b.scheduled_at) FILTER (WHERE b.status = 'completed')              AS last_session_at
       FROM therapist_bookings b
       LEFT JOIN therapy_sessions ts ON ts.booking_id = b.id
       WHERE b.member_user_id = $1`,
      [req.user.id]
    );
    const r = rows[0];
    return res.status(200).json({
      total_sessions:      Number(r.total_sessions),
      total_hours_billed:  +(Number(r.total_minutes_billed) / 60).toFixed(1),
      therapists_seen:     Number(r.therapists_seen),
      cancellations:       Number(r.cancellations),
      first_session_at:    r.first_session_at,
      last_session_at:     r.last_session_at,
    });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load stats', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/bookings/:id ────────────────────────────────────────────────
// Member: full booking view. Therapist: includes member alias + notes.
router.get('/bookings/:id', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.id, b.member_user_id, b.therapist_id, b.category_id, b.session_format,
              b.scheduled_at, b.duration_minutes, b.rate_kes, b.platform_fee_kes,
              b.status, b.payment_status, b.escrow_status, b.cancellation_reason,
              b.credit_charged, b.notes, b.created_at,
              tp.display_name AS therapist_display_name, tp.photo_url AS therapist_photo_url,
              tp.credentials AS therapist_credentials,
              u.alias AS member_alias
       FROM therapist_bookings b
       JOIN therapist_profiles tp ON tp.id = b.therapist_id
       JOIN users u ON u.id = b.member_user_id
       WHERE b.id = $1 AND b.member_user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found', code: 'NOT_FOUND' });
    return res.status(200).json({ booking: rows[0] });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load booking', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/sessions/start ────────────────────────────────────────────
// Therapist starts the session. Generates TURN credentials and encrypted tokens.
router.post('/sessions/start', therapistAuth, async (req, res) => {
  const { booking_id } = req.body;
  if (!booking_id) return res.status(400).json({ error: 'booking_id is required', code: 'MISSING_FIELDS' });

  try {
    // Verify booking belongs to this therapist and is confirmed within 15min window
    const { rows: bookingRows } = await query(
      `SELECT id, member_user_id, scheduled_at FROM therapist_bookings
       WHERE id = $1 AND therapist_id = $2 AND status = 'confirmed'
         AND scheduled_at BETWEEN NOW() - INTERVAL '15 minutes' AND NOW() + INTERVAL '15 minutes'`,
      [booking_id, req.therapist.profile_id]
    );
    if (!bookingRows.length) {
      return res.status(403).json({
        error: 'Booking not found, not confirmed, or outside the 15-minute start window',
        code: 'START_WINDOW_INVALID',
      });
    }

    // Close any other in_progress bookings for this therapist — prevents concurrent sessions
    await query(
      `UPDATE therapy_sessions SET ended_at = NOW()
       WHERE booking_id IN (
         SELECT id FROM therapist_bookings
         WHERE therapist_id = $1 AND status = 'in_progress' AND id != $2
       ) AND ended_at IS NULL`,
      [req.therapist.profile_id, booking_id]
    );
    await query(
      `UPDATE therapist_bookings SET status = 'cancelled', updated_at = NOW()
       WHERE therapist_id = $1 AND status = 'in_progress' AND id != $2`,
      [req.therapist.profile_id, booking_id]
    );

    // Check session not already started
    const { rows: existing } = await query(
      'SELECT id FROM therapy_sessions WHERE booking_id = $1',
      [booking_id]
    );
    if (existing.length) return res.status(409).json({ error: 'Session already started', code: 'ALREADY_STARTED' });

    const sessionId         = uuidv4();
    const rawTokenMember    = uuidv4();
    const rawTokenTherapist = uuidv4();
    const encTokenMember    = encrypt(rawTokenMember);
    const encTokenTherapist = encrypt(rawTokenTherapist);

    await query(
      `INSERT INTO therapy_sessions
         (id, booking_id, room_token_member, room_token_therapist, started_at, therapist_joined_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [sessionId, booking_id, encTokenMember, encTokenTherapist]
    );

    await query(
      `UPDATE therapist_bookings SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
      [booking_id]
    );

    // Notify member so their booking list refreshes and Join button appears
    await notifyUser(bookingRows[0].member_user_id, 'therapy_session_reminder', {
      booking_id,
      message: 'Your therapist has started the session. Tap to join.',
    });

    const turnCredentials = await getTurnCredentialsWithFallback();

    return res.status(200).json({
      session_id:              sessionId,
      room_token_therapist:    rawTokenTherapist,
      turn_credentials:        turnCredentials,
    });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to start session', code: 'QUERY_ERROR' });
  }
});

// Member joins an in-progress session. Idempotent — member_joined_at is recorded by WS.
router.get('/sessions/:booking_id/join', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT ts.id, ts.room_token_member
       FROM therapy_sessions ts
       JOIN therapist_bookings b ON b.id = ts.booking_id
       WHERE ts.booking_id = $1 AND b.member_user_id = $2 AND b.status = 'in_progress'`,
      [req.params.booking_id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Session not found or not in progress', code: 'NOT_FOUND' });

    const session = rows[0];
    if (!session.room_token_member) {
      return res.status(410).json({ error: 'Session token not available', code: 'TOKEN_UNAVAILABLE' });
    }

    const rawToken = decrypt(session.room_token_member);
    const turnCredentials = await getTurnCredentialsWithFallback();

    return res.status(200).json({
      session_id:       session.id,
      room_token:       rawToken,
      turn_credentials: turnCredentials,
    });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to join session', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/sessions/:id/end ──────────────────────────────────────────
router.post('/sessions/:id/end', therapistAuth, async (req, res) => {
  try {
    const { rows: sessionRows } = await query(
      `SELECT ts.id, ts.booking_id, ts.started_at, ts.therapist_joined_at, ts.member_joined_at
       FROM therapy_sessions ts
       JOIN therapist_bookings b ON b.id = ts.booking_id
       WHERE ts.id = $1 AND b.therapist_id = $2 AND b.status = 'in_progress'`,
      [req.params.id, req.therapist.profile_id]
    );
    if (!sessionRows.length) return res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });

    const session = sessionRows[0];

    // Member never joined — treat as therapist no-show of the other kind:
    // room opened but member wasn't there. Refund credit, revert booking, notify member.
    if (!session.member_joined_at) {
      await query(
        `UPDATE therapy_sessions SET ended_at = NOW(), duration_billed_minutes = 0 WHERE id = $1`,
        [session.id]
      );
      const { rows: bk } = await query(
        'SELECT member_user_id, credit_charged FROM therapist_bookings WHERE id = $1',
        [session.booking_id]
      );
      await query(
        `UPDATE therapist_bookings
         SET status = 'cancelled', escrow_status = 'refunded',
             cancellation_reason = 'member_did_not_join', updated_at = NOW()
         WHERE id = $1`,
        [session.booking_id]
      );
      if (bk[0]?.credit_charged > 0) {
        await refundCredit(bk[0].member_user_id, bk[0].credit_charged, null, 'therapy_booking');
      }
      await notifyUser(bk[0]?.member_user_id, 'therapy_dispute_update', {
        booking_id: session.booking_id,
        message: 'Your session was cancelled — you did not join in time. Your credit has been refunded.',
      });
      return res.status(200).json({ ended: true, reason: 'member_did_not_join', credit_refunded: true });
    }

    const now = new Date();
    const startedAt = new Date(session.member_joined_at);
    const durationBilled = Math.floor((now - startedAt) / (1000 * 60));

    await query(
      `UPDATE therapy_sessions SET ended_at = NOW(), duration_billed_minutes = $1 WHERE id = $2`,
      [durationBilled, session.id]
    );

    const { rows: bookingRows } = await query(
      'SELECT duration_minutes, member_user_id FROM therapist_bookings WHERE id = $1',
      [session.booking_id]
    );
    const { duration_minutes, member_user_id } = bookingRows[0];
    const isFullSession = durationBilled >= duration_minutes * 0.8;

    if (isFullSession) {
      await query(
        `UPDATE therapist_bookings
         SET status = 'completed', escrow_status = 'held', updated_at = NOW()
         WHERE id = $1`,
        [session.booking_id]
      );
    } else {
      await query(
        `UPDATE therapist_bookings
         SET status = 'completed', escrow_status = 'held',
             cancellation_reason = 'partial_session', updated_at = NOW()
         WHERE id = $1`,
        [session.booking_id]
      );
      logger.warn('[therapy.sessions.end] Partial session:', session.booking_id, durationBilled, 'min');
    }

    await query(
      `UPDATE therapist_profiles SET total_sessions = total_sessions + 1, updated_at = NOW()
       WHERE id = $1`,
      [req.therapist.profile_id]
    );

    // Post-session prompts
    await notifyUser(member_user_id, 'therapist_update', {
      message: 'Your session has ended. How did it go? Rate your therapist to help others.',
      booking_id: session.booking_id,
    });
    await notifyUser(req.therapist.user_id, 'therapist_update', {
      message: 'Session ended. Add your session notes while they are fresh.',
      booking_id: session.booking_id,
    });

    return res.status(200).json({
      ended: true,
      duration_billed_minutes: durationBilled,
      full_session: isFullSession,
    });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to end session', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/sessions/:booking_id/quick-reply ──────────────────────────
// Member sends a quick-reply chip from the waiting screen. Relayed to therapist WS.
router.post('/sessions/:booking_id/quick-reply', auth, async (req, res) => {
  const { booking_id } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required', code: 'MISSING_FIELDS' });

  // Verify this booking belongs to the requesting member and is in_progress
  const { rows } = await query(
    `SELECT id FROM therapist_bookings WHERE id = $1 AND member_user_id = $2 AND status = 'in_progress'`,
    [booking_id, req.user.id]
  ).catch(() => ({ rows: [] }));
  if (!rows.length) return res.status(403).json({ error: 'Booking not found or not in progress', code: 'NOT_FOUND' });

  const room = therapyRooms.get(booking_id);
  const ws = room?.therapist;
  if (ws?.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify({ type: 'quick_reply', text }));
  }
  return res.status(200).json({ delivered: ws?.readyState === 1 });
});

// ─── POST /therapy/ratings ────────────────────────────────────────────────────
router.post('/ratings', auth, async (req, res) => {
  const { booking_id, rating, comment } = req.body;

  if (!booking_id || !rating) {
    return res.status(400).json({ error: 'booking_id and rating are required', code: 'MISSING_FIELDS' });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be an integer 1–5', code: 'INVALID_RATING' });
  }

  try {
    // Verify completed booking belongs to member
    const { rows: bookingRows } = await query(
      `SELECT b.therapist_id, b.member_user_id FROM therapist_bookings b
       WHERE b.id = $1 AND b.member_user_id = $2 AND b.status = 'completed'`,
      [booking_id, req.user.id]
    );
    if (!bookingRows.length) {
      return res.status(404).json({ error: 'Completed booking not found', code: 'NOT_FOUND' });
    }
    const { therapist_id } = bookingRows[0];

    // Insert rating (UNIQUE on booking_id enforced by DB)
    const { rows: ratingRows } = await query(
      `INSERT INTO therapist_ratings (booking_id, member_user_id, therapist_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [booking_id, req.user.id, therapist_id, rating, comment?.trim() || null]
    );

    // Recompute Bayesian average
    const { rows: aggRows } = await query(
      `SELECT COUNT(*) AS cnt, AVG(rating) AS avg_rating
       FROM therapist_ratings WHERE therapist_id = $1 AND flagged = false`,
      [therapist_id]
    );
    const cnt = parseInt(aggRows[0].cnt);
    const sumRatings = parseFloat(aggRows[0].avg_rating) * cnt;
    const newAvg = (BAYESIAN_C * BAYESIAN_MEAN + sumRatings) / (BAYESIAN_C + cnt);

    await query(
      `UPDATE therapist_profiles
       SET average_rating = $1, total_ratings_count = $2, updated_at = NOW()
       WHERE id = $3`,
      [newAvg.toFixed(4), cnt, therapist_id]
    );

    return res.status(201).json({ rating_id: ratingRows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You have already rated this session', code: 'ALREADY_RATED' });
    }
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to submit rating', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/session-notes ─────────────────────────────────────────────
// Therapist only — member cannot access this endpoint or data.
router.post('/session-notes', therapistAuth, async (req, res) => {
  const { booking_id, content, note_type = 'session' } = req.body;
  if (!booking_id || !content?.trim()) {
    return res.status(400).json({ error: 'booking_id and content are required', code: 'MISSING_FIELDS' });
  }
  if (!['pre', 'session', 'follow_up'].includes(note_type)) {
    return res.status(400).json({ error: 'Invalid note_type', code: 'INVALID_NOTE_TYPE' });
  }
  try {
    const { rows: bookingRows } = await query(
      'SELECT id FROM therapist_bookings WHERE id = $1 AND therapist_id = $2',
      [booking_id, req.therapist.profile_id]
    );
    if (!bookingRows.length) return res.status(404).json({ error: 'Booking not found', code: 'NOT_FOUND' });

    const { rows } = await query(
      `INSERT INTO therapy_session_notes (booking_id, therapist_id, content, note_type)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [booking_id, req.therapist.profile_id, content.trim(), note_type]
    );
    return res.status(200).json({ saved: true, id: rows[0].id });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to save notes', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/disputes ───────────────────────────────────────────────────
router.post('/disputes', auth, async (req, res) => {
  const { booking_id, reason } = req.body;
  if (!booking_id || !reason?.trim()) {
    return res.status(400).json({ error: 'booking_id and reason are required', code: 'MISSING_FIELDS' });
  }
  try {
    // Booking must be completed within 24hrs and belong to member
    const { rows: bookingRows } = await query(
      `SELECT b.id, b.therapist_id, ts.ended_at
       FROM therapist_bookings b
       JOIN therapy_sessions ts ON ts.booking_id = b.id
       WHERE b.id = $1 AND b.member_user_id = $2 AND b.status = 'completed'
         AND ts.ended_at > NOW() - INTERVAL '${DISPUTE_WINDOW_HOURS} hours'`,
      [booking_id, req.user.id]
    );
    if (!bookingRows.length) {
      return res.status(403).json({
        error: `Disputes must be raised within ${DISPUTE_WINDOW_HOURS} hours of session end`,
        code: 'DISPUTE_WINDOW_CLOSED',
      });
    }

    // Check no existing open dispute
    const { rows: existingRows } = await query(
      `SELECT id FROM therapy_disputes WHERE booking_id = $1 AND status = 'open'`,
      [booking_id]
    );
    if (existingRows.length) {
      return res.status(409).json({ error: 'A dispute is already open for this session', code: 'DISPUTE_EXISTS' });
    }

    const disputeId = uuidv4();
    await query(
      `INSERT INTO therapy_disputes (id, booking_id, raised_by, raised_by_role, reason)
       VALUES ($1, $2, $3, 'member', $4)`,
      [disputeId, booking_id, req.user.id, reason.trim()]
    );

    // Freeze escrow
    await query(
      `UPDATE therapist_bookings SET escrow_status = 'disputed', updated_at = NOW() WHERE id = $1`,
      [booking_id]
    );

    // Freeze any pending payout
    await query(
      `UPDATE therapist_payouts SET status = 'pending', updated_at = NOW()
       WHERE booking_id = $1 AND status IN ('processing','pending')`,
      [booking_id]
    ).catch(() => {});

    logger.warn('[therapy.disputes] New dispute raised — admin alert needed:', disputeId);

    return res.status(201).json({ dispute_id: disputeId });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to raise dispute', code: 'QUERY_ERROR' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// THERAPIST-SIDE ENDPOINTS  (all require therapistAuth)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /therapy/therapist/dashboard ────────────────────────────────────────
router.get('/therapist/dashboard', therapistAuth, async (req, res) => {
  const therapistId = req.therapist.profile_id;
  try {
    const now = new Date().toISOString();
    const in7Days = new Date(Date.now() + 7 * 86400000).toISOString();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();

    const [upcomingRes, pendingRes, earningsRes, profileRes] = await Promise.all([
      query(
        `SELECT b.id, b.scheduled_at, b.session_format, b.duration_minutes, b.status,
                u.alias AS member_alias,
                (SELECT COUNT(*) FROM therapist_bookings
                 WHERE member_user_id = b.member_user_id AND therapist_id = $1
                 AND status = 'completed' AND scheduled_at < b.scheduled_at)::int AS prior_sessions_count
         FROM therapist_bookings b
         JOIN users u ON u.id = b.member_user_id
         WHERE b.therapist_id = $1
           AND b.status IN ('confirmed','in_progress')
           AND b.scheduled_at BETWEEN $2 AND $3
         ORDER BY b.scheduled_at ASC
         LIMIT 20`,
        [therapistId, now, in7Days]
      ),
      query(
        `SELECT b.id, b.scheduled_at, b.session_format, b.duration_minutes,
                u.alias AS member_alias
         FROM therapist_bookings b
         JOIN users u ON u.id = b.member_user_id
         WHERE b.therapist_id = $1 AND b.status = 'pending'
         ORDER BY b.created_at ASC`,
        [therapistId]
      ),
      query(
        `SELECT COALESCE(SUM(therapist_payout_kes), 0) AS month_earnings
         FROM therapist_bookings
         WHERE therapist_id = $1 AND status = 'completed' AND scheduled_at >= $2`,
        [therapistId, monthStart]
      ),
      query(
        `SELECT average_rating, total_sessions, total_ratings_count
         FROM therapist_profiles WHERE id = $1`,
        [therapistId]
      ),
    ]);

    const todayEnd = new Date(now);
    todayEnd.setUTCHours(23, 59, 59, 999);
    const upcomingToday = upcomingRes.rows.filter(s =>
      new Date(s.scheduled_at) <= todayEnd
    ).length;

    return res.json({
      upcoming_sessions: upcomingRes.rows,
      pending_requests:  pendingRes.rows,
      upcoming_today:    upcomingToday,
      earnings_this_month_kes: parseFloat(earningsRes.rows[0].month_earnings),
      average_rating:    profileRes.rows[0]?.average_rating ?? null,
      total_sessions:    profileRes.rows[0]?.total_sessions ?? 0,
      total_ratings_count: profileRes.rows[0]?.total_ratings_count ?? 0,
    });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load dashboard', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapist/bookings ─────────────────────────────────────────
router.get('/therapist/bookings', therapistAuth, async (req, res) => {
  const therapistId = req.therapist.profile_id;
  const { status, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions = ["b.therapist_id = $1", "b.status != 'draft'"];
  const params = [therapistId];
  let idx = 2;

  if (status) {
    const allowed = ['pending','confirmed','completed','cancelled','in_progress'];
    const statuses = status.split(',').filter(s => allowed.includes(s));
    if (statuses.length) {
      params.push(statuses);
      conditions.push(`b.status = ANY($${idx++})`);
    }
  }

  try {
    const { rows } = await query(
      `SELECT b.id, b.scheduled_at, b.session_format, b.duration_minutes,
              b.status, b.payment_status, b.notes AS member_notes,
              b.cancellation_reason, b.created_at,
              u.alias AS member_alias,
              (SELECT COUNT(*) FROM therapist_bookings
               WHERE member_user_id = b.member_user_id AND therapist_id = $1
               AND status = 'completed' AND scheduled_at < b.scheduled_at)::int AS prior_sessions_count
       FROM therapist_bookings b
       JOIN users u ON u.id = b.member_user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY b.scheduled_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), offset]
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) AS total FROM therapist_bookings b WHERE ${conditions.join(' AND ')}`,
      params
    );

    return res.json({
      bookings: rows,
      total: parseInt(countRows[0].total),
      page: parseInt(page),
      total_pages: Math.ceil(parseInt(countRows[0].total) / parseInt(limit)),
    });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load bookings', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapist/availability ─────────────────────────────────────
router.get('/therapist/availability', therapistAuth, async (req, res) => {
  const therapistId = req.therapist.profile_id;
  try {
    const [availRes, bookingsRes] = await Promise.all([
      query(
        `SELECT id, day_of_week, start_time, end_time, is_active
         FROM therapist_availability WHERE therapist_id = $1
         ORDER BY day_of_week, start_time`,
        [therapistId]
      ),
      query(
        `SELECT b.id, b.scheduled_at, b.duration_minutes, b.status, b.session_format,
                u.alias AS member_alias,
                (SELECT COUNT(*) FROM therapist_bookings
                 WHERE member_user_id = b.member_user_id AND therapist_id = $1
                 AND status = 'completed' AND scheduled_at < b.scheduled_at)::int AS prior_sessions_count
         FROM therapist_bookings b
         JOIN users u ON u.id = b.member_user_id
         WHERE b.therapist_id = $1
           AND b.status IN ('confirmed','in_progress')
           AND b.scheduled_at >= NOW()
           AND b.scheduled_at <= NOW() + INTERVAL '28 days'`,
        [therapistId]
      ),
    ]);

    return res.json({
      availability: availRes.rows,
      bookings: bookingsRes.rows,
    });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load availability', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /therapy/therapist/availability ────────────────────────────────────
router.patch('/therapist/availability', therapistAuth, async (req, res) => {
  const therapistId = req.therapist.profile_id;
  const { slots } = req.body; // [{ day_of_week, start_time, end_time, is_active }]
  if (!Array.isArray(slots) || !slots.length) {
    return res.status(400).json({ error: 'slots array required', code: 'MISSING_FIELDS' });
  }

  try {
    // Guard: cannot deactivate a slot that has a confirmed booking
    const { rows: bookedSlots } = await query(
      `SELECT EXTRACT(DOW FROM scheduled_at AT TIME ZONE 'Africa/Nairobi') AS dow,
              TO_CHAR(scheduled_at AT TIME ZONE 'Africa/Nairobi', 'HH24:MI') AS start_time
       FROM therapist_bookings
       WHERE therapist_id = $1 AND status IN ('confirmed','in_progress') AND scheduled_at >= NOW()`,
      [therapistId]
    );

    const bookedKeys = new Set(bookedSlots.map(r => `${r.dow}::${r.start_time}`));

    for (const slot of slots) {
      const key = `${slot.day_of_week}::${slot.start_time}`;
      if (!slot.is_active && bookedKeys.has(key)) {
        return res.status(409).json({
          error: `Cannot deactivate slot ${slot.start_time} on day ${slot.day_of_week} — a confirmed booking exists`,
          code: 'SLOT_HAS_BOOKING',
        });
      }
    }

    await transaction(async (client) => {
      for (const slot of slots) {
        await client.query(
          `INSERT INTO therapist_availability (id, therapist_id, day_of_week, start_time, end_time, is_active)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (therapist_id, day_of_week, start_time)
           DO UPDATE SET end_time = $5, is_active = $6`,
          [uuidv4(), therapistId, slot.day_of_week, slot.start_time, slot.end_time, slot.is_active]
        );
      }
    });

    return res.json({ updated: slots.length });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to update availability', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapist/payments ─────────────────────────────────────────
router.get('/therapist/payments', therapistAuth, async (req, res) => {
  const therapistId = req.therapist.profile_id;
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const [rowsRes, summaryRes, countRes] = await Promise.all([
      query(
        `SELECT b.id AS booking_id, b.scheduled_at, b.session_format, b.duration_minutes,
                b.rate_kes, b.platform_fee_kes, b.therapist_payout_kes,
                p.status AS payout_status, p.mpesa_reference, p.created_at AS payout_date
         FROM therapist_bookings b
         LEFT JOIN therapist_payouts p ON p.booking_id = b.id
         WHERE b.therapist_id = $1 AND b.status = 'completed'
         ORDER BY b.scheduled_at DESC
         LIMIT $2 OFFSET $3`,
        [therapistId, parseInt(limit), offset]
      ),
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN EXTRACT(MONTH FROM scheduled_at) = EXTRACT(MONTH FROM NOW())
                              AND EXTRACT(YEAR FROM scheduled_at) = EXTRACT(YEAR FROM NOW())
                             THEN therapist_payout_kes ELSE 0 END), 0) AS month_kes,
           COALESCE(SUM(therapist_payout_kes), 0) AS lifetime_kes
         FROM therapist_bookings
         WHERE therapist_id = $1 AND status = 'completed'`,
        [therapistId]
      ),
      query(
        `SELECT
           COALESCE(SUM(CASE WHEN p.status = 'pending' THEN b.therapist_payout_kes ELSE 0 END), 0) AS pending_kes,
           COALESCE(SUM(CASE WHEN p.status = 'completed' THEN b.therapist_payout_kes ELSE 0 END), 0) AS completed_kes
         FROM therapist_payouts p
         JOIN therapist_bookings b ON b.id = p.booking_id
         WHERE b.therapist_id = $1`,
        [therapistId]
      ),
    ]);

    return res.json({
      payments: rowsRes.rows,
      summary: {
        month_kes:     parseFloat(summaryRes.rows[0].month_kes),
        lifetime_kes:  parseFloat(summaryRes.rows[0].lifetime_kes),
        pending_kes:   parseFloat(countRes.rows[0].pending_kes),
        completed_kes: parseFloat(countRes.rows[0].completed_kes),
      },
      page: parseInt(page),
    });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load payments', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapist/ratings ──────────────────────────────────────────
router.get('/therapist/ratings', therapistAuth, async (req, res) => {
  const therapistId = req.therapist.profile_id;
  try {
    const [ratingsRes, distRes] = await Promise.all([
      query(
        `SELECT r.rating, r.comment,
                TO_CHAR(r.created_at, 'Mon YYYY') AS month_year
         FROM therapist_ratings r
         WHERE r.therapist_id = $1 AND r.flagged = false
         ORDER BY r.created_at DESC
         LIMIT 50`,
        [therapistId]
      ),
      query(
        `SELECT rating, COUNT(*) AS cnt
         FROM therapist_ratings
         WHERE therapist_id = $1 AND flagged = false
         GROUP BY rating ORDER BY rating DESC`,
        [therapistId]
      ),
    ]);

    const { rows: profileRows } = await query(
      `SELECT average_rating, total_ratings_count FROM therapist_profiles WHERE id = $1`,
      [therapistId]
    );

    const distribution = [5,4,3,2,1].map(star => ({
      star,
      count: parseInt(distRes.rows.find(r => parseInt(r.rating) === star)?.cnt ?? 0),
    }));

    return res.json({
      ratings: ratingsRes.rows,
      distribution,
      average_rating: profileRows[0]?.average_rating ?? null,
      total_ratings_count: profileRows[0]?.total_ratings_count ?? 0,
    });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load ratings', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapist/profile ──────────────────────────────────────────
router.get('/therapist/profile', therapistAuth, async (req, res) => {
  const therapistId = req.therapist.profile_id;
  try {
    const { rows } = await query(
      `SELECT tp.id, tp.display_name, tp.full_name, tp.credentials, tp.photo_url,
              tp.plain_language_intro, tp.approach_plain, tp.cultural_competencies,
              tp.languages, tp.session_formats, tp.rate_per_session_kes,
              tp.availability_status, tp.registration_number, tp.kcpa_level,
              tp.total_sessions, tp.average_rating, tp.total_ratings_count,
              tp.is_verified, tp.suspended, tp.age, tp.gender,
              tp.statement, tp.years_experience,
              tp.onboarding_complete, tp.documents,
              tp.addendum_signed_at, tp.referral_code
       FROM therapist_profiles tp WHERE tp.id = $1`,
      [therapistId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Profile not found', code: 'NOT_FOUND' });
    return res.json({ profile: rows[0] });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load profile', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /therapy/therapist/profile ────────────────────────────────────────
router.patch('/therapist/profile', therapistAuth, async (req, res) => {
  const therapistId = req.therapist.profile_id;
  const EDITABLE = [
    'display_name', 'photo_url', 'plain_language_intro', 'approach_plain', 'cultural_competencies',
    'languages', 'session_formats', 'category_ids', 'rate_per_session_kes', 'availability_status', 'statement',
    'years_experience', 'location', 'gender', 'age',
    'credentials', 'registration_number', 'kcpa_level',
  ];

  const updates = {};
  for (const key of EDITABLE) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No editable fields provided', code: 'MISSING_FIELDS' });
  }

  const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`);
  const values = [therapistId, ...Object.values(updates)];

  try {
    await query(
      `UPDATE therapist_profiles SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1`,
      values
    );
    return res.json({ updated: true });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to update profile', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/therapist/fcm-token ───────────────────────────────────────
router.post('/therapist/fcm-token', therapistAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token is required', code: 'MISSING_FIELDS' });
  }
  await query(
    'UPDATE therapist_profiles SET fcm_token = $1 WHERE user_id = $2',
    [token, req.user.id]
  );
  return res.status(200).json({ stored: true });
});

// ─── POST /therapy/therapist/change-password ─────────────────────────────────
router.post('/therapist/change-password', therapistAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (typeof current_password !== 'string' || typeof new_password !== 'string' || !current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required', code: 'MISSING_FIELDS' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters', code: 'INVALID_PASSWORD' });
  }
  try {
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.therapist.user_id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) {
      return res.status(400).json({ error: 'Current password is incorrect.', code: 'INVALID_PASSWORD' });
    }
    const hash = await bcrypt.hash(new_password, 10);
    await query(
      'UPDATE users SET password_hash = $1, jwt_issued_before = NOW() WHERE id = $2',
      [hash, req.therapist.user_id]
    );
    return res.status(200).json({ updated: true });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to update password', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/therapist/documents/upload ─────────────────────────────────
// Accepts multipart/form-data: file (binary) + document_type (string)
// Streams to Supabase Storage via service role. Returns { file_path }.
const multer = require('multer');
const { uploadDocument, getPublicUrl, ALLOWED_DOCUMENT_TYPES, PHOTO_BUCKET } = require('../services/storage');
const _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/therapist/documents/upload', therapistAuth, _upload.single('file'), async (req, res) => {
  const { document_type } = req.body;
  if (!document_type || !ALLOWED_DOCUMENT_TYPES.has(document_type)) {
    return res.status(400).json({
      error: `document_type must be one of: ${[...ALLOWED_DOCUMENT_TYPES].join(', ')}`,
      code: 'INVALID_DOCUMENT_TYPE',
    });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded', code: 'MISSING_FILE' });
  }

  const userId = req.therapist.user_id;
  const { originalname, mimetype, buffer } = req.file;
  const isPhoto = document_type === 'photo';
  const bucket = isPhoto ? PHOTO_BUCKET : undefined; // undefined → default private bucket

  try {
    const { path } = await uploadDocument({
      userId,
      documentType: document_type,
      filename: originalname,
      mimeType: mimetype,
      buffer,
      bucket,
    });

    // Upsert into documents JSONB array — replace entry of same type if exists
    await query(
      `UPDATE therapist_profiles
       SET documents = (
         SELECT jsonb_agg(
           CASE WHEN elem->>'type' = $2::text
           THEN jsonb_build_object('type', $2::text, 'file_path', $3::text, 'uploaded_at', NOW()::text)
           ELSE elem END
         )
         FROM jsonb_array_elements(
           CASE WHEN documents @> jsonb_build_array(jsonb_build_object('type', $2::text))
           THEN documents
           ELSE documents || jsonb_build_array(jsonb_build_object('type', $2::text, 'file_path', $3::text, 'uploaded_at', NOW()::text))
           END
         ) AS elem
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [req.therapist.profile_id, document_type, path]
    );

    // For photos: also set photo_url to a permanent public URL
    if (isPhoto) {
      const photoUrl = getPublicUrl(PHOTO_BUCKET, path);
      await query(
        `UPDATE therapist_profiles SET photo_url = $1, updated_at = NOW() WHERE id = $2`,
        [photoUrl, req.therapist.profile_id]
      );
      return res.status(200).json({ file_path: path, photo_url: photoUrl });
    }

    return res.status(200).json({ file_path: path });
  } catch (err) {
    const status = err.status || 500;
    logger.error({ err }, err.message);
    return res.status(status).json({ error: err.message, code: 'UPLOAD_ERROR' });
  }
});

// ─── DELETE /therapy/therapist/documents/:document_type ───────────────────────
router.delete('/therapist/documents/:document_type', therapistAuth, async (req, res) => {
  const { document_type } = req.params;
  if (!ALLOWED_DOCUMENT_TYPES.has(document_type)) {
    return res.status(400).json({ error: 'Invalid document_type', code: 'INVALID_DOCUMENT_TYPE' });
  }

  await query(
    `UPDATE therapist_profiles
     SET documents = (
       SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
       FROM jsonb_array_elements(documents) AS elem
       WHERE elem->>'type' != $2
     ),
     updated_at = NOW()
     WHERE id = $1`,
    [req.therapist.profile_id, document_type]
  );

  return res.json({ removed: true });
});

// ─── PATCH /therapy/therapist/onboarding/complete ─────────────────────────────
// Validates required onboarding fields, sets onboarding_complete = true.
router.patch('/therapist/onboarding/complete', therapistAuth, async (req, res) => {
  if (!req.body.agreement_acknowledged) {
    return res.status(400).json({
      error: 'You must accept the Therapist Partnership Agreement to complete onboarding',
      code: 'AGREEMENT_NOT_ACKNOWLEDGED',
    });
  }

  const { rows } = await query(
    `SELECT display_name, credentials, languages, session_formats,
            years_experience, category_ids, onboarding_complete
     FROM therapist_profiles WHERE id = $1`,
    [req.therapist.profile_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Profile not found', code: 'NOT_FOUND' });

  const p = rows[0];
  if (p.onboarding_complete) return res.json({ already_complete: true });

  const missing = [];
  if (!p.display_name)                    missing.push('display_name');
  if (!p.credentials)                     missing.push('credentials');
  if (!p.languages?.length)               missing.push('languages');
  if (!p.session_formats?.length)         missing.push('session_formats');
  if (!p.years_experience && p.years_experience !== 0) missing.push('years_experience');
  // category_ids is assigned by admin — not a therapist-side onboarding gate

  if (missing.length) {
    return res.status(400).json({
      error: 'Profile incomplete — fill all required fields before submitting',
      code: 'INCOMPLETE_PROFILE',
      missing,
    });
  }

  await query(
    `UPDATE therapist_profiles SET onboarding_complete = true, updated_at = NOW() WHERE id = $1`,
    [req.therapist.profile_id]
  );

  notifyAllAdmins(query, '🩺 New Therapist Application', 'A therapist has completed onboarding and is pending review.', { type: 'therapist_application', _urgent: 'true' }).catch(() => {});

  return res.json({ onboarding_complete: true });
});

// ─── GET /therapy/therapist/clients ──────────────────────────────────────────
router.get('/therapist/clients', therapistAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         b.member_user_id,
         u.alias,
         COUNT(b.id)::int                                        AS total_sessions,
         MAX(b.scheduled_at)                                     AS last_session_at,
         (SELECT format FROM therapist_bookings
          WHERE member_user_id = b.member_user_id AND therapist_id = $1 AND status = 'completed'
          ORDER BY scheduled_at DESC LIMIT 1)                    AS last_session_format,
         COUNT(n.id)::int                                        AS note_count
       FROM therapist_bookings b
       JOIN users u ON u.id = b.member_user_id
       LEFT JOIN therapy_session_notes n ON n.booking_id = b.id AND n.therapist_id = $1
       WHERE b.therapist_id = $1 AND b.status = 'completed'
       GROUP BY b.member_user_id, u.alias
       ORDER BY MAX(b.scheduled_at) DESC`,
      [req.therapist.profile_id]
    );
    return res.json({ clients: rows });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to fetch clients', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapist/clients/:member_user_id ───────────────────────────
router.get('/therapist/clients/:member_user_id', therapistAuth, async (req, res) => {
  const { member_user_id } = req.params;

  if (!UUID_RE.test(member_user_id)) {
    return res.status(404).json({ error: 'Client not found', code: 'NOT_FOUND' });
  }
  try {
    const { rows: bookings } = await query(
      `SELECT b.id, b.scheduled_at, b.status, b.session_format, b.duration_minutes,
              COALESCE(json_agg(
                json_build_object('id', n.id, 'note_type', n.note_type, 'content', n.content, 'created_at', n.created_at)
                ORDER BY n.created_at
              ) FILTER (WHERE n.id IS NOT NULL), '[]'::json) AS notes
       FROM therapist_bookings b
       LEFT JOIN therapy_session_notes n ON n.booking_id = b.id AND n.therapist_id = $1
       WHERE b.therapist_id = $1 AND b.member_user_id = $2
       GROUP BY b.id
       ORDER BY b.scheduled_at ASC`,
      [req.therapist.profile_id, member_user_id]
    );
    if (!bookings.length) return res.status(404).json({ error: 'Client not found', code: 'NOT_FOUND' });

    const { rows: [client] } = await query(
      'SELECT alias FROM users WHERE id = $1', [member_user_id]
    );
    return res.json({ client: { alias: client?.alias ?? null, member_user_id }, bookings });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to fetch client history', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/therapist/clients/:member_user_id/nudge ───────────────────
router.post('/therapist/clients/:member_user_id/nudge', therapistAuth, async (req, res) => {
  const { member_user_id } = req.params;

  if (!UUID_RE.test(member_user_id)) return res.status(404).json({ error: 'Client not found', code: 'NOT_FOUND' });
  const { rows } = await query(
    `SELECT u.fcm_token FROM therapist_bookings b
     JOIN users u ON u.id = b.member_user_id
     WHERE b.therapist_id = $1 AND b.member_user_id = $2 LIMIT 1`,
    [req.therapist.profile_id, member_user_id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Client not found', code: 'NOT_FOUND' });
  if (rows[0].fcm_token) {
    enqueuePushNotification(
      rows[0].fcm_token,
      'Get the PeerPal App',
      'Install PeerPal on your phone for session reminders and updates.',
      { type: 'install_nudge' }
    ).catch(() => {});
  }
  return res.status(200).json({ sent: !!rows[0].fcm_token });
});

// ─── GET /therapy/session-notes?booking_id=X ─────────────────────────────────
router.get('/session-notes', therapistAuth, async (req, res) => {
  const { booking_id } = req.query;
  if (!booking_id) return res.status(400).json({ error: 'booking_id required', code: 'MISSING_FIELDS' });

  if (!UUID_RE.test(booking_id)) return res.status(400).json({ error: 'Invalid booking_id', code: 'INVALID_FIELDS' });
  try {
    const { rows } = await query(
      `SELECT n.id, n.note_type, n.content, n.created_at, n.updated_at
       FROM therapy_session_notes n
       JOIN therapist_bookings b ON b.id = n.booking_id
       WHERE n.booking_id = $1 AND b.therapist_id = $2
       ORDER BY n.created_at ASC`,
      [booking_id, req.therapist.profile_id]
    );
    return res.json({ notes: rows });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to fetch notes', code: 'QUERY_ERROR' });
  }
});

// ─── PATCH /therapy/session-notes/:id ────────────────────────────────────────
router.patch('/session-notes/:id', therapistAuth, async (req, res) => {

  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid note id', code: 'INVALID_FIELDS' });
  }
  const { content, note_type } = req.body;
  if (!content?.trim() && !note_type) {
    return res.status(400).json({ error: 'content or note_type required', code: 'MISSING_FIELDS' });
  }
  if (note_type && !['pre', 'session', 'follow_up'].includes(note_type)) {
    return res.status(400).json({ error: 'Invalid note_type', code: 'INVALID_NOTE_TYPE' });
  }
  try {
    // Fixed positions: $1=note_id, $2=therapist_id — SET params use $3+
    const noteId = req.params.id;
    const therapistId = req.therapist.profile_id;
    const extra = [];
    const extraVals = [];
    if (content?.trim()) { extra.push(`content = $${extraVals.push(content.trim()) + 2}`); }
    if (note_type)        { extra.push(`note_type = $${extraVals.push(note_type) + 2}`); }
    extra.push(`updated_at = NOW()`);

    const { rowCount } = await query(
      `UPDATE therapy_session_notes SET ${extra.join(', ')}
       WHERE id = $1 AND therapist_id = $2`,
      [noteId, therapistId, ...extraVals]
    );
    if (!rowCount) return res.status(404).json({ error: 'Note not found', code: 'NOT_FOUND' });
    return res.json({ saved: true });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to update note', code: 'QUERY_ERROR' });
  }
});

// ─── POST /therapy/therapist/sign-addendum (authenticated) ───────────────────
router.post('/therapist/sign-addendum', therapistAuth, async (req, res) => {
  const { generateTherapistReferralCode } = require('../utils/referralCode');
  const therapistId = req.therapist.profile_id;
  try {
    // Idempotent: if already signed, return existing code
    const { rows: existing } = await query(
      `SELECT referral_code, addendum_signed_at, is_verified FROM therapist_profiles WHERE id = $1`,
      [therapistId]
    );
    if (!existing.length) return res.status(404).json({ error: 'Profile not found' });
    if (!existing[0].is_verified) {
      return res.status(403).json({ error: 'Account must be verified before signing the referral addendum', code: 'NOT_VERIFIED' });
    }
    if (existing[0].addendum_signed_at) {
      return res.status(200).json({ referral_code: existing[0].referral_code, already_signed: true });
    }

    const code = await generateTherapistReferralCode({ query });
    await query(
      `UPDATE therapist_profiles
         SET addendum_signed_at = NOW(), referral_code = $1
       WHERE id = $2`,
      [code, therapistId]
    );
    logger.info('[sign-addendum] therapist %s signed addendum, code %s', therapistId, code);
    return res.status(200).json({ referral_code: code });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to sign addendum', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapist/my-referrals (authenticated) ─────────────────────
router.get('/therapist/my-referrals', therapistAuth, async (req, res) => {
  const therapistId = req.therapist.profile_id;
  try {
    const { rows } = await query(
      `SELECT tp.id, tp.display_name, tp.is_verified, tp.addendum_signed_at,
              tp.created_at AS joined_at
       FROM therapist_profiles tp
       WHERE tp.referred_by_therapist_id = $1
       ORDER BY tp.created_at DESC`,
      [therapistId]
    );
    return res.status(200).json({ referrals: rows });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load referrals', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/therapist/my-commissions (authenticated) ───────────────────
router.get('/therapist/my-commissions', therapistAuth, async (req, res) => {
  const therapistId = req.therapist.profile_id;
  try {
    const { rows } = await query(
      `SELECT tc.id, tc.referred_therapist_id,
              tp.display_name AS referred_therapist_name,
              tc.session_fee_kes, tc.commission_kes, tc.status,
              tc.period_ends_at, tc.created_at
       FROM therapist_commissions tc
       JOIN therapist_profiles tp ON tp.id = tc.referred_therapist_id
       WHERE tc.referrer_therapist_id = $1
       ORDER BY tc.created_at DESC`,
      [therapistId]
    );
    const total_pending_kes = rows
      .filter(r => r.status === 'pending')
      .reduce((sum, r) => sum + r.commission_kes, 0);
    const total_paid_kes = rows
      .filter(r => r.status === 'paid')
      .reduce((sum, r) => sum + r.commission_kes, 0);
    return res.status(200).json({ commissions: rows, total_pending_kes, total_paid_kes });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Failed to load commissions', code: 'QUERY_ERROR' });
  }
});

// ─── GET /therapy/referral-code/:code (public, rate-limited) ─────────────────
router.get('/referral-code/:code', publicFormLimiter, async (req, res) => {
  const { normalizeReferralCode } = require('../utils/referralCode');
  const code = normalizeReferralCode(req.params.code);
  if (!code) return res.status(200).json({ valid: false });
  try {
    const { rows } = await query(
      `SELECT display_name FROM therapist_profiles WHERE referral_code = $1 AND is_verified = true`,
      [code]
    );
    if (!rows.length) return res.status(200).json({ valid: false });
    return res.status(200).json({ valid: true, referrer_name: rows[0].display_name });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ valid: false });
  }
});

// ─── POST /therapy/referral-applications (public) ────────────────────────────
const ALLOWED_DOC_VERSIONS = ['v1'];
router.post('/referral-applications', publicFormLimiter, async (req, res) => {
  const { normalizeReferralCode } = require('../utils/referralCode');
  const { full_legal_name, email, phone, signature_name, professional_body, reg_number, message, ref_code, doc_version } = req.body;

  // Required fields
  if (!full_legal_name?.trim() || !email?.trim() || !phone?.trim() || !signature_name?.trim()) {
    return res.status(400).json({ error: 'full_legal_name, email, phone and signature_name are required', code: 'MISSING_FIELDS' });
  }
  // Length limits (DB columns are VARCHAR(255) — give a clean 400 instead of a raw 500)
  if (full_legal_name.trim().length > 255)
    return res.status(400).json({ error: 'full_legal_name too long', code: 'INVALID_FIELDS' });
  if (phone.trim().length > 30)
    return res.status(400).json({ error: 'phone too long', code: 'INVALID_FIELDS' });
  if (signature_name.trim().length > 255)
    return res.status(400).json({ error: 'signature_name too long', code: 'INVALID_FIELDS' });
  // Email format sanity check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Invalid email address', code: 'INVALID_FIELDS' });
  }
  // doc_version whitelist
  const version = ALLOWED_DOC_VERSIONS.includes(doc_version) ? doc_version : 'v1';
  // Signature must match name
  if (full_legal_name.trim().toLowerCase() !== signature_name.trim().toLowerCase()) {
    return res.status(400).json({ error: 'Signature name must match your full legal name', code: 'SIGNATURE_MISMATCH' });
  }

  try {
    // Resolve referrer if code provided
    let referrer_therapist_id = null;
    if (ref_code) {
      const code = normalizeReferralCode(ref_code);
      if (code) {
        const { rows } = await query(
          `SELECT id FROM therapist_profiles WHERE referral_code = $1 AND is_verified = true`,
          [code]
        );
        if (!rows.length) return res.status(400).json({ error: 'Invalid referral code', code: 'INVALID_REF' });
        referrer_therapist_id = rows[0].id;
      }
    }

    // Duplicate email check
    const { rows: existing } = await query(
      `SELECT id FROM therapist_referral_applications WHERE email = $1 AND status IN ('pending','account_created')`,
      [email.trim().toLowerCase()]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'An application with this email already exists — contact support@peer-pal.com', code: 'DUPLICATE' });
    }

    await query(
      `INSERT INTO therapist_referral_applications
         (referrer_therapist_id, full_legal_name, email, phone, signature_name,
          professional_body, reg_number, message, ip_address, doc_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        referrer_therapist_id,
        full_legal_name.trim(),
        email.trim().toLowerCase(),
        phone.trim(),
        signature_name.trim(),
        professional_body?.trim() || null,
        reg_number?.trim() || null,
        message?.trim() || null,
        req.ip || null,
        version,
      ]
    );

    logger.info('[referral-applications] new application from %s', email);
    return res.status(201).json({ received: true });
  } catch (err) {
    logger.error({ err }, err.message);
    return res.status(500).json({ error: 'Submission failed — please try again', code: 'QUERY_ERROR' });
  }
});

module.exports = router;