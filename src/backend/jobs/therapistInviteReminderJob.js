'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const logger = require('../utils/logger');
const { sendTherapistPasswordReset } = require('../services/emailService');

// Finds therapists whose invite token expired in the last 25 hours and whose
// account is less than 14 days old, then issues a fresh token and resends.
// Runs daily — catches each expiry window once. Max ~4 auto-resends per therapist.
async function runTherapistInviteReminderJob() {
  const { rows } = await query(
    `SELECT u.id AS user_id, u.email, tp.display_name
     FROM users u
     JOIN therapist_profiles tp ON tp.user_id = u.id
     WHERE u.reset_token_expires IS NOT NULL
       AND u.reset_token_expires < NOW()
       AND u.reset_token_expires > NOW() - INTERVAL '25 hours'
       AND u.created_at > NOW() - INTERVAL '14 days'`
  );

  if (!rows.length) {
    logger.info('[inviteReminder] No expired therapist invites to resend');
    return;
  }

  logger.info(`[inviteReminder] Resending to ${rows.length} therapist(s)`);

  for (const row of rows) {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const hash  = crypto.createHash('sha256').update(token).digest('hex');
      await query(
        `UPDATE users SET reset_token_hash = $1, reset_token_expires = NOW() + INTERVAL '72 hours' WHERE id = $2`,
        [hash, row.user_id]
      );
      await sendTherapistPasswordReset(row.email, row.display_name, token);
      logger.info(`[inviteReminder] Resent invite to ${row.user_id}`);
    } catch (err) {
      logger.error('[inviteReminder] Failed for user', row.user_id, err.message);
    }
  }
}

module.exports = { runTherapistInviteReminderJob };
