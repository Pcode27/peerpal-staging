'use strict';

const { query } = require('../db');
const logger = require('../utils/logger');

const { initiatePayout } = require('../utils/therapistPayout');
const { v4: uuidv4 } = require('uuid');

async function notifyUser(user_id, type, payload) {
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     VALUES ($1, $2, $3, 'in_app')`,
    [user_id, type, JSON.stringify(payload)]
  ).catch((e) => logger.error(e.message));
}

async function runEscrowReleaseJob() {
  // Completed bookings held for 24+ hours with no open dispute
  const { rows } = await query(
    `SELECT b.id, b.therapist_id, b.therapist_payout_kes, b.platform_fee_kes,
            tp.mpesa_number, tp.user_id AS therapist_user_id,
            tp.referred_by_therapist_id,
            ref_tp.addendum_signed_at AS referrer_addendum_signed_at,
            ts.ended_at AS session_ended_at
     FROM therapist_bookings b
     JOIN therapist_profiles tp ON tp.id = b.therapist_id
     JOIN therapy_sessions ts ON ts.booking_id = b.id
     LEFT JOIN therapist_profiles ref_tp ON ref_tp.id = tp.referred_by_therapist_id
     WHERE b.status = 'completed'
       AND b.escrow_status = 'held'
       AND ts.ended_at < NOW() - INTERVAL '24 hours'
       AND NOT EXISTS (
         SELECT 1 FROM therapy_disputes d
         WHERE d.booking_id = b.id AND d.status = 'open'
       )`
  );

  for (const row of rows) {
    try {
      const payoutId = uuidv4();
      await query(
        `INSERT INTO therapist_payouts
           (id, therapist_id, booking_id, amount_kes, mpesa_number, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, 'pending', $1)`,
        [payoutId, row.therapist_id, row.id, row.therapist_payout_kes, row.mpesa_number]
      );

      await query(
        `UPDATE therapist_bookings SET escrow_status = 'released', updated_at = NOW() WHERE id = $1`,
        [row.id]
      );

      // 58.6 — commission engine: credit referrer if within 12-month addendum window
      if (row.referred_by_therapist_id && row.referrer_addendum_signed_at) {
        const windowEnd = new Date(row.referrer_addendum_signed_at);
        windowEnd.setFullYear(windowEnd.getFullYear() + 1);
        if (new Date(row.session_ended_at) <= windowEnd) {
          const commission_kes = Math.round(row.platform_fee_kes * 0.05);
          await query(
            `INSERT INTO therapist_commissions
               (referrer_therapist_id, referred_therapist_id, booking_id,
                session_fee_kes, commission_kes, period_ends_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (booking_id) DO NOTHING`,
            [row.referred_by_therapist_id, row.therapist_id, row.id,
             row.platform_fee_kes, commission_kes, windowEnd.toISOString()]
          ).catch((e) => logger.error('[escrowRelease] commission insert failed:', row.id, e.message));
          logger.info(`[escrowRelease] Commission: booking ${row.id}, referrer ${row.referred_by_therapist_id}, KES ${commission_kes}`);
        }
      }

      await initiatePayout(payoutId).catch((e) =>
        logger.error('[escrowRelease] initiatePayout failed:', payoutId, e.message)
      );

      await notifyUser(row.therapist_user_id, 'therapist_update', {
        message: `Payout of KES ${row.therapist_payout_kes} has been initiated to your M-Pesa.`,
      });

      logger.info(`[escrowRelease] Released: booking ${row.id}, payout ${payoutId}`);
    } catch (err) {
      logger.error('[escrowRelease] Error:', row.id, err.message);
    }
  }
}

module.exports = { runEscrowReleaseJob };
