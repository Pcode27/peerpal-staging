// Notification rendering + click routing for the service worker.
// Loaded by firebase-messaging-sw.js via importScripts, and by
// tests/sw-notifications.test.mjs in a vm sandbox. Keep it dependency-free.
//
// Sound: the Web Notifications API has no per-notification sound in any browser, so a
// background push plays the phone's default notification sound. What we control is the
// vibration pattern (peer requests get a long ring-like pattern no other type uses) and,
// when the app is open, the in-app ringtone (src/utils/peerRequestAlert.js).
// A custom background ringtone needs a native app (Android notification channel).
(function (root) {
  // Per-type notification config.
  // Each entry defines how to render a background push for that notification type.
  // Keys used in each entry:
  //   title(d)       — function(data) → string
  //   body(d)        — function(data) → string
  //   vibrate        — vibration pattern array
  //   requireInteraction — bool: stays on screen until user acts
  //   renotify       — bool: replace same-tag or stack
  //   actions        — array of { action, title }
  const NOTIF_TYPES = {
    peer_request_broadcast: {
      title: () => 'Someone needs your support',
      body: (d) => {
        const ch = d.channel_preference === 'voice' ? 'Voice session' : 'Text session';
        return d.topic_label ? `${d.topic_label} · ${ch}` : ch;
      },
      vibrate: [300, 100, 300, 100, 300, 200, 600],
      requireInteraction: true,
      renotify: true,
      actions: [
        { action: 'accept', title: "I'm ready" },
        { action: 'skip',   title: 'Not now'   },
      ],
    },

    session_confirmation: {
      title: () => 'Your peer is ready',
      body: (d) => {
        const ch = (d.channel || d.channel_preference) === 'voice' ? 'Voice session' : 'Chat session';
        return `${ch} starting — tap to join`;
      },
      vibrate: [200, 100, 200, 100, 200],
      requireInteraction: true,
      renotify: false,
      actions: [{ action: 'join', title: 'Join now' }],
    },

    peer_left: {
      title: () => 'Session ended',
      body: () => 'Your peer has left. Take care of yourself.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    credit_low: {
      title: () => 'Credits running low',
      body: (d) => {
        const b = d.balance;
        return b ? `You have ${b} credit${b === '1' ? '' : 's'} left. Top up to stay connected.`
                 : 'You have very few credits. Top up to continue.';
      },
      vibrate: [100, 50, 100],
      requireInteraction: false,
      renotify: false,
      actions: [{ action: 'topup', title: 'Top up' }],
    },

    peer_matching_update: {
      title: () => 'Still here for you',
      body: () => "We couldn't find a peer right now — your calm space is ready.",
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    check_in_reminder: {
      title: () => 'How are you feeling today?',
      body: () => 'A quick check-in can make a real difference.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [{ action: 'checkin', title: 'Check in' }],
    },

    streak_reminder: {
      title: (d) => d.title || 'Keep your streak going',
      body: (d) => d.body || (d.streak_count ? `${d.streak_count} days — don't break it now.` : 'Log your mood today to keep your streak.'),
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    streak_broken: {
      title: (d) => d.title || "Streak reset — that's okay",
      body: (d) => d.body || "Every day is a fresh start. Check in when you're ready.",
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    milestone: {
      title: () => 'You hit a milestone',
      body: (d) => d.message || 'Keep going — you\'re building something real.',
      vibrate: [100, 50, 200, 50, 100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    session_followup_peer: {
      title: (d) => d.title || 'How are you doing?',
      body: (d) => d.body || 'You supported someone today. Check in with yourself too.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [{ action: 'checkin', title: 'Check in' }],
    },

    session_followup_therapy: {
      title: (d) => d.title || 'Reflection time',
      body: (d) => d.body || 'Your therapy session has ended. Writing something down can help it land.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [{ action: 'journal', title: 'Open journal' }],
    },

    dormant_nudge: {
      title: (d) => d.title || 'We missed you',
      body: (d) => d.body || "It has been a while. Come back at your own pace — we're here.",
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    ai_dormant: {
      title: (d) => d.title || 'Your companion is waiting',
      body: (d) => d.body || "Start a conversation whenever you're ready.",
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    journal_prompt: {
      title: () => 'Something to write about',
      body: (d) => d.prompt || 'Open your journal and put something on the page.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [{ action: 'journal', title: 'Write now' }],
    },

    credit_zero: {
      title: (d) => d.title || 'No credits remaining',
      body: (d) => d.body || 'Top up to request peer support or book a therapy session.',
      vibrate: [100, 50, 100],
      requireInteraction: false,
      renotify: false,
      actions: [{ action: 'topup', title: 'Top up' }],
    },

    no_safety_plan: {
      title: (d) => d.title || 'Set up your safety plan',
      body: (d) => d.body || 'Having one ready — even a simple one — makes a difference in hard moments.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    trusted_contact_request: {
      title: (d) => d.title || 'Someone wants to be your trusted contact',
      body: (d) => d.body || 'Tap to accept or decline their request.',
      vibrate: [150, 50, 150],
      requireInteraction: true,
      renotify: true,
      actions: [{ action: 'view', title: 'View request' }],
    },

    trusted_contact_accepted: {
      title: (d) => d.title || 'Trusted contact request accepted',
      body: (d) => d.body || 'Your safety plan now has a linked contact.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    trusted_contact_mood_alert: {
      title: (d) => d.title || 'Someone you care about is struggling',
      body: (d) => d.body || 'They might need a message right now.',
      vibrate: [200, 100, 200],
      requireInteraction: true,
      renotify: true,
      actions: [{ action: 'view', title: 'Check in' }],
    },

    trusted_contact_no_peer_alert: {
      title: (d) => d.title || 'Someone you care about needed support',
      body: (d) => d.body || "They couldn't find anyone — they might need a message.",
      vibrate: [200, 100, 200],
      requireInteraction: true,
      renotify: true,
      actions: [{ action: 'view', title: 'Reach out' }],
    },

    therapist_upsell: {
      title: (d) => d.title || 'Ready for deeper support?',
      body: (d) => d.body || 'Browse therapists on PeerPal and express interest in minutes.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    unmatched_request: {
      title: (d) => d.title || 'No peer found this time',
      body: (d) => d.body || 'Your credits have been refunded. Try again or visit your calm space.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    first_call_nudge: {
      title: (d) => d.title || 'PeerPal',
      body: (d) => d.body || 'Someone is ready to listen when you are.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [{ action: 'peer', title: 'Talk to someone' }],
    },

    bad_mood_followup: {
      title: (d) => d.title || 'Checking in on you',
      body: (d) => d.body || 'You logged a tough mood earlier. How are you feeling now?',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [{ action: 'checkin', title: 'Check in' }],
    },

    low_mood_streak: {
      title: (d) => d.title || "We're thinking of you",
      body: (d) => d.body || "You've been having a rough stretch. Peer support or a calm space might help.",
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    trial_reminder: {
      title: () => 'Trial ends tomorrow',
      body: () => 'Everything you experienced is still here when you top up.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [{ action: 'topup', title: 'Top up' }],
    },

    // Phase 46. Never names the referred friend (aliases are anonymous).
    referral_reward_credited: {
      title: (d) => `You earned ${d.credits_awarded || 2} credits`,
      body: () => 'A friend you invited made their first top-up.',
      vibrate: [100, 50, 100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    reengagement_step1: {
      title: (d) => d.title || 'Your companion is waiting',
      body: (d) => d.body || 'It only takes 2 minutes to set up. Come say hello.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    reengagement_step2: {
      title: (d) => d.title || "Your companion hasn't heard from you yet",
      body: (d) => d.body || 'How are you doing today? Start a conversation.',
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    reengagement_step3: {
      title: (d) => d.title || "It's been a while",
      body: (d) => d.body || "We've been thinking about you. How are you?",
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [],
    },

    reengagement_purchase: {
      title: (d) => d.title || 'Keep the momentum going',
      body: (d) => d.body || "You've used your free credits. Top up from KSh 100.",
      vibrate: [100],
      requireInteraction: false,
      renotify: false,
      actions: [{ action: 'topup', title: 'Top up' }],
    },
  };

  // Fallback for any type not in the map above. title/body come from the FCM data
  // payload (backend utils/fcm.js puts them there). A title equal to the raw type
  // string is an internal key, never user copy.
  const FALLBACK_NOTIF = {
    title: (d) => (d.title && d.title !== d.type ? d.title : 'PeerPal'),
    body:  (d) => d.body || 'You have a new notification.',
    vibrate: [150],
    requireInteraction: false,
    renotify: false,
    actions: [],
  };

  // Static type → path. peer_request_broadcast and session_confirmation need ids from
  // the payload and are resolved in resolveClickPath.
  const TYPE_ROUTES = {
    peer_left:              '/peer',
    credit_low:              '/credits',
    credit_zero:             '/credits',
    peer_matching_update:    '/calm-space',
    check_in_reminder:       '/mood',
    streak_reminder:         '/mood',
    streak_broken:           '/mood',
    dormant_nudge:           '/mood',
    bad_mood_followup:       '/mood',
    session_followup_peer:   '/mood',
    session_followup_therapy:'/journal',
    journal_prompt:          '/journal',
    ai_dormant:              '/ai',
    no_safety_plan:                 '/safety-plan',
    trusted_contact_request:        '/safety-plan',
    trusted_contact_accepted:       '/safety-plan',
    trusted_contact_mood_alert:     '/safety-plan',
    trusted_contact_no_peer_alert:  '/safety-plan',
    low_mood_streak:         '/peer',
    therapist_upsell:        '/therapy/browse',
    unmatched_request:       '/peer',
    trial_reminder:          '/credits',
    trial_expired:           '/credits',
    reengagement_step1:      '/onboarding/persona',
    reengagement_step2:      '/ai-chat',
    reengagement_step3:      '/dashboard',
    reengagement_purchase:   '/credits',
    referral_reward_credited: '/profile',
  };

  const ACTION_ROUTES = {
    topup:   () => '/credits',
    peer:    () => '/peer',
    checkin: () => '/mood',
    journal: () => '/journal',
    accept:  (d) => `/peer?highlight=${d.request_id || ''}`,
    join:    (d) => (d.session_id ? `/peer/session/${d.session_id}/bridge` : null),
  };

  // FCM payload → { title, options } for registration.showNotification.
  function buildNotification(payload, now) {
    const d = (payload && payload.data) || {};
    const type = d.type || '';
    const cfg = NOTIF_TYPES[type] || FALLBACK_NOTIF;
    return {
      title: cfg.title(d, payload),
      options: {
        body: cfg.body(d, payload),
        icon: '/blob-neutral.png',
        badge: '/badge.png',
        // One tag per type: a newer peer request replaces the older one instead of stacking.
        tag: type || 'peerpal-general',
        data: d,
        vibrate: cfg.vibrate,
        renotify: cfg.renotify,
        requireInteraction: cfg.requireInteraction,
        silent: false,
        timestamp: now === undefined ? Date.now() : now,
        actions: cfg.actions,
      },
    };
  }

  // Tap or action button → path to open, or null to just dismiss.
  function resolveClickPath(d, action) {
    d = d || {};
    if (action === 'skip' || action === 'dismiss') return null;
    if (action && ACTION_ROUTES[action]) {
      const p = ACTION_ROUTES[action](d);
      if (p) return p;
    }
    if (d.type === 'peer_request_broadcast') return `/peer?highlight=${d.request_id || ''}`;
    if (d.type === 'session_confirmation') return d.session_id ? `/peer/session/${d.session_id}/bridge${d.channel ? `?channel=${encodeURIComponent(d.channel)}` : ''}` : '/peer';
    return TYPE_ROUTES[d.type] || d.route || '/';
  }

  root.PeerPalNotifications = { NOTIF_TYPES, FALLBACK_NOTIF, buildNotification, resolveClickPath };
})(self);
