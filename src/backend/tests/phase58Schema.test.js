'use strict';
/**
 * Phase 58 — 58.1 schema + utility tests.
 *
 * Unit: generateTherapistReferralCode — collision retry, exhaustion, checks right table.
 * Schema: migration 116 file shape, rollback exists, CHECK constraints present.
 *
 * Run: node --test tests/phase58Schema.test.js   (from src/backend)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');

// ── generateTherapistReferralCode ────────────────────────────────────────────

describe('generateTherapistReferralCode', () => {
  const { generateTherapistReferralCode, generateReferralCode, randomCode, MAX_ATTEMPTS } = require('../utils/referralCode');

  test('returns 6-char uppercase base36 on first clean attempt', async () => {
    const db = { query: async () => ({ rows: [] }) };
    const code = await generateTherapistReferralCode(db);
    assert.match(code, /^[0-9A-Z]{6}$/);
  });

  test('retries on collision and returns first free code', async () => {
    const taken = new Set(['AAAAAA', 'BBBBBB']);
    const seq = ['AAAAAA', 'BBBBBB', 'CCCCCC'];
    const db = { query: async (_sql, [c]) => ({ rows: taken.has(c) ? [{}] : [] }) };
    const code = await generateTherapistReferralCode(db, () => seq.shift());
    assert.equal(code, 'CCCCCC');
  });

  test(`throws after ${MAX_ATTEMPTS} collisions`, async () => {
    let calls = 0;
    const db = { query: async () => { calls++; return { rows: [{}] }; } };
    await assert.rejects(generateTherapistReferralCode(db, () => 'AAAAAA'), /collision/);
    assert.equal(calls, MAX_ATTEMPTS);
  });

  test('queries therapist_profiles, not users', async () => {
    const tables = [];
    const db = {
      query: async (sql) => {
        const m = sql.match(/FROM (\w+)/);
        if (m) tables.push(m[1]);
        return { rows: [] };
      },
    };
    await generateTherapistReferralCode(db);
    assert.ok(tables.every(t => t === 'therapist_profiles'), `expected therapist_profiles, got: ${tables}`);
  });

  test('generateReferralCode still queries users (not broken by Phase 58 change)', async () => {
    const tables = [];
    const db = {
      query: async (sql) => {
        const m = sql.match(/FROM (\w+)/);
        if (m) tables.push(m[1]);
        return { rows: [] };
      },
    };
    await generateReferralCode(db);
    assert.ok(tables.every(t => t === 'users'), `expected users, got: ${tables}`);
  });
});

// ── Migration 116 shape ──────────────────────────────────────────────────────

describe('migration 116 file', () => {
  const fwd = fs.readFileSync(path.join(MIGRATIONS, '116_therapist_referral_programme.sql'), 'utf8');
  const rollback = path.join(MIGRATIONS, '116_therapist_referral_programme_rollback.sql');

  test('rollback file exists', () => {
    assert.ok(fs.existsSync(rollback), 'rollback file missing');
  });

  test('adds required columns to therapist_profiles', () => {
    assert.match(fwd, /referral_code/);
    assert.match(fwd, /referred_by_therapist_id/);
    assert.match(fwd, /addendum_signed_at/);
    assert.match(fwd, /suspended_for_misconduct/);
  });

  test('referred_by_therapist_id uses ON DELETE SET NULL', () => {
    assert.match(fwd, /referred_by_therapist_id[^;]+ON DELETE SET NULL/s);
  });

  test('suspended_for_misconduct defaults to false', () => {
    assert.match(fwd, /suspended_for_misconduct\s+BOOLEAN\s+NOT NULL\s+DEFAULT false/);
  });

  test('creates therapist_referral_applications with status CHECK', () => {
    assert.match(fwd, /CREATE TABLE therapist_referral_applications/);
    assert.match(fwd, /CHECK \(status IN \('pending','account_created','rejected'\)\)/);
  });

  test('creates therapist_commissions with UNIQUE booking_id', () => {
    assert.match(fwd, /CREATE TABLE therapist_commissions/);
    assert.match(fwd, /booking_id\s+UUID\s+NOT NULL\s+REFERENCES therapist_bookings\(id\) UNIQUE/);
  });

  test('referrer_therapist_id is ON DELETE SET NULL on both commission tables', () => {
    // RESTRICT would block deletion of a therapist who referred others
    const commissions = fwd.match(/CREATE TABLE therapist_commissions[\s\S]+?(?=CREATE TABLE)/);
    const payouts = fwd.match(/CREATE TABLE therapist_commission_payouts[\s\S]+/);
    assert.match(commissions[0], /referrer_therapist_id[^\n]+ON DELETE SET NULL/);
    assert.match(payouts[0], /referrer_therapist_id[^\n]+ON DELETE SET NULL/);
  });

  test('reversed_reason only allows refund (misconduct blocks future rows, never reverses existing)', () => {
    assert.match(fwd, /CHECK \(reversed_reason IN \('refund'\)\)/);
  });

  test('creates therapist_commission_payouts with UNIQUE(referrer, period_month)', () => {
    assert.match(fwd, /CREATE TABLE therapist_commission_payouts/);
    assert.match(fwd, /UNIQUE \(referrer_therapist_id, period_month\)/);
  });

  test('rollback drops tables in correct FK order', () => {
    const rb = fs.readFileSync(rollback, 'utf8');
    const payouts = rb.indexOf('therapist_commission_payouts');
    const commissions = rb.indexOf('therapist_commissions');
    const apps = rb.indexOf('therapist_referral_applications');
    assert.ok(payouts < commissions, 'commission_payouts must drop before commissions');
    assert.ok(commissions < apps, 'commissions must drop before applications');
  });
});
