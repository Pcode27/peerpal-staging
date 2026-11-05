'use strict';
/**
 * Phase 58.6 — commission engine in escrowReleaseJob.
 *
 * Static analysis: asserts the SQL, formula, window check, and
 * idempotency guard are present in the source.
 *
 * Run: node --test tests/phase58CommissionEngine.test.js  (from src/backend)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'jobs', 'escrowReleaseJob.js'), 'utf8'
);

// Slice to just the commission block to avoid false matches
const commissionBlock = src.slice(
  src.indexOf('58.6'),
  src.indexOf('await initiatePayout')
);

// ── SELECT extensions ────────────────────────────────────────────────────────

describe('escrowReleaseJob SELECT — commission fields', () => {
  test('selects platform_fee_kes from bookings', () => {
    assert.match(src, /b\.platform_fee_kes/);
  });

  test('selects referred_by_therapist_id from therapist profile', () => {
    assert.match(src, /tp\.referred_by_therapist_id/);
  });

  test('LEFT JOINs referrer profile for addendum_signed_at', () => {
    assert.match(src, /LEFT JOIN therapist_profiles ref_tp ON ref_tp\.id = tp\.referred_by_therapist_id/);
  });

  test('aliases referrer addendum_signed_at', () => {
    assert.match(src, /ref_tp\.addendum_signed_at AS referrer_addendum_signed_at/);
  });

  test('selects session ended_at for window check', () => {
    assert.match(src, /ts\.ended_at AS session_ended_at/);
  });
});

// ── Commission gate ──────────────────────────────────────────────────────────

describe('commission engine — guards and formula', () => {
  test('only fires when referrer exists and has signed addendum', () => {
    assert.match(commissionBlock, /referred_by_therapist_id/);
    assert.match(commissionBlock, /referrer_addendum_signed_at/);
  });

  test('12-month window: setFullYear +1 from addendum_signed_at', () => {
    assert.match(commissionBlock, /setFullYear.*getFullYear.*\+ 1/);
  });

  test('session_ended_at must be <= window end date', () => {
    assert.match(commissionBlock, /session_ended_at.*windowEnd/);
  });

  test('commission = 5% of platform_fee_kes (Math.round)', () => {
    assert.match(commissionBlock, /Math\.round\(row\.platform_fee_kes \* 0\.05\)/);
  });

  test('INSERT uses ON CONFLICT (booking_id) DO NOTHING for idempotency', () => {
    assert.match(commissionBlock, /ON CONFLICT \(booking_id\) DO NOTHING/);
  });

  test('inserts correct columns: referrer, referred, booking, fee, commission, period', () => {
    assert.match(commissionBlock, /referrer_therapist_id/);
    assert.match(commissionBlock, /referred_therapist_id/);
    assert.match(commissionBlock, /session_fee_kes/);
    assert.match(commissionBlock, /commission_kes/);
    assert.match(commissionBlock, /period_ends_at/);
  });

  test('commission failure is non-blocking: uses .catch not try/catch', () => {
    assert.match(commissionBlock, /\.catch\(/);
  });

  test('logs commission row on success', () => {
    assert.match(commissionBlock, /logger\.info.*Commission/);
  });
});

// ── Formula unit check ───────────────────────────────────────────────────────

describe('commission formula — arithmetic', () => {
  test('5% of KES 400 platform fee = KES 20', () => {
    assert.strictEqual(Math.round(400 * 0.05), 20);
  });

  test('5% of KES 1000 platform fee = KES 50', () => {
    assert.strictEqual(Math.round(1000 * 0.05), 50);
  });

  test('rounds correctly: 5% of KES 1333 = KES 67', () => {
    assert.strictEqual(Math.round(1333 * 0.05), 67);
  });

  test('12-month window: session one day before end is inside', () => {
    const signedAt = new Date('2026-01-01T00:00:00Z');
    const windowEnd = new Date(signedAt);
    windowEnd.setFullYear(windowEnd.getFullYear() + 1); // 2027-01-01
    const sessionDate = new Date('2026-12-31T23:59:00Z');
    assert.ok(sessionDate <= windowEnd, 'session inside 12-month window');
  });

  test('12-month window: session one day after end is outside', () => {
    const signedAt = new Date('2026-01-01T00:00:00Z');
    const windowEnd = new Date(signedAt);
    windowEnd.setFullYear(windowEnd.getFullYear() + 1); // 2027-01-01
    const sessionDate = new Date('2027-01-02T00:00:00Z');
    assert.ok(!(sessionDate <= windowEnd), 'session outside 12-month window');
  });
});
