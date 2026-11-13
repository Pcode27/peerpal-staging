const admin = require('firebase-admin');
const logger = require('./logger');

let initialized = false;

function initFCM() {
  if (initialized) return;
  let serviceAccount = null;
  if (process.env.FCM_SERVICE_ACCOUNT_JSON) {
    try {
      serviceAccount = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
      // Render and similar platforms escape newlines in env vars as \\n; fix private key.
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
    } catch (err) { logger.error({ err }, 'FCM: invalid FCM_SERVICE_ACCOUNT_JSON'); }
  } else if (process.env.FCM_SERVICE_ACCOUNT_PATH) {
    try {
      const fs = require('fs');
      serviceAccount = JSON.parse(fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_PATH, 'utf8'));
    } catch (err) { logger.error({ err }, 'FCM: cannot read FCM_SERVICE_ACCOUNT_PATH'); }
  } else {
    logger.warn('FCM: no credentials configured — push notifications disabled');
    return;
  }
  if (!serviceAccount) return;
  try {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    initialized = true;
    logger.info('FCM: Firebase Admin SDK initialized — push notifications enabled');
  } catch (err) { logger.error({ err }, 'FCM: init failed'); }
}

// Builds the FCM message. Data-only on purpose: all our tokens are web (PWA) tokens, and a
// top-level `notification` block makes the Firebase SW SDK display its own plain notification
// AND call our onBackgroundMessage, so every push showed twice. The service worker
// (public/firebase-messaging-sw.js) renders everything from `data`, with title/body as fallback.
//
// Control keys (stripped from the payload):
//   _urgent: 'true'  → Urgency: high (wakes the device from Doze)
//   _ttl:    seconds → drop the push if it cannot be delivered within this window
function buildFcmMessage(fcm_token, title, body, data = {}) {
  const payload = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('_') || v === undefined || v === null) continue;
    payload[k] = String(v);
  }
  if (payload.title === undefined && title) payload.title = String(title);
  if (payload.body === undefined && body) payload.body = String(body);

  const headers = { Urgency: data._urgent === 'true' ? 'high' : 'normal' };
  const ttl = parseInt(data._ttl, 10);
  if (Number.isFinite(ttl) && ttl >= 0) headers.TTL = String(ttl);

  return { token: fcm_token, data: payload, webpush: { headers } };
}

// Direct delivery — used by notificationWorker and as fallback.
// Wrapped by circuit breaker in utils/breakers.js — do not call directly from routes.
async function sendPushNotification(fcm_token, title, body, data = {}) {
  initFCM();
  if (!initialized || !fcm_token) return;
  try {
    await admin.messaging().send(buildFcmMessage(fcm_token, title, body, data));
  } catch (err) {
    // Token expired / unregistered — clear it so we don't re-send to dead tokens
    if (err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token') {
      const { query } = require('../db');
      await query('UPDATE users SET fcm_token = NULL WHERE fcm_token = $1', [fcm_token])
        .catch(() => {});
    }
    logger.warn({ code: err.code, msg: err.message }, 'FCM: send failed');
    throw err; // re-throw so the circuit breaker can track the failure
  }
}

// Enqueue for async delivery — falls back to direct send (via circuit breaker) if queue is down.
async function enqueuePushNotification(fcm_token, title, body, data = {}) {
  if (!fcm_token) return;
  const { notificationQueue } = require('../queues');
  if (notificationQueue) {
    try {
      await notificationQueue.add('push', { fcm_token, title, body, data });
      return;
    } catch (err) {
      logger.warn({ err }, 'FCM: queue unavailable, falling back to direct send');
    }
  }
  // Use circuit breaker for direct sends — prevents a dead FCM service from
  // blocking every request path that calls enqueuePushNotification.
  const { getFcmBreaker } = require('./breakers');
  await getFcmBreaker().fire(fcm_token, title, body, data);
}

// A device token belongs to exactly one account. FCM tokens are per browser, so on a shared
// phone the previous account's token row must be cleared, or user B's device keeps receiving
// user A's (mental-health) notifications.
async function assignFcmToken(query, userId, fcm_token) {
  if (fcm_token) {
    await query('UPDATE users SET fcm_token = NULL WHERE fcm_token = $1 AND id <> $2', [fcm_token, userId]);
  }
  await query('UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2', [fcm_token || null, userId]);
}

// True when Firebase Admin initialised with a usable service account. Pushes "sent" while
// this is false are queued and silently dropped, so traces must report it.
function isPushEnabled() {
  initFCM();
  return initialized;
}

// Push to every admin who has an FCM token registered.
async function notifyAllAdmins(queryFn, title, body, data = {}) {
  const { rows } = await queryFn(
    `SELECT fcm_token FROM users WHERE role = 'admin' AND fcm_token IS NOT NULL AND is_active = true`
  );
  for (const r of rows) {
    enqueuePushNotification(r.fcm_token, title, body, data).catch((err) => {
      logger.warn({ token: r.fcm_token?.slice(-6), err: err.message }, 'notifyAllAdmins: push failed');
    });
  }
}

module.exports = { sendPushNotification, enqueuePushNotification, buildFcmMessage, assignFcmToken, isPushEnabled, notifyAllAdmins };
