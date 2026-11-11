importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

if (!firebase.apps.length) {
  firebase.initializeApp({
    apiKey: 'AIzaSyCbqGbM3tEyL3fmcxTzC2le5zMsAQlkErY',
    authDomain: 'mindbridge-3b02d.firebaseapp.com',
    projectId: 'mindbridge-3b02d',
    storageBucket: 'mindbridge-3b02d.firebasestorage.app',
    messagingSenderId: '142389456351',
    appId: '1:142389456351:web:ace00b86d0559e4d2c286a',
  });
}

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  const title = d.title || 'PeerPal Therapist';
  const body  = d.body  || 'You have a new notification.';
  return self.registration.showNotification(title, {
    body,
    icon: '/pwa-192x192.png',
    data: d,
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { c.focus(); return; }
      }
      if (clients.openWindow) clients.openWindow('/');
    })
  );
});
