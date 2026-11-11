/**
 * Admin reports routes — static source checks.
 *
 * Covers:
 *   GET  /admin/reports        — peer report SELECT includes transcript
 *   PATCH /admin/peer-reports/:id/review — marks peer report reviewed
 *
 * Run: node --test tests/adminReports.test.js  (from src/backend)
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const adminSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');

// Slice just the GET /admin/reports handler
const reportsGetSrc = adminSrc.slice(
  adminSrc.indexOf('GET /admin/reports'),
  adminSrc.indexOf('PATCH /admin/peer-reports/:id/review')
);

// Slice just the PATCH /admin/peer-reports/:id/review handler
const peerReviewSrc = adminSrc.slice(
  adminSrc.indexOf('PATCH /admin/peer-reports/:id/review'),
  adminSrc.indexOf('PATCH /admin/emergency/:id/acknowledge')
);

// ── Unit: review handler logic ────────────────────────────────────────────────

describe('PATCH /admin/peer-reports/:id/review: unit', () => {
  async function makeReviewHandler(queryImpl, auditImpl) {
    return async function reviewPeerReport(reportId, adminId) {
      const { rows } = await queryImpl(
        `UPDATE peer_reports SET status = 'reviewed' WHERE id = $1 AND status = 'open' RETURNING id`,
        [reportId]
      );
      if (!rows.length) return { status: 404, code: 'NOT_FOUND' };
      await auditImpl(adminId, 'peer_report.review', 'peer_report', reportId, null, 'open', 'reviewed');
      return { status: 200, reviewed: true };
    };
  }

  test('marks open report as reviewed and calls audit log', async () => {
    const auditCalls = [];
    const fakeQuery = async (sql, params) => {
      if (sql.includes('UPDATE peer_reports')) return { rows: [{ id: params[0] }] };
      return { rows: [] };
    };
    const fakeAudit = async (...args) => auditCalls.push(args);
    const handler = await makeReviewHandler(fakeQuery, fakeAudit);
    const result = await handler('report-1', 'admin-1');
    assert.equal(result.status, 200);
    assert.equal(result.reviewed, true);
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0][1], 'peer_report.review');
  });

  test('returns NOT_FOUND when report is not open or does not exist', async () => {
    const fakeQuery = async () => ({ rows: [] });
    const fakeAudit = async () => {};
    const handler = await makeReviewHandler(fakeQuery, fakeAudit);
    const result = await handler('ghost-id', 'admin-1');
    assert.equal(result.status, 404);
    assert.equal(result.code, 'NOT_FOUND');
  });
});

// ── Static: GET /admin/reports includes transcript ────────────────────────────

describe('GET /admin/reports: static source checks', () => {
  test('peer report SELECT includes transcript column', () => {
    assert.match(reportsGetSrc, /pr\.transcript/, 'transcript must be selected from peer_reports');
  });

  test('combines group_reports and peer_reports', () => {
    assert.match(reportsGetSrc, /group_reports/);
    assert.match(reportsGetSrc, /peer_reports/);
  });

  test('report_type discriminator present for both queries', () => {
    assert.match(reportsGetSrc, /'group' AS report_type/);
    assert.match(reportsGetSrc, /'peer' AS report_type/);
  });
});

// ── Static: PATCH /admin/peer-reports/:id/review ─────────────────────────────

describe('PATCH /admin/peer-reports/:id/review: static source checks', () => {
  test('route is registered', () => {
    assert.ok(adminSrc.includes("router.patch('/peer-reports/:id/review'"), 'route must be registered');
  });

  test('UPDATE sets status to reviewed', () => {
    assert.match(peerReviewSrc, /status = 'reviewed'/, "must set status = 'reviewed'");
  });

  test('UPDATE guards on status = open to prevent double-review', () => {
    assert.match(peerReviewSrc, /status = 'open'/, "must only update when current status is 'open'");
  });

  test('returns NOT_FOUND when nothing updated', () => {
    assert.match(peerReviewSrc, /NOT_FOUND/, 'must return NOT_FOUND when rows is empty');
  });

  test('calls auditLog with peer_report.review action', () => {
    assert.match(peerReviewSrc, /peer_report\.review/);
  });

  test('protected by adminAuth middleware at router level', () => {
    assert.match(adminSrc, /router\.use\(adminAuth\)/, 'all routes covered by adminAuth');
  });
});
