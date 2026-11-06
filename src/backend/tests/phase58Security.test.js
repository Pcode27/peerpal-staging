'use strict';
/**
 * Phase 58 — Security tests (unit / static analysis).
 *
 * Covers:
 *   A. Auth guards — all therapist-side routes use therapistAuth
 *   B. Public routes — rate-limited, never use therapistAuth
 *   C. Input sanitization — join route validates and limits all fields
 *   D. Cross-therapist isolation — my-commissions/my-referrals scope to req.therapist.profile_id
 *   E. Namespace isolation — user and therapist referral systems use separate tables and generators
 *
 * Run: node --test tests/phase58Security.test.js  (from src/backend)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const therapyRoute   = fs.readFileSync(path.join(__dirname, '..', 'routes', 'therapy.js'),  'utf8');
const commissionJob  = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'escrowReleaseJob.js'), 'utf8');
const payoutJob      = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'referralPayoutJob.js'), 'utf8');
const referralSvc    = fs.readFileSync(path.join(__dirname, '..', 'services', 'referrals.js'), 'utf8');
const referralCode   = fs.readFileSync(path.join(__dirname, '..', 'utils', 'referralCode.js'), 'utf8');

// ── A. Auth guards ────────────────────────────────────────────────────────────

describe('Auth guards — therapist-side routes', () => {
  test('sign-addendum uses therapistAuth', () => {
    assert.match(therapyRoute, /router\.post\('\/therapist\/sign-addendum',\s*therapistAuth/);
  });

  test('my-referrals uses therapistAuth', () => {
    assert.match(therapyRoute, /router\.get\('\/therapist\/my-referrals',\s*therapistAuth/);
  });

  test('my-commissions uses therapistAuth', () => {
    assert.match(therapyRoute, /router\.get\('\/therapist\/my-commissions',\s*therapistAuth/);
  });

  test('therapistAuth is imported', () => {
    assert.match(therapyRoute, /therapistAuth\s*=\s*require/);
  });
});

// ── B. Public routes — rate-limited ──────────────────────────────────────────

describe('Public routes — rate limiting', () => {
  test('referral-code lookup uses publicFormLimiter', () => {
    assert.match(therapyRoute, /router\.get\('\/referral-code\/:code',\s*publicFormLimiter/);
  });

  test('referral-applications uses publicFormLimiter', () => {
    assert.match(therapyRoute, /router\.post\('\/referral-applications',\s*publicFormLimiter/);
  });

  test('publicFormLimiter is imported', () => {
    assert.match(therapyRoute, /publicFormLimiter/);
  });

  test('referral-code lookup has no therapistAuth', () => {
    // The route must not accidentally require therapist auth
    const routeBlock = therapyRoute.match(
      /router\.get\('\/referral-code\/:code'[\s\S]{0,300}?\}\);/
    )?.[0] ?? '';
    assert.ok(!routeBlock.includes('therapistAuth'), 'referral-code should be public');
  });

  test('referral-applications has no therapistAuth', () => {
    const routeBlock = therapyRoute.match(
      /router\.post\('\/referral-applications'[\s\S]{0,300}?\}\);/
    )?.[0] ?? '';
    assert.ok(!routeBlock.includes('therapistAuth'), 'referral-applications should be public');
  });
});

// ── C. Input sanitization ────────────────────────────────────────────────────

describe('Input sanitization — referral-applications route', () => {
  test('required-fields check includes full_legal_name, email, phone, signature_name', () => {
    assert.match(therapyRoute, /full_legal_name.*trim\(\)|!full_legal_name\?\.trim\(\)/);
    assert.match(therapyRoute, /email.*trim\(\)|!email\?\.trim\(\)/);
    assert.match(therapyRoute, /phone.*trim\(\)|!phone\?\.trim\(\)/);
    assert.match(therapyRoute, /signature_name.*trim\(\)|!signature_name\?\.trim\(\)/);
  });

  test('full_legal_name has length limit 255', () => {
    assert.match(therapyRoute, /full_legal_name\.trim\(\)\.length > 255/);
  });

  test('phone has length limit 30', () => {
    assert.match(therapyRoute, /phone\.trim\(\)\.length > 30/);
  });

  test('signature_name has length limit 255', () => {
    assert.match(therapyRoute, /signature_name\.trim\(\)\.length > 255/);
  });

  test('email validated with regex', () => {
    // Route uses: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    assert.ok(therapyRoute.includes('[^\\s@]+@[^\\s@]+'), 'email must be validated with a regex');
  });

  test('doc_version is whitelisted', () => {
    assert.match(therapyRoute, /ALLOWED_DOC_VERSIONS/);
    assert.match(therapyRoute, /includes\(doc_version\)/);
  });

  test('ref_code passes through normalizeReferralCode before DB lookup', () => {
    // The raw value from req.body must be normalised before any query
    assert.match(therapyRoute, /normalizeReferralCode\(ref_code\)/);
  });

  test('signature must match full_legal_name (case-insensitive)', () => {
    assert.match(therapyRoute, /full_legal_name\.trim\(\)\.toLowerCase\(\).*signature_name\.trim\(\)\.toLowerCase\(\)/);
  });

  test('referral-applications uses parameterized query (no string interpolation)', () => {
    // Find the INSERT block and ensure it uses $N placeholders
    const insertBlock = therapyRoute.match(/INSERT INTO therapist_referral_applications[\s\S]{0,500}VALUES[\s\S]{0,200}/)?.[0] ?? '';
    assert.match(insertBlock, /\$1/);
    assert.ok(!insertBlock.includes("'${"), 'No template-literal interpolation in INSERT');
  });

  test('referral-code lookup uses parameterized query', () => {
    const selectBlock = therapyRoute.match(/SELECT.*FROM therapist_profiles WHERE referral_code = \$1[\s\S]{0,100}/)?.[0] ?? '';
    assert.ok(selectBlock.length > 0, 'referral_code lookup must be parameterised');
  });
});

// ── D. Cross-therapist isolation ─────────────────────────────────────────────

describe('Cross-therapist data isolation', () => {
  test('my-commissions scopes to req.therapist.profile_id', () => {
    // The commissions query must filter by the authenticated therapist's ID, not a req.body param
    const commissionBlock = therapyRoute.match(
      /my-commissions[\s\S]{0,800}ORDER BY/
    )?.[0] ?? '';
    assert.match(commissionBlock, /WHERE tc\.referrer_therapist_id = \$1/);
    assert.match(commissionBlock, /req\.therapist\.profile_id/);
  });

  test('my-referrals scopes to req.therapist.profile_id', () => {
    const referralsBlock = therapyRoute.match(
      /my-referrals[\s\S]{0,600}ORDER BY/
    )?.[0] ?? '';
    assert.match(referralsBlock, /WHERE tp\.referred_by_therapist_id = \$1/);
    assert.match(referralsBlock, /req\.therapist\.profile_id/);
  });

  test('sign-addendum reads therapistId from req.therapist, not req.body', () => {
    const signBlock = therapyRoute.match(
      /sign-addendum[\s\S]{0,600}therapistId/
    )?.[0] ?? '';
    assert.match(signBlock, /req\.therapist\.profile_id/);
    // Must NOT use req.body.therapist_id or similar
    assert.ok(!signBlock.includes('req.body.therapist'), 'therapistId must come from middleware, not body');
  });
});

// ── E. Namespace isolation — user vs therapist referral ───────────────────────

describe('Namespace isolation — user and therapist referral systems', () => {
  test('generateTherapistReferralCode checks therapist_profiles, not users', () => {
    assert.match(referralCode, /SELECT 1 FROM therapist_profiles WHERE referral_code/);
  });

  test('generateReferralCode (user) checks users table, not therapist_profiles', () => {
    assert.match(referralCode, /SELECT 1 FROM users WHERE referral_code/);
  });

  test('services/referrals.js (Phase 46) never touches therapist_commissions', () => {
    assert.ok(!referralSvc.includes('therapist_commissions'), 'user referral service must not touch therapist_commissions');
  });

  test('services/referrals.js never touches therapist_commission_payouts', () => {
    assert.ok(!referralSvc.includes('therapist_commission_payouts'), 'user referral service must not touch therapist_commission_payouts');
  });

  test('services/referrals.js never touches therapist_referral_applications', () => {
    assert.ok(!referralSvc.includes('therapist_referral_applications'), 'user referral service must not touch referral_applications');
  });

  test('escrowReleaseJob never touches referral_rewards (user reward table)', () => {
    assert.ok(!commissionJob.includes('referral_rewards'), 'commission engine must not touch user reward table');
  });

  test('escrowReleaseJob reads referred_by_therapist_id, not users.referred_by (user chain)', () => {
    // Phase 58 legitimately reads therapist_profiles.referred_by_therapist_id.
    // Guard: it must never query users.referred_by (the Phase 46 user referral column).
    assert.match(commissionJob, /referred_by_therapist_id/);
    assert.ok(!commissionJob.includes('users.referred_by'), 'must not read Phase 46 user referral column');
  });

  test('referralPayoutJob never touches referral_rewards', () => {
    assert.ok(!payoutJob.includes('referral_rewards'), 'payout job must not touch user reward table');
  });

  test('referralPayoutJob never touches credits table', () => {
    assert.ok(!payoutJob.includes('credits'), 'payout job must not touch user credits');
  });

  test('normalizeReferralCode is shared — same format, different table lookup', () => {
    // Both systems share the same code normaliser — this is intentional.
    // The safety comes from separate table lookups, not separate formats.
    assert.match(referralCode, /module\.exports.*normalizeReferralCode/);
    assert.match(referralCode, /generateReferralCode/);
    assert.match(referralCode, /generateTherapistReferralCode/);
  });
});
