'use strict';

const { query } = require('../db');
const logger = require('../utils/logger');
const { enqueuePushNotification } = require('../utils/fcm');

async function notifyUser(user_id, type, payload) {
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     VALUES ($1, $2, $3, 'in_app')`,
    [user_id, type, JSON.stringify(payload)]
  ).catch((e) => logger.error('[preSessionReminder:notify]', e.message));
}

async function runPreSessionReminderJob() {
  // Confirmed bookings starting in 14–16 minutes
  const { rows } = await query(
    `SELECT b.id, b.member_user_id, b.therapist_id, b.session_format, b.scheduled_at,
            u.alias AS member_alias, u.fcm_token AS member_fcm_token,
            tp.user_id AS therapist_user_id, tp.fcm_token AS therapist_fcm_token
     FROM therapist_bookings b
     JOIN users u ON u.id = b.member_user_id
     JOIN therapist_profiles tp ON tp.id = b.therapist_id
     WHERE b.status = 'confirmed'
       AND b.scheduled_at BETWEEN NOW() + INTERVAL '14 minutes' AND NOW() + INTERVAL '16 minutes'`
  );

  for (const row of rows) {
    try {
      const memberMsg  = 'Your therapy session starts in 15 minutes. Tap to join when it begins.';
      const therapistMsg = `Session in 15 minutes — your client is ${row.member_alias}. Tap to start when ready.`;

      await notifyUser(row.member_user_id, 'therapist_update', {
        message: memberMsg,
        booking_id: row.id,
        session_format: row.session_format,
      });

      await notifyUser(row.therapist_user_id, 'therapist_update', {
        message: therapistMsg,
        booking_id: row.id,
      });

      if (row.member_fcm_token) {
        enqueuePushNotification(row.member_fcm_token, 'Session Soon', memberMsg,
          { type: 'therapist_update', booking_id: row.id }).catch(() => {});
      }
      if (row.therapist_fcm_token) {
        enqueuePushNotification(row.therapist_fcm_token, 'Session Soon', therapistMsg,
          { type: 'therapist_update', booking_id: row.id }).catch(() => {});
      }

      logger.info(`[preSessionReminder] Reminders sent for booking ${row.id}`);
    } catch (err) {
      logger.error('[preSessionReminder] Error:', row.id, err.message);
    }
  }
}

module.exports = { runPreSessionReminderJob };
