/**
 * POST /admin/members/:id/grant-peer-status
 *
 * Unit:   grant logic, idempotency guard, role guard.
 * Static: route exists in admin.js with correct SQL and audit call.
 *
 * Run: node --test tests/adminGrantPeer.test.js  (from src/backend)
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

// ── Static: read source once ─────────────────────────────────────────────────

const adminSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
const routeStart = 'POST /admin/members/:id/grant-peer-status';
const routeEnd   = 'GET /admin/referral-applications';
const routeSrc   = adminSrc.slice(adminSrc.indexOf(routeStart), adminSrc.indexOf(routeEnd));

// ── Unit helpers ─────────────────────────────────────────────────────────────

function makeHandler(queryImpl) {
  // Extracted grant-peer logic so we can test it without Express
  return async function grantPeer(userId, adminId) {
    const { rows } = await queryImpl(
      `SELECT alias, email, peer_quiz_done FROM users WHERE id = $1 AND role = 'member'`,
      [userId]
    );
    if (!rows.length) {
      const { rows: any } = await queryImpl('SELECT role FROM users WHERE id = $1', [userId]);
      if (!any.length) return { status: 404, code: 'NOT_FOUND' };
      return { status: 409, code: 'WRONG_ROLE' };
    }
    if (rows[0].peer_quiz_done) return { status: 409, code: 'ALREADY_PEER' };
    await queryImpl(
      `UPDATE users SET peer_quiz_done = true, peer_available_until = NOW() + INTERVAL '10 years', updated_at = NOW() WHERE id = $1`,
      [userId]
    );
    return { status: 200, granted: true, alias: rows[0].alias };
  };
}

// ── Unit tests ───────────────────────────────────────────────────────────────

describe('grant-peer-status: unit', () => {
  test('writes peer_quiz_done and peer_available_until for eligible member', async () => {
    const calls = [];
    const fakeQuery = async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT alias')) return { rows: [{ alias: 'TestUser', email: 'u@test.com', peer_quiz_done: false }] };
      return { rows: [] };
    };
    const result = await makeHandler(fakeQuery)('user-1', 'admin-1');
    assert.equal(result.status, 200);
    assert.equal(result.granted, true);
    const updateCall = calls.find((c) => c.sql.includes('UPDATE'));
    assert.ok(updateCall, 'UPDATE must be called');
    assert.ok(updateCall.sql.includes('peer_quiz_done = true'), 'must set peer_quiz_done');
    assert.ok(updateCall.sql.includes("INTERVAL '10 years'"), 'must set 10-year window');
    assert.deepEqual(updateCall.params, ['user-1']);
  });

  test('returns ALREADY_PEER when peer_quiz_done is true', async () => {
    const fakeQuery = async (sql) => {
      if (sql.startsWith('SELECT alias')) return { rows: [{ alias: 'PeerUser', email: 'p@test.com', peer_quiz_done: true }] };
      return { rows: [] };
    };
    const result = await makeHandler(fakeQuery)('user-2', 'admin-1');
    assert.equal(result.status, 409);
    assert.equal(result.code, 'ALREADY_PEER');
  });

  test('returns NOT_FOUND when user does not exist', async () => {
    const fakeQuery = async () => ({ rows: [] });
    const result = await makeHandler(fakeQuery)('ghost', 'admin-1');
    assert.equal(result.status, 404);
    assert.equal(result.code, 'NOT_FOUND');
  });

  test('returns WRONG_ROLE when user is not a member (e.g. therapist)', async () => {
    let call = 0;
    const fakeQuery = async (sql) => {
      call++;
      // First call: role-filtered SELECT returns nothing (not a member)
      if (call === 1) return { rows: [] };
      // Second call: unfiltered SELECT finds the user (they exist but wrong role)
      return { rows: [{ role: 'therapist' }] };
    };
    const result = await makeHandler(fakeQuery)('therapist-1', 'admin-1');
    assert.equal(result.status, 409);
    assert.equal(result.code, 'WRONG_ROLE');
  });
});

// ── Static / integration tests ───────────────────────────────────────────────

describe('grant-peer-status: static source checks', () => {
  test('route exists in admin.js', () => {
    assert.ok(adminSrc.includes("router.post('/members/:id/grant-peer-status'"), 'route must be registered');
  });

  test('protected by adminAuth at router level', () => {
    assert.match(adminSrc, /router\.use\(adminAuth\)/, 'adminAuth middleware must guard all routes');
  });

  test('SELECT includes peer_quiz_done guard', () => {
    assert.match(routeSrc, /peer_quiz_done/, 'must read peer_quiz_done before updating');
  });

  test('UPDATE sets peer_quiz_done = true and peer_available_until', () => {
    assert.match(routeSrc, /peer_quiz_done = true/);
    assert.match(routeSrc, /INTERVAL '10 years'/);
  });

  test('calls auditLog with member.grant_peer_status action', () => {
    assert.match(routeSrc, /member\.grant_peer_status/);
  });

  test('returns ALREADY_PEER code on duplicate grant', () => {
    assert.match(routeSrc, /ALREADY_PEER/);
  });

  test('GET /admin/members SELECT includes peer_quiz_done', () => {
    const memberGetSrc = adminSrc.slice(
      adminSrc.indexOf('GET /admin/members'),
      adminSrc.indexOf('DELETE /admin/members/:id')
    );
    assert.match(memberGetSrc, /u\.peer_quiz_done/, 'GET members must return peer_quiz_done for frontend badge');
  });
});
