/**
 * Integration test for Phase 58.6 — commission engine.
 *
 * Seeds minimal test data, runs runEscrowReleaseJob() directly,
 * asserts a commission row was written, then cleans up.
 *
 * Run: node scripts/_test_58_commission_engine.js  (from src/backend, DB must be reachable)
 *
 * WARNING: writes temporary rows to the live DB and deletes them on exit.
 * Safe to run repeatedly — all inserts use unique UUIDs.
 */
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { query }      = require('../db');
const { runEscrowReleaseJob } = require('../jobs/escrowReleaseJob');

function pass(label) { console.log('  ✔ ' + label); }
function fail(label, detail) { console.log('  ✖ ' + label, detail ?? ''); }

// ── IDs for this run ─────────────────────────────────────────────────────────
const RUN   = uuidv4().slice(0, 8);
const IDS   = {
  referrerUser:    uuidv4(),
  referredUser:    uuidv4(),
  referrerProfile: uuidv4(),
  referredProfile: uuidv4(),
  booking:         uuidv4(),
  session:         uuidv4(),
};

const RATE_KES           = 2000;
const PLATFORM_FEE_KES   = 400;   // 20%
const THERAPIST_PAYOUT   = 1600;  // 80%
const EXPECTED_COMMISSION = 20;   // 5% of 400

// ── Seed helpers ─────────────────────────────────────────────────────────────

async function seed() {
  // Minimal user rows (therapists are 'member' role in users table)
  await query(
    `INSERT INTO users (id, alias, email, password_hash, role)
     VALUES ($1, $2, $3, 'x', 'member'),
            ($4, $5, $6, 'x', 'member')`,
    [IDS.referrerUser, `RefDoc${RUN}`, `ref_${RUN}@test.invalid`,
     IDS.referredUser, `RedDoc${RUN}`, `red_${RUN}@test.invalid`]
  );

  // Referrer profile — has signed addendum 2 months ago
  const addendumDate = new Date();
  addendumDate.setMonth(addendumDate.getMonth() - 2);
  await query(
    `INSERT INTO therapist_profiles
       (id, user_id, display_name, full_name, credentials,
        is_verified, addendum_signed_at, referral_code,
        rate_per_session_kes, mpesa_number, onboarding_complete)
     VALUES ($1, $2, $3, $3, 'Test', true, $4, $5, $6, '0700000001', true)`,
    [IDS.referrerProfile, IDS.referrerUser, `RefDoc_${RUN}`,
     addendumDate.toISOString(), `R${RUN.slice(0,5).toUpperCase()}`, RATE_KES]
  );

  // Referred profile — referred_by_therapist_id points to referrer
  await query(
    `INSERT INTO therapist_profiles
       (id, user_id, display_name, full_name, credentials,
        is_verified, referred_by_therapist_id,
        rate_per_session_kes, mpesa_number, onboarding_complete)
     VALUES ($1, $2, $3, $3, 'Test', true, $4, $5, '0700000002', true)`,
    [IDS.referredProfile, IDS.referredUser, `RedDoc_${RUN}`,
     IDS.referrerProfile, RATE_KES]
  );

  // Completed booking held in escrow — ended 25 hours ago
  const endedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await query(
    `INSERT INTO therapist_bookings
       (id, therapist_id, category_id, member_user_id, session_format,
        scheduled_at, duration_minutes,
        rate_kes, therapist_rate_kes, client_charge_kes,
        platform_fee_kes, therapist_payout_kes,
        status, escrow_status)
     VALUES ($1, $2,
       (SELECT id FROM therapist_categories LIMIT 1),
       NULL, 'video',
       $3, 60, $4, $4, $4, $5, $6,
       'completed', 'held')`,
    [IDS.booking, IDS.referredProfile,
     endedAt.toISOString(), RATE_KES, PLATFORM_FEE_KES, THERAPIST_PAYOUT]
  );

  await query(
    `INSERT INTO therapy_sessions (id, booking_id, started_at, ended_at)
     VALUES ($1, $2, $3, $3)`,
    [IDS.session, IDS.booking, endedAt.toISOString()]
  );
}

