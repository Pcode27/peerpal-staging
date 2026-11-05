/**
 * Integration test for Phase 58.3 endpoints.
 * Run: node scripts/_test_58_endpoints.js  (from src/backend, with server running on :3001)
 */
require('dotenv').config();
const http = require('http');

const THERAPIST_TOKEN = process.argv[2] || process.env.THERAPIST_TOKEN;
const ADMIN_TOKEN     = process.argv[3] || process.env.ADMIN_TOKEN;

if (!THERAPIST_TOKEN || !ADMIN_TOKEN) {
  console.error('Usage: node scripts/_test_58_endpoints.js <therapist_token> <admin_token>');
  process.exit(1);
}

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost',
      port: 3001,
      path: '/api' + path,
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function pass(label) { console.log('  ✔ ' + label); }
function fail(label, got) { console.log('  ✖ ' + label, JSON.stringify(got)); }
function section(title) { console.log('\n── ' + title); }

async function run() {
  let failures = 0;

  // ── 0. GET /therapy/therapist/profile — 58.5 referral fields ───────────
  section('GET /therapy/therapist/profile (58.5 referral fields)');
  {
    const r = await req('GET', '/therapy/therapist/profile', THERAPIST_TOKEN);
    if (r.status === 200 && r.body.profile && typeof r.body.profile === 'object')
      pass('200 + profile object');
    else { fail('expected 200 + profile object', r); failures++; }

    const p = r.body?.profile;
    if (p && 'addendum_signed_at' in p)
      pass('profile includes addendum_signed_at field');
    else { fail('addendum_signed_at missing from profile', p); failures++; }

    if (p && 'referral_code' in p)
      pass('profile includes referral_code field');
    else { fail('referral_code missing from profile', p); failures++; }

    // No auth
    const noAuth = await req('GET', '/therapy/therapist/profile', 'bad-token');
    if (noAuth.status === 401)
      pass('401 on bad token');
    else { fail('expected 401, got ' + noAuth.status, noAuth.body); failures++; }
  }

  // ── 1. GET /therapy/therapist/my-referrals ──────────────────────────────
  section('GET /therapy/therapist/my-referrals');
  {
    const r = await req('GET', '/therapy/therapist/my-referrals', THERAPIST_TOKEN);
    if (r.status === 200 && Array.isArray(r.body.referrals))
      pass('200 + referrals array');
    else { fail('expected 200 + array', r); failures++; }

    // No auth
    const noAuth = await req('GET', '/therapy/therapist/my-referrals', 'bad-token');
    if (noAuth.status === 401)
      pass('401 on bad token');
    else { fail('expected 401, got ' + noAuth.status, noAuth.body); failures++; }
  }

  // ── 2. GET /therapy/therapist/my-commissions ────────────────────────────
  section('GET /therapy/therapist/my-commissions');
  {
    const r = await req('GET', '/therapy/therapist/my-commissions', THERAPIST_TOKEN);
    if (r.status === 200 && Array.isArray(r.body.commissions) &&
        typeof r.body.total_pending_kes === 'number' && typeof r.body.total_paid_kes === 'number')
      pass('200 + commissions array + totals');
    else { fail('expected 200 + shape', r); failures++; }
  }

  // ── 3. POST /therapy/therapist/sign-addendum ────────────────────────────
  section('POST /therapy/therapist/sign-addendum');
  {
    // First call — should sign and return a referral_code
    const r = await req('POST', '/therapy/therapist/sign-addendum', THERAPIST_TOKEN);
    if (r.status === 200 && typeof r.body.referral_code === 'string' && r.body.referral_code.length === 6)
      pass('200 + 6-char referral_code on first sign');
    else { fail('expected 200 + code', r); failures++; }

    const code = r.body?.referral_code;

    // Second call — idempotent: should return same code with already_signed
    const r2 = await req('POST', '/therapy/therapist/sign-addendum', THERAPIST_TOKEN);
    if (r2.status === 200 && r2.body.already_signed === true && r2.body.referral_code === code)
      pass('idempotent: same code + already_signed=true on repeat call');
    else { fail('expected idempotent response', r2); failures++; }

    // No auth
    const noAuth = await req('POST', '/therapy/therapist/sign-addendum', 'bad-token');
    if (noAuth.status === 401)
      pass('401 on bad token');
    else { fail('expected 401, got ' + noAuth.status, noAuth.body); failures++; }
  }

  // ── 4. GET /admin/referral-applications ────────────────────────────────
  section('GET /admin/referral-applications');
  {
    const r = await req('GET', '/admin/referral-applications', ADMIN_TOKEN);
    if (r.status === 200 && Array.isArray(r.body.applications))
      pass('200 + applications array');
    else { fail('expected 200 + array', r); failures++; }

    // Status filter — valid
    const filtered = await req('GET', '/admin/referral-applications?status=pending', ADMIN_TOKEN);
    if (filtered.status === 200 && filtered.body.applications.every(a => a.status === 'pending'))
      pass('status=pending filter returns only pending');
    else { fail('status filter broken', filtered); failures++; }

    // Non-admin token rejected
    const noAccess = await req('GET', '/admin/referral-applications', THERAPIST_TOKEN);
    if (noAccess.status === 403)
      pass('403 on non-admin token');
    else { fail('expected 403, got ' + noAccess.status, noAccess.body); failures++; }
  }

  // ── 5. PATCH /admin/referral-applications/:id ───────────────────────────
  section('PATCH /admin/referral-applications/:id');
  {
    // Get a pending application id first
    const list = await req('GET', '/admin/referral-applications?status=pending', ADMIN_TOKEN);
    const app = list.body?.applications?.[0];

    if (!app) {
      console.log('  ⚠ no pending application to patch — skipping PATCH tests');
    } else {
      // Valid status update
      const r = await req('PATCH', '/admin/referral-applications/' + app.id, ADMIN_TOKEN, {
        status: 'account_created',
        admin_notes: 'Integration test — will reset',
      });
      if (r.status === 200 && r.body.updated === true && r.body.application.status === 'account_created')
        pass('200 + updated=true on valid status');
      else { fail('expected 200 + updated', r); failures++; }

      // Reset it back to pending
      await req('PATCH', '/admin/referral-applications/' + app.id, ADMIN_TOKEN, { status: 'pending' });
      pass('reset back to pending (cleanup)');

      // Invalid status
      const bad = await req('PATCH', '/admin/referral-applications/' + app.id, ADMIN_TOKEN, { status: 'approved' });
      if (bad.status === 400 && bad.body.code === 'INVALID_STATUS')
        pass('400 INVALID_STATUS on unknown status value');
      else { fail('expected 400 INVALID_STATUS', bad); failures++; }

      // Non-existent id
      const gone = await req('PATCH', '/admin/referral-applications/00000000-0000-0000-0000-000000000000', ADMIN_TOKEN, { status: 'rejected' });
      if (gone.status === 404)
        pass('404 on unknown application id');
      else { fail('expected 404, got ' + gone.status, gone.body); failures++; }
    }

    // Non-admin rejected
    const noAccess = await req('PATCH', '/admin/referral-applications/any-id', THERAPIST_TOKEN, { status: 'rejected' });
    if (noAccess.status === 403)
      pass('403 on non-admin token');
    else { fail('expected 403, got ' + noAccess.status, noAccess.body); failures++; }
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed.');
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
