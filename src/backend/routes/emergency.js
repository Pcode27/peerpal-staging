const express = require('express');
const { query } = require('../db');
const auth = require('../middleware/auth');
const { notifyAllAdmins } = require('../utils/fcm');

const router = express.Router();

// ─── POST /emergency/trigger ──────────────────────────────────────────────────
router.post('/trigger', auth, async (req, res) => {
  const { rows } = await query(
    `INSERT INTO emergency_logs (user_id, trigger_type)
     VALUES ($1, 'user_initiated') RETURNING id, triggered_at`,
    [req.user.id]
  );
  const { id: logId, triggered_at } = rows[0];

  // Immediate priority alert to all admins — push + in-app
  const payload = JSON.stringify({ log_id: logId, alias: req.user.alias, trigger_type: 'user_initiated' });
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     SELECT id, 'emergency_alert', $1, 'push'
       FROM users WHERE role = 'admin' AND is_active = true`,
    [payload]
  );
  await query(
    `INSERT INTO notifications (user_id, type, payload, channel)
     SELECT id, 'emergency_alert', $1, 'in_app'
       FROM users WHERE role = 'admin' AND is_active = true`,
    [payload]
  );

  notifyAllAdmins(query, '🚨 Emergency Alert', `${req.user.alias || 'A member'} triggered an emergency.`, { type: 'emergency', log_id: logId, _urgent: 'true' }).catch(() => {});

  return res.status(201).json({ log_id: logId, triggered_at });
});

// ─── GET /emergency/status ────────────────────────────────────────────────────
// Returns the user's latest open or acknowledged emergency log (for polling)
router.get('/status', auth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, status, triggered_at, acknowledged_at, resolved_at
     FROM emergency_logs
     WHERE user_id = $1 AND status IN ('open', 'acknowledged')
     ORDER BY triggered_at DESC LIMIT 1`,
    [req.user.id]
  );
  if (!rows.length) return res.status(200).json({ active: false });
  return res.status(200).json({ active: true, ...rows[0] });
});

module.exports = router;
