'use strict';

const { query, transaction } = require('../db');
const logger = require('../utils/logger');

// Returns 'YYYY-MM' in Africa/Nairobi (EAT, UTC+3)
function eatMonthString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
  }).format(date);
}

async function runReferralPayoutJob() {
  const periodMonth = eatMonthString();

  // All referrers with pending commissions not yet batched this month.
  // array_agg(tc.id) pins the exact rows included in the total so the
  // subsequent UPDATE marks only those rows — not any commission inserted
  // concurrently between this SELECT and the transaction below.
  const { rows } = await query(
    `SELECT tc.referrer_therapist_id,
            array_agg(tc.id) AS commission_ids,
            SUM(tc.commission_kes)::INTEGER AS total_commission_kes,
            tp.mpesa_number
     FROM therapist_commissions tc
     JOIN therapist_profiles tp ON tp.id = tc.referrer_therapist_id
     WHERE tc.status = 'pending'
       AND tc.referrer_therapist_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM therapist_commission_payouts p
         WHERE p.referrer_therapist_id = tc.referrer_therapist_id
           AND p.period_month = $1
       )
     GROUP BY tc.referrer_therapist_id, tp.mpesa_number
     HAVING SUM(tc.commission_kes) > 0`,
    [periodMonth]
  );

  if (!rows.length) {
    logger.info('[referralPayout] No pending commissions to pay out for', periodMonth);
    return;
  }

  let paid = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.mpesa_number) {
      logger.warn('[referralPayout] No M-Pesa number for referrer', row.referrer_therapist_id, '— skipping');
      skipped++;
      continue;
    }

    try {
      await transaction(async (client) => {
        // Insert payout record — idempotent via UNIQUE (referrer_therapist_id, period_month)
        const { rowCount } = await client.query(
          `INSERT INTO therapist_commission_payouts
             (referrer_therapist_id, period_month, total_commission_kes, mpesa_number, status)
           VALUES ($1, $2, $3, $4, 'pending')
           ON CONFLICT (referrer_therapist_id, period_month) DO NOTHING`,
          [row.referrer_therapist_id, periodMonth, row.total_commission_kes, row.mpesa_number]
        );

        if (rowCount === 0) {
          // Already batched this month (conflict) — skip commission update
          logger.info('[referralPayout] Already batched for', row.referrer_therapist_id, periodMonth);
          return;
        }

        // Mark only the commissions included in this batch as paid.
        await client.query(
          `UPDATE therapist_commissions
           SET status = 'paid'
           WHERE id = ANY($1) AND status = 'pending'`,
          [row.commission_ids]
        );
      });

      logger.info(
        `[referralPayout] Payout created: referrer ${row.referrer_therapist_id},` +
        ` KES ${row.total_commission_kes}, month ${periodMonth}`
      );
      paid++;
    } catch (err) {
      logger.error('[referralPayout] Error for referrer', row.referrer_therapist_id, err.message);
    }
  }

  logger.info(`[referralPayout] Done — ${paid} payout(s) created, ${skipped} skipped (no M-Pesa)`);
}

module.exports = { runReferralPayoutJob, eatMonthString };
