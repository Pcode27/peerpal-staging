'use strict';
/**
 * Phase 58.3 — authenticated + admin referral endpoints.
 *
 * Unit:   sign-addendum idempotency logic.
 * Static: therapy.js + admin.js guards, SQL correctness, error codes.
 *
 * Run: node --test tests/phase58Routes.test.js  (from src/backend)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const therapySrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'therapy.js'), 'utf8');
const adminSrc   = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'),   'utf8');

// Slice just the 58.x sections to avoid false matches from other routes
const profileGet    = therapySrc.slice(therapySrc.indexOf('GET /therapy/therapist/profile'), therapySrc.indexOf('PATCH /therapy/therapist/profile'));
const signAddendum  = therapySrc.slice(therapySrc.indexOf('POST /therapy/therapist/sign-addendum'), therapySrc.indexOf('GET /therapy/therapist/my-referrals'));
const myReferrals   = therapySrc.slice(therapySrc.indexOf('GET /therapy/therapist/my-referrals'),   therapySrc.indexOf('GET /therapy/therapist/my-commissions'));
const myCommissions = therapySrc.slice(therapySrc.indexOf('GET /therapy/therapist/my-commissions'), therapySrc.indexOf('GET /therapy/referral-code/:code'));
const adminList     = adminSrc.slice(adminSrc.indexOf('GET /admin/referral-applications'),   adminSrc.indexOf('PATCH /admin/referral-applications/:id'));
const adminPatch    = adminSrc.slice(adminSrc.indexOf('PATCH /admin/referral-applications/:id'), adminSrc.indexOf('module.exports = router'));

// ── GET /therapy/therapist/profile (58.5 addition) ──────────────────────────

describe('GET /therapist/profile — 58.5 referral fields', () => {
  test('requires therapistAuth middleware', () => {
    assert.match(profileGet, /therapistAuth/);
  });

  test('SELECT includes addendum_signed_at', () => {
    assert.match(profileGet, /addendum_signed_at/);
  });

  test('SELECT includes referral_code', () => {
    assert.match(profileGet, /referral_code/);
  });

  test('returns profile wrapped in profile key', () => {
    assert.match(profileGet, /profile: rows\[0\]/);
  });

  test('returns 404 when profile not found', () => {
    assert.match(profileGet, /status\(404\)/);
    assert.match(profileGet, /NOT_FOUND/);
  });
});

// ── POST /therapy/therapist/sign-addendum ────────────────────────────────────

describe('POST /therapist/sign-addendum — guards', () => {
  test('requires therapistAuth middleware', () => {
    assert.match(signAddendum, /therapistAuth/);
  });

  test('idempotent: returns existing code if already_signed', () => {
    assert.match(signAddendum, /already_signed: true/);
    assert.match(signAddendum, /addendum_signed_at/);
  });

  test('calls generateTherapistReferralCode — not generateReferralCode', () => {
    assert.match(signAddendum, /generateTherapistReferralCode/);
    assert.ok(!signAddendum.includes('generateReferralCode('), 'must not call user referral code generator');
  });

  test('UPDATE sets both addendum_signed_at and referral_code atomically', () => {
    assert.match(signAddendum, /SET addendum_signed_at = NOW\(\), referral_code = \$1/);
  });

  test('returns referral_code in response', () => {
    assert.match(signAddendum, /referral_code: code/);
  });
});

// ── GET /therapy/therapist/my-referrals ─────────────────────────────────────

describe('GET /therapist/my-referrals — guards', () => {
  test('requires therapistAuth middleware', () => {
    assert.match(myReferrals, /therapistAuth/);
  });

  test('filters by referred_by_therapist_id = current therapist', () => {
    assert.match(myReferrals, /referred_by_therapist_id = \$1/);
  });

  test('returns referrals array', () => {
    assert.match(myReferrals, /referrals: rows/);
  });

  test('includes addendum_signed_at to show referral state', () => {
    assert.match(myReferrals, /addendum_signed_at/);
  });
});

// ── GET /therapy/therapist/my-commissions ────────────────────────────────────

describe('GET /therapist/my-commissions — guards', () => {
  test('requires therapistAuth middleware', () => {
    assert.match(myCommissions, /therapistAuth/);
  });

  test('filters commissions by referrer_therapist_id = current therapist', () => {
    assert.match(myCommissions, /referrer_therapist_id = \$1/);
  });

  test('JOINs therapist_profiles for referred therapist name', () => {
    assert.match(myCommissions, /JOIN therapist_profiles tp ON tp\.id = tc\.referred_therapist_id/);
  });

  test('computes total_pending_kes from pending rows only', () => {
    assert.match(myCommissions, /status === 'pending'/);
    assert.match(myCommissions, /total_pending_kes/);
  });

  test('computes total_paid_kes from paid rows only', () => {
    assert.match(myCommissions, /status === 'paid'/);
    assert.match(myCommissions, /total_paid_kes/);
  });
});

// ── GET /admin/referral-applications ─────────────────────────────────────────

describe('GET /admin/referral-applications — guards', () => {
  test('admin route file uses adminAuth middleware globally', () => {
    assert.match(adminSrc, /router\.use\(adminAuth\)/);
  });

  test('supports optional status filter via query param', () => {
    assert.match(adminList, /req\.query/);
    assert.match(adminList, /status/);
  });

  test('JOINs therapist_profiles for referrer and linked therapist names', () => {
    assert.match(adminList, /referrer_name/);
    assert.match(adminList, /linked_therapist_name/);
  });

  test('returns applications array ordered by created_at DESC', () => {
    assert.match(adminList, /ORDER BY a\.created_at DESC/);
    assert.match(adminList, /applications: rows/);
  });
});

// ── PATCH /admin/referral-applications/:id ───────────────────────────────────

describe('PATCH /admin/referral-applications/:id — guards', () => {
  test('validates status against allowed enum values', () => {
    assert.match(adminPatch, /INVALID_STATUS/);
    assert.match(adminPatch, /'pending', 'account_created', 'rejected'/);
  });

  test('returns 404 when application not found', () => {
    assert.match(adminPatch, /status\(404\)/);
    assert.match(adminPatch, /Application not found/);
  });

  test('writes audit log on every status update', () => {
    assert.match(adminPatch, /auditLog/);
    assert.match(adminPatch, /referral_application\.update/);
  });

  test('COALESCE preserves existing admin_notes if not provided', () => {
    assert.match(adminPatch, /COALESCE\(\$2, admin_notes\)/);
  });

  test('COALESCE preserves existing therapist_profile_id if not provided', () => {
    assert.match(adminPatch, /COALESCE\(\$3::uuid, therapist_profile_id\)/);
  });

  test('returns updated application in response', () => {
    assert.match(adminPatch, /updated: true/);
    assert.match(adminPatch, /application: rows\[0\]/);
  });
});
