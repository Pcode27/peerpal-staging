import { initializeApp, getApps } from 'firebase/app';
import { getMessaging, getToken } from 'firebase/messaging';
import client from '../api/client';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

function getApp() {
  return getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
}

// Call once on login. Stores token against the therapist's profile.
export async function registerFCMToken() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
  if (!import.meta.env.VITE_FIREBASE_API_KEY) return;
  if (Notification.permission === 'denied') return;

  try {
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
    }
    const messaging = getMessaging(getApp());
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const sw = await navigator.serviceWorker.ready;
        const token = await getToken(messaging, {
          vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY,
          serviceWorkerRegistration: sw,
        });
        if (token) {
          await client.post('/api/therapy/therapist/fcm-token', { token }).catch(() => {});
        }
        return;
      } catch (err) {
        if ((err.code === 20 || err.name === 'AbortError') && attempt === 0) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        console.warn('[FCM therapist] token registration failed:', err.message);
        return;
      }
    }
  } catch (err) {
    console.warn('[FCM therapist] token registration failed:', err.message);
  }
}
