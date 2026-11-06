'use strict';
/**
 * Phase 58.7 — referral payout job.
 *
 * Unit: eatMonthString correctness, arithmetic edge cases.
 * Static: SQL guards, idempotency, transaction usage, skip logic.
 *
 * Run: node --test tests/phase58PayoutJob.test.js  (from src/backend)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const { eatMonthString } = require('../jobs/referralPayoutJob');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'jobs', 'referralPayoutJob.js'), 'utf8'
);

// ── eatMonthString ───────────────────────────────────────────────────────────

describe('eatMonthString', () => {
  test('returns YYYY-MM format', () => {
    const result = eatMonthString(new Date('2026-11-05T00:00:00Z'));
    assert.match(result, /^\d{4}-\d{2}$/);
  });

  test('uses Africa/Nairobi timezone (EAT = UTC+3)', () => {
    // 2026-10-31 at 23:00 UTC = 2026-11-01 02:00 EAT — month is November in EAT
    const result = eatMonthString(new Date('2026-10-31T23:00:00Z'));
    assert.strictEqual(result, '2026-11');
  });

  test('UTC month boundary: 2026-11-01 00:00 UTC = still November in EAT', () => {
    const result = eatMonthString(new Date('2026-11-01T00:00:00Z'));
    assert.strictEqual(result, '2026-11');
  });

  test('returns current month string without throwing', () => {
    const result = eatMonthString();
    assert.match(result, /^\d{4}-\d{2}$/);
  });
});

// ── Static analysis — SQL and logic guards ───────────────────────────────────

describe('referralPayoutJob — SQL guards', () => {
  test('filters commissions by status = pending', () => {
    assert.match(src, /status = 'pending'/);
  });

  test('excludes referrers already batched this month via NOT EXISTS', () => {
    assert.match(src, /NOT EXISTS/);
    assert.match(src, /period_month = \$1/);
  });

  test('groups by referrer and sums commissions', () => {
    assert.match(src, /GROUP BY tc\.referrer_therapist_id/);
    assert.match(src, /SUM\(tc\.commission_kes\)/);
  });

  test('HAVING clause skips zero-total referrers', () => {
    assert.match(src, /HAVING SUM\(tc\.commission_kes\) > 0/);
  });

  test('JOINs therapist_profiles for mpesa_number', () => {
    assert.match(src, /JOIN therapist_profiles tp ON tp\.id = tc\.referrer_therapist_id/);
  });

  test('skips referrers with no M-Pesa number', () => {
    assert.match(src, /mpesa_number/);
    assert.match(src, /skipping/);
  });
});

describe('referralPayoutJob — payout insert', () => {
  test('inserts into therapist_commission_payouts', () => {
    assert.match(src, /INSERT INTO therapist_commission_payouts/);
  });

  test('ON CONFLICT (referrer_therapist_id, period_month) DO NOTHING for idempotency', () => {
    assert.match(src, /ON CONFLICT \(referrer_therapist_id, period_month\) DO NOTHING/);
  });

  test('uses transaction() to wrap payout insert + commission update atomically', () => {
    assert.match(src, /transaction\(/);
  });

  test('updates commissions to paid inside the same transaction', () => {
    assert.match(src, /SET status = 'paid'/);
    assert.match(src, /WHERE id = ANY\(\$1\)/);
    assert.match(src, /AND status = 'pending'/);
  });

  test('aggregate SELECT collects commission_ids for precise UPDATE scoping', () => {
    assert.match(src, /array_agg\(tc\.id\) AS commission_ids/);
  });

  test('checks rowCount after insert to detect conflict skip', () => {
    assert.match(src, /rowCount === 0/);
  });

  test('payout status starts as pending', () => {
    assert.match(src, /'pending'/);
  });

  test('logs payout created with KES amount and month', () => {
    assert.match(src, /logger\.info/);
    assert.match(src, /Payout created/);
  });
});

describe('referralPayoutJob — server.js wiring', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  test('imported in server.js', () => {
    assert.match(serverSrc, /runReferralPayoutJob/);
  });

  test('scheduled on 1st of month at 06:00 UTC (09:00 EAT)', () => {
    assert.match(serverSrc, /0 6 1 \* \*/);
  });
});
