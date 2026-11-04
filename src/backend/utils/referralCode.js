const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5;
const CODE_RE = /^[0-9A-Z]{6}$/;

function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

// User input → canonical code, or null if it can't be a valid code.
// Tolerates spaces, dashes and lower case ("ke7-mx2" → "KE7MX2").
function normalizeReferralCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

// 6-char uppercase base36, checked against users.referral_code. Retries up to 5 times.
// db: anything with .query (the pool module or a transaction client).
// The UNIQUE constraint on users.referral_code is the final guard for a concurrent collision.
async function generateReferralCode(db, random = randomCode) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = random();
    const { rows } = await db.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    if (!rows.length) return code;
  }
  throw new Error(`referral code collision after ${MAX_ATTEMPTS} attempts`);
}

// Same as above but checks therapist_profiles.referral_code (Phase 58).
async function generateTherapistReferralCode(db, random = randomCode) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = random();
    const { rows } = await db.query('SELECT 1 FROM therapist_profiles WHERE referral_code = $1', [code]);
    if (!rows.length) return code;
  }
  throw new Error(`therapist referral code collision after ${MAX_ATTEMPTS} attempts`);
}

module.exports = { generateReferralCode, generateTherapistReferralCode, normalizeReferralCode, randomCode, MAX_ATTEMPTS };
