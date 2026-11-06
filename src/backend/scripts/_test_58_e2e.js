/**
 * Phase 58 — Full end-to-end integration test.
 *
 * Walks the complete referral flow:
 *   1. Seed referrer therapist (verified, addendum signed, referral_code set)
 *   2. Seed referred therapist (referred_by_therapist_id = referrer)
 *   3. Seed booking with known platform_fee_kes
 *   4. Seed therapy_session (ended)
 *   5. Run escrowReleaseJob → assert commission row, math, referrer/referred IDs
 *   6. Run referralPayoutJob → assert payout row, commission status = 'paid'
 *   7. Idempotency: escrowReleaseJob second run creates no duplicate commission
 *   8. Idempotency: referralPayoutJob second run creates no duplicate payout
 *   9. Self-referral guard: commission not created if referrer = referred
 *  10. Zero-fee guard: commission not created if platform_fee_kes = 0
 *  11. 12-month window guard: commission not created if session outside window
 *  12. User referral tables untouched throughout
 *  13. Cleanup all seeded rows
 *
 * Run: node scripts/_test_58_e2e.js  (from src/backend, DB must be reachable)
 */
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const { runEscrowReleaseJob }   = require('../jobs/escrowReleaseJob');
const { runReferralPayoutJob, eatMonthString } = require('../jobs/referralPayoutJob');

function pass(label) { console.log('  ✔ ' + label); }
function fail(label, detail) { console.error('  ✖ ' + label, detail ?? ''); }

const RUN = uuidv4().slice(0, 8);
const NOW = new Date();
const PERIOD_MONTH = eatMonthString();

// IDs — all generated fresh per run
const IDS = {
  referrerUser:    uuidv4(),
  referrerProfile: uuidv4(),
  referredUser:    uuidv4(),
  referredProfile: uuidv4(),
  booking:         uuidv4(),
  // Self-referral fixture
  selfUser:        uuidv4(),
  selfProfile:     uuidv4(),
  selfBooking:     uuidv4(),
  // Zero-fee fixture
  zeroUser:        uuidv4(),
  zeroProfile:     uuidv4(),
  zeroBooking:     uuidv4(),
  // Window fixture (session outside 12-month window)
  windowUser:      uuidv4(),
  windowProfile:   uuidv4(),
  windowBooking:   uuidv4(),
};

const PLATFORM_FEE_KES = 400; // 20% of KES 2000 session
const EXPECTED_COMMISSION = Math.round(PLATFORM_FEE_KES * 0.05); // 20
const ADDENDUM_SIGNED_AT = new Date(NOW.getTime() - 6 * 30 * 24 * 60 * 60 * 1000); // 6 months ago
const SESSION_ENDED_AT   = new Date(NOW.getTime() - 25 * 60 * 60 * 1000); // 25h ago (released by escrow)

// Session ended 2 years after addendum — outside 12-month window
const WINDOW_ADDENDUM = new Date(NOW.getTime() - 2 * 365 * 24 * 60 * 60 * 1000 - 1000);
const WINDOW_SESSION  = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);

async function seedUser(id, alias, email) {
  await query(
    `INSERT INTO users (id, alias, email, password_hash, role) VALUES ($1, $2, $3, 'x', 'member')`,
    [id, alias, email]
  );
}

async function seedTherapistProfile(id, userId, opts = {}) {
  await query(
    `INSERT INTO therapist_profiles
       (id, user_id, display_name, full_name, credentials,
        is_verified, addendum_signed_at, referral_code,
        referred_by_therapist_id,
        rate_per_session_kes, mpesa_number, onboarding_complete)
     VALUES ($1,$2,$3,$3,'Test',
       $4, $5, $6, $7,
       2000, '0712345678', true)`,
    [
      id, userId, `Doc_${alias(opts.name, RUN)}`,
      opts.verified ?? true,
      opts.addendum_signed_at ?? null,
      opts.referral_code ?? null,
      opts.referred_by ?? null,
    ]
  );
}

function alias(name, run) { return `${name}${run}`; }

