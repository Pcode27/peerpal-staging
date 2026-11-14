const { query } = require('../db');
const logger = require('../utils/logger');


// Blueprint section 9.5 — composite risk scoring.
// Runs at midnight UTC via node-cron in server.js.
async function runRiskScoreJob() {
  // Fetch all active users with their signals
  const { rows: users } = await query(
    `SELECT u.id, u.risk_level,
            COUNT(DISTINCT CASE WHEN ai.flagged = true AND ai.created_at >= NOW() - INTERVAL '7 days' THEN ai.id END) AS recent_flags,
            COUNT(DISTINCT CASE WHEN m.mood_level IN ('very_low','low') AND m.created_at >= NOW() - INTERVAL '7 days' THEN m.id END) AS low_mood_count,
            COUNT(DISTINCT CASE WHEN j.risk_flagged = true AND j.created_at >= NOW() - INTERVAL '7 days' THEN j.id END) AS journal_flags,
            COUNT(DISTINCT CASE WHEN el.status != 'resolved' AND el.triggered_at >= NOW() - INTERVAL '7 days' THEN el.id END) AS emergency_count
     FROM users u
     LEFT JOIN ai_interactions ai ON ai.user_id = u.id
     LEFT JOIN moods m ON m.user_id = u.id
     LEFT JOIN journals j ON j.user_id = u.id
     LEFT JOIN emergency_logs el ON el.user_id = u.id
     WHERE u.is_active = true AND u.role = 'member'
     GROUP BY u.id, u.risk_level`
  );

  for (const user of users) {
    const { id, risk_level, recent_flags, low_mood_count, journal_flags, emergency_count } = user;

    // Composite score: weighted signals
    const score =
      parseInt(recent_flags)    * 3 +
      parseInt(low_mood_count)  * 1 +
      parseInt(journal_flags)   * 2 +
      parseInt(emergency_count) * 4;

    let newLevel = 'low';
    if (score >= 10) newLevel = 'critical';
    else if (score >= 5) newLevel = 'high';
    else if (score >= 2) newLevel = 'medium';

    if (newLevel === risk_level) continue;

    await query(
      'UPDATE users SET risk_level = $1, updated_at = NOW() WHERE id = $2',
      [newLevel, id]
    );

    // Alert admins for critical users
    if (newLevel === 'critical') {
      await query(
        `INSERT INTO notifications (user_id, type, payload, channel)
         SELECT id, 'emergency_alert', $1, 'in_app'
           FROM users WHERE role = 'admin' AND is_active = true`,
        [JSON.stringify({ source: 'risk_score_job', user_id: id, new_level: 'critical', score })]
      );
    }
  }

}

module.exports = { runRiskScoreJob };
