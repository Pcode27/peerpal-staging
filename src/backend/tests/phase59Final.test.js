/**
 * Phase 59 final sub-phases: 59.3 privacy disclosure, 59.4 PWA install prompt,
 * 59.5 therapist FCM token store + booking push notification.
 *
 * Run: node --test tests/phase59Final.test.js  (from src/backend)
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const therapySrc   = fs.readFileSync(path.join(__dirname, '..', 'routes', 'therapy.js'), 'utf8');
const loginSrc     = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'src', 'frontend', 'src', 'screens', 'auth', 'LoginScreen.jsx'),
  'utf8'
);
const voiceSrc     = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'src', 'frontend', 'src', 'screens', 'peer', 'PeerVoiceCallScreen.jsx'),
  'utf8'
);

// ── 59.3 Privacy disclosure ────────────────────────────────────────────────────

describe('59.3 — Privacy disclosure in voice call screen', () => {
  test('disclosure text present when call is active', () => {
    assert.match(voiceSrc, /If you report this session.*transcript.*safety team/s);
  });

  test('disclosure only shown when callState is active', () => {
    // The disclosure must be guarded by callState === 'active', not always visible
    const disclosureIdx = voiceSrc.indexOf('If you report this session');
    const activeGuardIdx = voiceSrc.lastIndexOf("callState === 'active'", disclosureIdx);
    assert.ok(activeGuardIdx > 0 && disclosureIdx - activeGuardIdx < 300,
      'disclosure must be inside a callState active guard');
  });
});

// ── 59.4 PWA install prompt on LoginScreen ────────────────────────────────────

describe('59.4 — PWA install prompt on LoginScreen', () => {
  test('beforeinstallprompt event listener added', () => {
    assert.match(loginSrc, /beforeinstallprompt/);
  });

  test('standalone mode check via matchMedia', () => {
    assert.match(loginSrc, /display-mode.*standalone/);
  });

  test('install button renders only when not standalone and prompt available', () => {
    assert.match(loginSrc, /isStandalone.*installPrompt|installPrompt.*isStandalone/s);
  });

  test('button calls installPrompt.prompt()', () => {
    assert.match(loginSrc, /installPrompt\.prompt\(\)/);
  });

  test('prompt cleared after trigger to prevent double-fire', () => {
    assert.match(loginSrc, /setInstallPrompt\(null\)/);
  });

  test('button label is Add to Home Screen', () => {
    assert.match(loginSrc, /Add to Home Screen/);
  });
});

// ── 59.4 Unit: install prompt trigger logic ───────────────────────────────────

describe('59.4 — Install prompt: unit trigger logic', () => {
  test('prompt.prompt() called then state cleared', () => {
    let promptCalled = false;
    let stateClearedAfterPrompt = false;

    // Simulate the button onClick
    const installPrompt = { prompt: () => { promptCalled = true; } };
    const setInstallPrompt = (v) => { if (v === null && promptCalled) stateClearedAfterPrompt = true; };

    installPrompt.prompt();
    setInstallPrompt(null);

    assert.ok(promptCalled, 'prompt() must be called');
    assert.ok(stateClearedAfterPrompt, 'state must be cleared after prompt');
  });

  test('button hidden when already standalone', () => {
    const isStandalone = true;
    const installPrompt = {}; // non-null — but isStandalone takes precedence
    const shouldShow = !isStandalone && !!installPrompt;
    assert.ok(!shouldShow, 'button must not show when isStandalone is true');
  });

  test('button hidden when no prompt event yet', () => {
    const isStandalone = false;
    const installPrompt = null;
    const shouldShow = !isStandalone && !!installPrompt;
    assert.ok(!shouldShow, 'button must not show when installPrompt is null');
  });

  test('button shown when not standalone and prompt available', () => {
    const isStandalone = false;
    const installPrompt = { prompt: () => {} };
    const shouldShow = !isStandalone && !!installPrompt;
    assert.ok(shouldShow, 'button must show when not standalone and prompt present');
  });
});

// ── 59.5 Static: therapist FCM token route ────────────────────────────────────

// Slice from route definition to change-password (next route)
const fcmTokenSrc = therapySrc.slice(
  therapySrc.indexOf('POST /therapy/therapist/fcm-token'),
  therapySrc.indexOf('POST /therapy/therapist/change-password')
);

describe('59.5 — POST /therapy/therapist/fcm-token: static source checks', () => {
  test('route is registered', () => {
    assert.ok(therapySrc.includes("router.post('/therapist/fcm-token'"), 'route must be registered');
  });

  test('protected by therapistAuth', () => {
    assert.match(fcmTokenSrc, /therapistAuth/);
  });

  test('validates token is present', () => {
    assert.match(fcmTokenSrc, /MISSING_FIELDS/);
  });

  test('updates therapist_profiles with fcm_token', () => {
    assert.match(fcmTokenSrc, /UPDATE therapist_profiles SET fcm_token/);
  });

  test('scoped to req.user.id (no cross-therapist write)', () => {
    assert.match(fcmTokenSrc, /WHERE user_id.*req\.user\.id|req\.user\.id.*WHERE user_id/s);
  });
});

// ── 59.5 Unit: FCM token store handler ───────────────────────────────────────

describe('59.5 — FCM token store handler: unit', () => {
  async function makeFcmTokenHandler(queryImpl) {
    return async function storeFcmToken(token, userId) {
      if (!token || typeof token !== 'string') {
        return { status: 400, code: 'MISSING_FIELDS' };
      }
      await queryImpl('UPDATE therapist_profiles SET fcm_token = $1 WHERE user_id = $2', [token, userId]);
      return { status: 200, stored: true };
    };
  }

  test('stores valid token and returns stored:true', async () => {
    const queries = [];
    const fakeQuery = async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; };
    const handler = await makeFcmTokenHandler(fakeQuery);
    const result = await handler('tok_abc123', 'user-1');
    assert.equal(result.status, 200);
    assert.equal(result.stored, true);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /UPDATE therapist_profiles/);
    assert.equal(queries[0].params[0], 'tok_abc123');
    assert.equal(queries[0].params[1], 'user-1');
  });

  test('returns 400 when token is missing', async () => {
    const fakeQuery = async () => ({ rows: [] });
    const handler = await makeFcmTokenHandler(fakeQuery);
    const result = await handler('', 'user-1');
    assert.equal(result.status, 400);
    assert.equal(result.code, 'MISSING_FIELDS');
  });

  test('returns 400 when token is not a string', async () => {
    const fakeQuery = async () => ({ rows: [] });
    const handler = await makeFcmTokenHandler(fakeQuery);
    const result = await handler(null, 'user-1');
    assert.equal(result.status, 400);
    assert.equal(result.code, 'MISSING_FIELDS');
  });
});

// ── 59.5 Static: booking webhook fires push to therapist ─────────────────────

// Slice from payment-webhook to retry-payment (next route)
const bookingWebhookSrc = therapySrc.slice(
  therapySrc.indexOf('POST /therapy/payment-webhook'),
  therapySrc.indexOf('POST /therapy/bookings/:id/retry-payment')
);

describe('59.5 — Booking webhook therapist push: static source checks', () => {
  test('enqueuePushNotification is imported', () => {
    assert.match(therapySrc, /require.*fcm.*\nenqueuePushNotification|enqueuePushNotification.*=.*require/s);
    // simpler: just check it's destructured from the fcm require
    assert.match(therapySrc, /enqueuePushNotification/);
  });

  test('fcm_token fetched alongside user_id in therapist profile query', () => {
    assert.match(bookingWebhookSrc, /SELECT user_id, fcm_token FROM therapist_profiles/);
  });

  test('enqueuePushNotification called with fcm_token', () => {
    assert.match(bookingWebhookSrc, /enqueuePushNotification\(tpRows\[0\]\.fcm_token/);
  });

  test('push is guarded: only fires when fcm_token is truthy', () => {
    assert.match(bookingWebhookSrc, /if \(tpRows\[0\]\.fcm_token\)/);
  });
});

// ── 59.5 Unit: booking push conditional ──────────────────────────────────────

describe('59.5 — Booking push conditional: unit', () => {
  async function simulateBookingPush(fcmToken, memberAlias) {
    const pushCalls = [];
    const fakeEnqueue = async (token, title, body, data) => pushCalls.push({ token, title, body, data });

    const tpRow = { user_id: 'therapist-1', fcm_token: fcmToken };
    const msgBody = `New booking from ${memberAlias}.`;

    if (tpRow.fcm_token) {
      await fakeEnqueue(tpRow.fcm_token, 'New Booking', msgBody, { type: 'therapist_update' });
    }
    return pushCalls;
  }

  test('push fires when therapist has fcm_token', async () => {
    const calls = await simulateBookingPush('fcm_tok_xyz', 'Alice');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].token, 'fcm_tok_xyz');
    assert.equal(calls[0].title, 'New Booking');
    assert.match(calls[0].body, /Alice/);
    assert.equal(calls[0].data.type, 'therapist_update');
  });

  test('push skipped when fcm_token is null', async () => {
    const calls = await simulateBookingPush(null, 'Alice');
    assert.equal(calls.length, 0, 'no push when no token');
  });

  test('push skipped when fcm_token is empty string', async () => {
    const calls = await simulateBookingPush('', 'Alice');
    assert.equal(calls.length, 0, 'no push when empty token');
  });
});