async function cleanup() {
  // Delete in FK-safe reverse order
  await query(`DELETE FROM therapist_commissions      WHERE booking_id = $1`,             [IDS.booking]);
  await query(`DELETE FROM therapist_payouts          WHERE booking_id = $1`,             [IDS.booking]);
  await query(`DELETE FROM therapy_sessions           WHERE id = $1`,                     [IDS.session]);
  await query(`DELETE FROM therapist_bookings         WHERE id = $1`,                     [IDS.booking]);
  await query(`DELETE FROM therapist_profiles         WHERE id IN ($1, $2)`,              [IDS.referredProfile, IDS.referrerProfile]);
  await query(`DELETE FROM users                      WHERE id IN ($1, $2)`,              [IDS.referredUser, IDS.referrerUser]);
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function run() {
  let failures = 0;
  console.log(`\n── Phase 58.6 commission engine integration (run ${RUN})`);

  try {
    await seed();
    pass('test data seeded');
  } catch (err) {
    console.error('  ✖ seed failed:', err.message);
    process.exit(1);
  }

  try {
    await runEscrowReleaseJob();
    pass('runEscrowReleaseJob() completed without throwing');
  } catch (err) {
    fail('runEscrowReleaseJob() threw', err.message);
    failures++;
  }

  // Assert commission row was written
  const { rows } = await query(
    `SELECT * FROM therapist_commissions WHERE booking_id = $1`,
    [IDS.booking]
  );

  if (rows.length === 1)
    pass('commission row created');
  else { fail('expected 1 commission row, got ' + rows.length); failures++; }

  if (rows[0]) {
    const c = rows[0];

    if (c.referrer_therapist_id === IDS.referrerProfile)
      pass('referrer_therapist_id correct');
    else { fail('wrong referrer_therapist_id', c.referrer_therapist_id); failures++; }

    if (c.referred_therapist_id === IDS.referredProfile)
      pass('referred_therapist_id correct');
    else { fail('wrong referred_therapist_id', c.referred_therapist_id); failures++; }

    if (Number(c.session_fee_kes) === PLATFORM_FEE_KES)
      pass(`session_fee_kes = ${PLATFORM_FEE_KES} (platform 20% cut)`);
    else { fail(`expected session_fee_kes ${PLATFORM_FEE_KES}, got ${c.session_fee_kes}`); failures++; }

    if (Number(c.commission_kes) === EXPECTED_COMMISSION)
      pass(`commission_kes = ${EXPECTED_COMMISSION} (5% of ${PLATFORM_FEE_KES})`);
    else { fail(`expected commission_kes ${EXPECTED_COMMISSION}, got ${c.commission_kes}`); failures++; }

    if (c.status === 'pending')
      pass('status = pending');
    else { fail('expected status pending, got ' + c.status); failures++; }

    if (c.period_ends_at)
      pass('period_ends_at set');
    else { fail('period_ends_at missing'); failures++; }
  }

  // Idempotency: run again — should not create a second row
  await runEscrowReleaseJob().catch(() => {});
  const { rows: rows2 } = await query(
    `SELECT COUNT(*) AS n FROM therapist_commissions WHERE booking_id = $1`,
    [IDS.booking]
  );
  if (Number(rows2[0].n) === 1)
    pass('idempotent: second run does not duplicate commission row');
  else { fail('idempotency broken: got ' + rows2[0].n + ' rows after second run'); failures++; }

  // Self-referral guard: booking for the REFERRER themselves should not get a commission
  // (referrer has no referred_by_therapist_id, so this is implicitly covered — verify 0 rows)
  const { rows: selfRows } = await query(
    `SELECT COUNT(*) AS n FROM therapist_commissions WHERE referred_therapist_id = $1`,
    [IDS.referrerProfile]
  );
  if (Number(selfRows[0].n) === 0)
    pass('no commission row for the referrer themselves (self-referral guard)');
  else { fail('self-referral guard failed: commission row exists for referrer'); failures++; }

  await cleanup();
  pass('test data cleaned up');

  console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
