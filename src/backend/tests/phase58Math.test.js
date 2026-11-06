'use strict';
/**
 * Phase 58 — Commission math tests.
 *
 * Verifies:
 *   A. Commission formula: Math.round(platform_fee_kes * 0.05)
 *   B. Boundary rounding cases
 *   C. 12-month window boundary (session exactly at boundary / one second over)
 *   D. Formula present and correct in escrowReleaseJob source
 *   E. Math consistency: commission is always ≤ platform_fee_kes
 *
 * Run: node --test tests/phase58Math.test.js  (from src/backend)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const escrowSrc = fs.readFileSync(
  path.join(__dirname, '..', 'jobs', 'escrowReleaseJob.js'), 'utf8'
);

// Pure commission formula — mirrors escrowReleaseJob logic
function commission(platform_fee_kes) {
  return Math.round(platform_fee_kes * 0.05);
}

// Mirrors escrowReleaseJob window check
function withinWindow(addendum_signed_at, session_ended_at) {
  const windowEnd = new Date(addendum_signed_at);
  windowEnd.setFullYear(windowEnd.getFullYear() + 1);
  return new Date(session_ended_at) <= windowEnd;
}

// ── A. Commission formula ─────────────────────────────────────────────────────

describe('Commission formula — Math.round(platform_fee_kes * 0.05)', () => {
  test('standard: KES 2000 session, 400 platform fee → 20 commission', () => {
    assert.strictEqual(commission(400), 20);
  });

  test('KES 1000 session, 200 platform fee → 10 commission', () => {
    assert.strictEqual(commission(200), 10);
  });

  test('KES 500 session, 100 platform fee → 5 commission', () => {
    assert.strictEqual(commission(100), 5);
  });

  test('KES 3000 session, 600 platform fee → 30 commission', () => {
    assert.strictEqual(commission(600), 30);
  });

  test('KES 10000 session, 2000 platform fee → 100 commission', () => {
    assert.strictEqual(commission(2000), 100);
  });
});

// ── B. Rounding boundary cases ────────────────────────────────────────────────

describe('Rounding boundary cases', () => {
  test('zero fee → 0 commission (no negative/NaN)', () => {
    assert.strictEqual(commission(0), 0);
  });

  test('fee = 1 → 0 commission (Math.round(0.05) = 0)', () => {
    assert.strictEqual(commission(1), 0);
  });

  test('fee = 10 → 1 commission (Math.round(0.5) = 1, ties round up in JS)', () => {
    // Math.round(10 * 0.05) = Math.round(0.5) = 1 in JS (round-half-up)
    assert.strictEqual(commission(10), 1);
  });

  test('fee = 9 → 0 commission (Math.round(0.45) = 0)', () => {
    assert.strictEqual(commission(9), 0);
  });

  test('fee = 11 → 1 commission (Math.round(0.55) = 1)', () => {
    assert.strictEqual(commission(11), 1);
  });

  test('fee = 20 → 1 commission', () => {
    assert.strictEqual(commission(20), 1);
  });

  test('commission is always <= platform_fee_kes', () => {
    for (const fee of [0, 1, 10, 50, 100, 400, 1000, 5000]) {
      assert.ok(commission(fee) <= fee, `commission(${fee}) should be <= fee`);
    }
  });

  test('commission is always >= 0', () => {
    for (const fee of [0, 1, 5, 10, 100]) {
      assert.ok(commission(fee) >= 0, `commission(${fee}) should be >= 0`);
    }
  });
});

// ── C. 12-month window boundary ───────────────────────────────────────────────

describe('12-month commission window', () => {
  const BASE = '2026-01-15T00:00:00.000Z'; // addendum_signed_at

  test('session exactly at window end is included', () => {
    // windowEnd = 2027-01-15T00:00:00.000Z; session at that exact moment
    const windowEnd = new Date(BASE);
    windowEnd.setFullYear(windowEnd.getFullYear() + 1);
    assert.ok(withinWindow(BASE, windowEnd.toISOString()));
  });

  test('session one millisecond before window end is included', () => {
    const windowEnd = new Date(BASE);
    windowEnd.setFullYear(windowEnd.getFullYear() + 1);
    const justBefore = new Date(windowEnd.getTime() - 1);
    assert.ok(withinWindow(BASE, justBefore.toISOString()));
  });

  test('session one millisecond after window end is excluded', () => {
    const windowEnd = new Date(BASE);
    windowEnd.setFullYear(windowEnd.getFullYear() + 1);
    const justAfter = new Date(windowEnd.getTime() + 1);
    assert.ok(!withinWindow(BASE, justAfter.toISOString()));
  });

  test('session 6 months in is included', () => {
    const sixMonths = new Date(BASE);
    sixMonths.setMonth(sixMonths.getMonth() + 6);
    assert.ok(withinWindow(BASE, sixMonths.toISOString()));
  });

  test('session 2 years later is excluded', () => {
    const twoYears = new Date(BASE);
    twoYears.setFullYear(twoYears.getFullYear() + 2);
    assert.ok(!withinWindow(BASE, twoYears.toISOString()));
  });

  test('window is calendar-year (not 365 days) — leap year safe', () => {
    // addendum signed 2024-02-28 (leap year); window end is 2025-02-28
    const leapBase = '2024-02-28T12:00:00.000Z';
    const justBeforeEnd = new Date('2025-02-28T11:59:59.999Z');
    const justAfterEnd  = new Date('2025-02-28T12:00:00.001Z');
    assert.ok(withinWindow(leapBase, justBeforeEnd.toISOString()));
    assert.ok(!withinWindow(leapBase, justAfterEnd.toISOString()));
  });
});

// ── D. Source code assertions ──────────────────────────────────────────────────

describe('escrowReleaseJob source — formula correctness', () => {
  test('commission formula uses platform_fee_kes * 0.05', () => {
    assert.match(escrowSrc, /platform_fee_kes \* 0\.05/);
  });

  test('Math.round is applied to the formula', () => {
    assert.match(escrowSrc, /Math\.round\(.*platform_fee_kes \* 0\.05\)/);
  });

  test('window uses setFullYear +1 (calendar year, not milliseconds)', () => {
    assert.match(escrowSrc, /setFullYear\(.*getFullYear\(\) \+ 1\)/);
  });

  test('window comparison uses <= (session at boundary is included)', () => {
    assert.match(escrowSrc, /new Date\(row\.session_ended_at\) <= windowEnd/);
  });

  test('commission INSERT uses platform_fee_kes, not client_charge_kes or therapist_rate_kes', () => {
    // Commission is 5% of PeerPal's cut, not the full session charge
    const insertBlock = escrowSrc.match(/INSERT INTO therapist_commissions[\s\S]{0,500}/)?.[0] ?? '';
    assert.match(insertBlock, /platform_fee_kes/);
    assert.ok(!insertBlock.includes('client_charge_kes'), 'commission must not use client charge');
    assert.ok(!insertBlock.includes('therapist_rate_kes'), 'commission must not use therapist rate');
  });
});