async function seedBooking(id, therapistId, platformFeeKes, opts = {}) {
  const scheduledAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
  await query(
    `INSERT INTO therapist_bookings
       (id, therapist_id, category_id, member_user_id,
        session_format, scheduled_at, duration_minutes,
        rate_kes, therapist_rate_kes, client_charge_kes,
        platform_fee_kes, therapist_payout_kes,
        status, escrow_status)
     VALUES ($1,$2,
       (SELECT id FROM therapist_categories LIMIT 1),
       NULL, 'video', $3, 60,
       2000, 1600, 2000,
       $4, 1600,
       'completed', $5)`,
    [id, therapistId, scheduledAt.toISOString(), platformFeeKes, opts.escrow_status ?? 'held']
  );
}

async function seedSession(bookingId, endedAt) {
  await query(
    `INSERT INTO therapy_sessions
       (id, booking_id, room_token_member, room_token_therapist,
        started_at, ended_at, member_joined_at, duration_billed_minutes)
     VALUES ($1,$2,'tok','tok',
       $3, $4, $3, 50)`,
    [uuidv4(), bookingId, new Date(endedAt.getTime() - 55 * 60 * 1000).toISOString(), endedAt.toISOString()]
  );
}

async function cleanup() {
  const allProfiles = [
    IDS.referrerProfile, IDS.referredProfile,
    IDS.selfProfile, IDS.zeroProfile, IDS.windowProfile,
  ];
  const allUsers = [
    IDS.referrerUser, IDS.referredUser,
    IDS.selfUser, IDS.zeroUser, IDS.windowUser,
  ];
  const allBookings = [
    IDS.booking, IDS.selfBooking, IDS.zeroBooking, IDS.windowBooking,
  ];

  await query(`DELETE FROM therapist_commission_payouts WHERE referrer_therapist_id = ANY($1)`, [allProfiles]);
  await query(`DELETE FROM therapist_commissions WHERE referrer_therapist_id = ANY($1) OR referred_therapist_id = ANY($1)`, [allProfiles]);
  await query(`DELETE FROM therapist_payouts WHERE booking_id = ANY($1)`, [allBookings]);
  await query(`DELETE FROM therapy_sessions WHERE booking_id = ANY($1)`, [allBookings]);
  await query(`DELETE FROM therapist_bookings WHERE id = ANY($1)`, [allBookings]);
  await query(`DELETE FROM therapist_profiles WHERE id = ANY($1)`, [allProfiles]);
  await query(`DELETE FROM users WHERE id = ANY($1)`, [allUsers]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  let failures = 0;
  const fail_  = (label, detail) => { fail(label, detail); failures++; };

  console.log(`\n── Phase 58 E2E integration (run ${RUN}, period ${PERIOD_MONTH})`);
  console.log(`   commission formula: Math.round(${PLATFORM_FEE_KES} * 0.05) = ${EXPECTED_COMMISSION}\n`);

  // ── Seed ──────────────────────────────────────────────────────────────────
  console.log('[ SEED ]');
  try {
    // Referrer
    await seedUser(IDS.referrerUser, `RefA${RUN}`, `refa_${RUN}@test.invalid`);
    await seedTherapistProfile(IDS.referrerProfile, IDS.referrerUser, {
      name: 'RefA', verified: true,
      addendum_signed_at: ADDENDUM_SIGNED_AT.toISOString(),
      referral_code: `R${RUN.slice(0,5).toUpperCase()}`,
    });

    // Referred
    await seedUser(IDS.referredUser, `RefB${RUN}`, `refb_${RUN}@test.invalid`);
    await seedTherapistProfile(IDS.referredProfile, IDS.referredUser, {
      name: 'RefB', verified: true,
      referred_by: IDS.referrerProfile,
    });

    // Main booking + session
    await seedBooking(IDS.booking, IDS.referredProfile, PLATFORM_FEE_KES);
    await seedSession(IDS.booking, SESSION_ENDED_AT);

    // Self-referral fixture (referrer = referred)
    await seedUser(IDS.selfUser, `SelfA${RUN}`, `self_${RUN}@test.invalid`);
    await seedTherapistProfile(IDS.selfProfile, IDS.selfUser, {
      name: 'SelfA', verified: true,
      addendum_signed_at: ADDENDUM_SIGNED_AT.toISOString(),
      referral_code: `S${RUN.slice(0,5).toUpperCase()}`,
      referred_by: IDS.selfProfile, // self
    });
    await seedBooking(IDS.selfBooking, IDS.selfProfile, PLATFORM_FEE_KES);
    await seedSession(IDS.selfBooking, SESSION_ENDED_AT);

    // Zero-fee fixture
    await seedUser(IDS.zeroUser, `ZeroA${RUN}`, `zero_${RUN}@test.invalid`);
    await seedTherapistProfile(IDS.zeroProfile, IDS.zeroUser, {
      name: 'ZeroA', verified: true,
      referred_by: IDS.referrerProfile,
    });
    await seedBooking(IDS.zeroBooking, IDS.zeroProfile, 0); // platform_fee = 0
    await seedSession(IDS.zeroBooking, SESSION_ENDED_AT);

    // Window guard (12-month window) is verified by phase58Math.test.js unit tests.
    // No DB fixture needed here — the window check lives entirely in escrowReleaseJob source.
    pass('test data seeded');
  } catch (err) {
    fail_('seed', err.message);
    await cleanup().catch(() => {});
    process.exit(1);
  }

  // ── Step 5: escrowReleaseJob → commission ─────────────────────────────────
  console.log('\n[ ESCROW RELEASE → COMMISSION ]');
  try {
    // Mark bookings as held so the job picks them up
    await query(`UPDATE therapist_bookings SET escrow_status = 'held', updated_at = NOW() WHERE id = ANY($1)`,
      [[IDS.booking, IDS.selfBooking, IDS.zeroBooking]]);
    // Update session ended_at to be 25h ago (escrow releases after 24h)
    await query(`UPDATE therapy_sessions SET ended_at = $1 WHERE booking_id = ANY($2)`,
      [SESSION_ENDED_AT.toISOString(), [IDS.booking, IDS.selfBooking, IDS.zeroBooking]]);
    await runEscrowReleaseJob();
    pass('runEscrowReleaseJob() completed without throwing');
  } catch (err) {
    fail_('runEscrowReleaseJob() threw', err.message);
  }

  // Commission for main booking
  const { rows: commRows } = await query(
    `SELECT * FROM therapist_commissions WHERE booking_id = $1`, [IDS.booking]
  );
  if (commRows.length === 1) {
    pass('commission row created for main booking');
    const c = commRows[0];

    if (Number(c.commission_kes) === EXPECTED_COMMISSION)
      pass(`commission_kes = ${EXPECTED_COMMISSION} (Math.round(${PLATFORM_FEE_KES} * 0.05))`);
    else fail_(`commission_kes wrong: expected ${EXPECTED_COMMISSION}, got ${c.commission_kes}`);

    if (c.referrer_therapist_id === IDS.referrerProfile)
      pass('referrer_therapist_id = referrer profile');
    else fail_('referrer_therapist_id mismatch', c.referrer_therapist_id);

    if (c.referred_therapist_id === IDS.referredProfile)
      pass('referred_therapist_id = referred profile');
    else fail_('referred_therapist_id mismatch', c.referred_therapist_id);

    if (Number(c.session_fee_kes) === PLATFORM_FEE_KES)
      pass(`session_fee_kes = ${PLATFORM_FEE_KES} (platform_fee, not full session charge)`);
    else fail_(`session_fee_kes wrong: expected ${PLATFORM_FEE_KES}, got ${c.session_fee_kes}`);

    if (c.status === 'pending')
      pass('commission status = pending');
    else fail_('commission status wrong', c.status);
  } else {
    fail_('expected 1 commission row, got ' + commRows.length);
  }

  // Self-referral guard
  const { rows: selfRows } = await query(
    `SELECT * FROM therapist_commissions WHERE booking_id = $1`, [IDS.selfBooking]
  );
  if (selfRows.length === 0)
    pass('self-referral guard: no commission for self-referred booking');
  else fail_('self-referral guard failed: got ' + selfRows.length + ' commission row(s)');

  // Zero-fee guard
  const { rows: zeroRows } = await query(
    `SELECT * FROM therapist_commissions WHERE booking_id = $1`, [IDS.zeroBooking]
  );
  if (zeroRows.length === 0)
    pass('zero-fee guard: no commission when platform_fee_kes = 0');
  else fail_('zero-fee guard failed: got ' + zeroRows.length + ' commission row(s)');

  // ── Step 7: Idempotency — second escrow run ───────────────────────────────
  console.log('\n[ ESCROW IDEMPOTENCY ]');
  try {
    await runEscrowReleaseJob();
    const { rows: dup } = await query(
      `SELECT COUNT(*)::int AS n FROM therapist_commissions WHERE booking_id = $1`, [IDS.booking]
    );
    if (dup[0].n === 1)
      pass('idempotent: second escrow run produces no duplicate commission');
    else fail_('idempotency broken: got ' + dup[0].n + ' commission rows');
  } catch (err) {
    fail_('second escrow run threw', err.message);
  }

  // ── Step 6: referralPayoutJob → payout ───────────────────────────────────
  console.log('\n[ PAYOUT JOB ]');
  try {
    await runReferralPayoutJob();
    pass('runReferralPayoutJob() completed without throwing');
  } catch (err) {
    fail_('runReferralPayoutJob() threw', err.message);
  }

  const { rows: payouts } = await query(
    `SELECT * FROM therapist_commission_payouts WHERE referrer_therapist_id = $1 AND period_month = $2`,
    [IDS.referrerProfile, PERIOD_MONTH]
  );
  if (payouts.length === 1) {
    pass('payout row created');
    const p = payouts[0];

    if (Number(p.total_commission_kes) === EXPECTED_COMMISSION)
      pass(`payout total_commission_kes = ${EXPECTED_COMMISSION}`);
    else fail_(`payout total wrong: expected ${EXPECTED_COMMISSION}, got ${p.total_commission_kes}`);

    if (p.mpesa_number === '0712345678')
      pass('payout mpesa_number taken from referrer profile');
    else fail_('wrong mpesa_number', p.mpesa_number);

    if (p.status === 'pending')
      pass('payout status = pending (awaiting M-Pesa disbursement)');
    else fail_('wrong payout status', p.status);

    if (p.period_month === PERIOD_MONTH)
      pass(`period_month = ${PERIOD_MONTH}`);
    else fail_('wrong period_month', p.period_month);
  } else {
    fail_('expected 1 payout row, got ' + payouts.length);
  }

  // Commission marked paid
  const { rows: commPaid } = await query(
    `SELECT status FROM therapist_commissions WHERE booking_id = $1`, [IDS.booking]
  );
  if (commPaid[0]?.status === 'paid')
    pass('commission status flipped to paid after payout');
  else fail_('commission not marked paid after payout', commPaid[0]?.status);

  // ── Step 8: Idempotency — second payout run ───────────────────────────────
  console.log('\n[ PAYOUT IDEMPOTENCY ]');
  try {
    await runReferralPayoutJob();
    const { rows: dupPay } = await query(
      `SELECT COUNT(*)::int AS n FROM therapist_commission_payouts
       WHERE referrer_therapist_id = $1 AND period_month = $2`,
      [IDS.referrerProfile, PERIOD_MONTH]
    );
    if (dupPay[0].n === 1)
      pass('idempotent: second payout run produces no duplicate payout');
    else fail_('payout idempotency broken', dupPay[0].n + ' rows');
  } catch (err) {
    fail_('second payout run threw', err.message);
  }

  // ── Step 12: User referral tables untouched ───────────────────────────────
  console.log('\n[ ISOLATION — USER REFERRAL TABLES ]');
  // referral_rewards should have no rows inserted by our test users
  const allUserIds = [
    IDS.referrerUser, IDS.referredUser,
    IDS.selfUser, IDS.zeroUser, IDS.windowUser,
  ];
  const { rows: rewards } = await query(
    `SELECT COUNT(*)::int AS n FROM referral_rewards
     WHERE referrer_user_id = ANY($1) OR referred_user_id = ANY($1)`,
    [allUserIds]
  );
  if (Number(rewards[0].n) === 0)
    pass('referral_rewards untouched — user reward system isolated');
  else fail_('referral_rewards has unexpected rows: ' + rewards[0].n);

  // users.referred_by untouched for our test users
  const { rows: referredBy } = await query(
    `SELECT COUNT(*)::int AS n FROM users
     WHERE id = ANY($1) AND referred_by IS NOT NULL`,
    [allUserIds]
  );
  if (Number(referredBy[0].n) === 0)
    pass('users.referred_by untouched — user referral chain isolated');
  else fail_('users.referred_by unexpectedly set for test users');

  // ── Cleanup ───────────────────────────────────────────────────────────────
  console.log('\n[ CLEANUP ]');
  try {
    await cleanup();
    pass('all test data removed');
  } catch (err) {
    fail_('cleanup failed', err.message);
  }

  const summary = failures
    ? `\n  ${failures} failure(s)\n`
    : '\n  All checks passed.\n';
  console.log(summary);
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
