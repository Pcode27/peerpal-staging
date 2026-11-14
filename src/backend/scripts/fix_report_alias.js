// Finds peer_reports with null peer_alias and patches them from the session.
// Run: node scripts/fix_report_alias.js
// Set DATABASE_URL in .env or environment before running.
const { query } = require('../db');

async function run() {
  // Find open reports missing a peer alias
  const { rows: reports } = await query(`
    SELECT pr.id, pr.reporter_id, pr.session_id, pr.channel, pr.description, pr.created_at
    FROM peer_reports pr
    WHERE pr.peer_alias IS NULL
    ORDER BY pr.created_at DESC
    LIMIT 20
  `);

  console.log(`Found ${reports.length} report(s) with no peer alias`);

  for (const report of reports) {
    if (!report.session_id) {
      console.log(`  report ${report.id}: no session_id — skipping`);
      continue;
    }

    // Look up peer alias: the peer is whoever is NOT the reporter
    const { rows: sr } = await query(`
      SELECT CASE WHEN s.user_id = $2 THEN u_peer.alias ELSE u_req.alias END AS peer_alias
      FROM sessions s
      JOIN users u_req  ON u_req.id  = s.user_id
      JOIN peer_requests preq ON preq.session_id = s.id
      JOIN users u_peer ON u_peer.id = preq.accepted_by
      WHERE s.id = $1
      LIMIT 1
    `, [report.session_id, report.reporter_id]);

    if (!sr.length || !sr[0].peer_alias) {
      console.log(`  report ${report.id}: session ${report.session_id} — could not resolve alias`);
      continue;
    }

    await query(`UPDATE peer_reports SET peer_alias = $1 WHERE id = $2`, [sr[0].peer_alias, report.id]);
    console.log(`  report ${report.id}: patched peer_alias = ${sr[0].peer_alias}`);
  }

  process.exit(0);
}

run().catch(e => { console.error(e.message); process.exit(1); });
