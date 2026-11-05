'use strict';
/**
 * Phase 58.2 — public referral endpoints.
 *
 * Unit:   normalizeReferralCode edge cases relevant to the endpoint (empty, long, case).
 * Static: therapy.js guards, SQL correctness, error codes.
 *
 * Run: node --test tests/phase58Endpoints.test.js  (from src/backend)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const { normalizeReferralCode } = require('../utils/referralCode');
const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'therapy.js'), 'utf8');

// ── normalizeReferralCode — endpoint-relevant edge cases ─────────────────────

describe('normalizeReferralCode (GET /referral-code/:code guard)', () => {
  test('empty string returns null — endpoint returns {valid:false} without DB hit', () => {
    assert.equal(normalizeReferralCode(''), null);
  });

  test('whitespace-only returns null', () => {
    assert.equal(normalizeReferralCode('   '), null);
  });

  test('valid 6-char code uppercased', () => {
    assert.equal(normalizeReferralCode('abc123'), 'ABC123');
  });

  test('code longer than 10 chars returns null — rejects padding attacks', () => {
    assert.equal(normalizeReferralCode('ABCDEFGHIJK'), null);
  });

  test('code with non-alphanumeric returns null — rejects injection attempts', () => {
    assert.equal(normalizeReferralCode("'; DROP TABLE--"), null);
  });

  test('exactly 6 alphanumeric chars is the only valid length', () => {
    assert.ok(normalizeReferralCode('ABCDEF'),  '6 chars must pass');
    assert.equal(normalizeReferralCode('ABCDE'),   null, '5 chars must fail');
    assert.equal(normalizeReferralCode('ABCDEFG'), null, '7 chars must fail');
  });
});

// ── Static analysis: GET /therapy/referral-code/:code ───────────────────────

describe('GET /referral-code/:code — source guards', () => {
  const handler = src.slice(src.indexOf("GET /therapy/referral-code/:code"), src.indexOf("POST /therapy/referral-applications"));

  test('normalizes code before DB query (no raw req.params.code in SQL)', () => {
    assert.ok(
      handler.includes('normalizeReferralCode(req.params.code)'),
      'must normalize before lookup'
    );
  });

  test('returns {valid:false} for null code without hitting DB', () => {
    assert.match(handler, /if \(!code\).*valid: false/s);
  });

  test('SQL filters is_verified = true — unverified therapists cannot refer', () => {
    assert.match(handler, /is_verified = true/);
  });

  test('SQL selects display_name from therapist_profiles', () => {
    assert.match(handler, /SELECT display_name FROM therapist_profiles WHERE referral_code = \$1/);
  });

  test('DB error returns {valid:false} not a 500 stack trace', () => {
    assert.match(handler, /status\(500\)\.json\(\{ valid: false \}\)/);
  });
});

// ── Static analysis: POST /therapy/referral-applications ────────────────────

describe('POST /referral-applications — validation guards', () => {
  const handler = src.slice(
    src.indexOf("POST /therapy/referral-applications"),
    src.indexOf("module.exports = router")
  );

  test('required fields check returns MISSING_FIELDS code', () => {
    assert.match(handler, /'MISSING_FIELDS'/);
    assert.match(handler, /full_legal_name.*email.*phone.*signature_name/s);
  });

  test('signature mismatch guard uses case-insensitive comparison', () => {
    assert.match(handler, /\.toLowerCase\(\).*\.toLowerCase\(\)/s);
    assert.match(handler, /'SIGNATURE_MISMATCH'/);
  });

  test('signature mismatch is a 400 not a 422', () => {
    assert.match(handler, /status\(400\).*SIGNATURE_MISMATCH/s);
  });

  test('duplicate email check only considers active statuses (not rejected)', () => {
    assert.match(handler, /status IN \('pending','account_created'\)/);
  });

  test('duplicate returns 409 DUPLICATE with support email', () => {
    assert.match(handler, /status\(409\).*DUPLICATE/s);
    assert.match(handler, /support@peer-pal\.com/);
  });

  test('ref_code resolves referrer before insert — not stored raw', () => {
    assert.match(handler, /referrer_therapist_id/);
    assert.match(handler, /SELECT id FROM therapist_profiles WHERE referral_code = \$1 AND is_verified = true/);
  });

  test('invalid ref_code returns 400 INVALID_REF — not silently ignored', () => {
    assert.match(handler, /'INVALID_REF'/);
  });

  test('INSERT captures ip_address from req.ip', () => {
    assert.match(handler, /req\.ip/);
  });

  test('INSERT uses email.trim().toLowerCase() — normalised before store', () => {
    assert.match(handler, /email\.trim\(\)\.toLowerCase\(\)/);
  });

  test('success returns 201 {received:true}', () => {
    assert.match(handler, /status\(201\)\.json\(\{ received: true \}\)/);
  });
});
