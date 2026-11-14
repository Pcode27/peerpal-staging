import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { CheckCircle, Handshake, ChatText, Microphone, Lock, Brain, Stethoscope, Coin, BellRinging, BellSlash, WarningCircle, Bell, UsersThree, X } from '@phosphor-icons/react';
import client from '../../api/client';
import { trackEvent } from '../../utils/analytics';
import { getFCMStatus, registerFCMToken } from '../../utils/firebase';
import { playPeerRequestTone } from '../../utils/peerRequestAlert';
import { useAuth } from '../../context/AuthContext';

const COST_INFO = {
  text:  { cost: 1, label: 'Text Chat',  desc: '1 credit · 30 min' },
  voice: { cost: 2, label: 'Voice Call', desc: '2 credits · 30 min' },
};

const TOPIC_CATEGORIES = [
  {
    label: 'Life pressure',
    slugs: ['overwhelmed_school_work', 'financial_stress', 'parenting', 'addiction'],
  },
  {
    label: 'Relationships',
    slugs: ['relationship', 'bullying', 'identity'],
  },
  {
    label: 'Trauma & safety',
    slugs: ['abuse_or_assault', 'sexual_harassment', 'domestic_violence'],
  },
  {
    label: 'Loss & grief',
    slugs: ['bereavement'],
  },
];

const QUIZ_STEPS = [
  {
    Icon: Brain,
    question: 'Are you in a safe, calm place right now where you can give someone your full attention?',
    confirm: "Yes, I'm ready",
  },
  {
    Icon: Stethoscope,
    question: 'I understand that as a peer supporter, I am not a therapist and will not give medical advice or diagnoses.',
    confirm: 'I understand',
  },
  {
    Icon: Lock,
    question: 'I will keep everything shared in peer sessions completely confidential.',
    confirm: 'I commit to this',
  },
];

function PeerQuizGate({ onComplete }) {
  const [step, setStep] = useState(0); // -1 = intro, 0-2 = questions, 3 = done
  const [phase, setPhase] = useState('intro'); // 'intro' | 'quiz' | 'submitting' | 'done'

  async function handleConfirm() {
    if (step < QUIZ_STEPS.length - 1) {
      setStep(s => s + 1);
      return;
    }
    setPhase('submitting');
    try {
      await client.post('/api/peer/quiz/complete');
      setPhase('done');
      setTimeout(onComplete, 1200);
    } catch {
      setPhase('quiz'); // let them retry
    }
  }

  if (phase === 'done') {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '24px 16px' }}>
        <CheckCircle size={40} weight="fill" color="var(--color-calm)" style={{ marginBottom: 8 }} />
        <p style={{ fontWeight: 600 }}>Readiness check complete!</p>
        <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 }}>You can now accept peer requests.</p>
      </div>
    );
  }

  if (phase === 'intro') {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '20px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Handshake size={28} weight="duotone" color="var(--color-calm)" />
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Ready to help someone?</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Complete a quick 3-step readiness check first</div>
          </div>
        </div>
        <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
          This only takes 30 seconds and ensures everyone gets the best possible support.
        </p>
        <button className="btn btn--primary" onClick={() => setPhase('quiz')}>
          Start readiness check
        </button>
      </div>
    );
  }

  const current = QUIZ_STEPS[step];
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 16px' }}>
      {/* Progress dots */}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        {QUIZ_STEPS.map((_, i) => (
          <div key={i} style={{
            width: 8, height: 8, borderRadius: '50%',
            background: i <= step ? 'var(--color-accent)' : 'var(--color-border)',
            transition: 'background 200ms',
          }} />
        ))}
      </div>

      <div style={{ textAlign: 'center' }}>
        <div style={{ marginBottom: 12 }}><current.Icon size={40} weight="duotone" color="var(--color-accent)" /></div>
        <p style={{ fontSize: 15, lineHeight: 1.6, fontWeight: 500 }}>{current.question}</p>
      </div>

      <button
        className="btn btn--primary"
        onClick={handleConfirm}
        disabled={phase === 'submitting'}
      >
        {phase === 'submitting' ? 'Saving…' : current.confirm}
      </button>
    </div>
  );
}

// ── Confidence-to-accept overlay ─────────────────────────────────────────────
function ConfidenceOverlay({ request, topicLabel, onAccept, onDecline }) {
  const [secondsLeft, setSecondsLeft] = useState(90);
  const timerRef = useRef(null);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { clearInterval(timerRef.current); onDecline(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, []); // eslint-disable-line

  const pct = (secondsLeft / 90) * 100;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 200, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: 'var(--color-surface-card)', borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0', padding: 'var(--space-lg)', width: '100%' }}>
        <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          {request.channel_preference === 'voice'
            ? <><Microphone size={18} weight="duotone" /> Voice</>
            : <><ChatText size={18} weight="duotone" /> Text</>
          } support needed
        </div>
        {topicLabel && (
          <div style={{ fontSize: '0.88rem', color: 'var(--color-accent)', marginBottom: 12 }}>
            Topic: <strong>{topicLabel}</strong>
          </div>
        )}
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 'var(--space-md)' }}>
          Do you feel ready to support someone with this right now?
        </p>

        {/* Countdown bar */}
        <div style={{ height: 4, background: 'var(--color-border)', borderRadius: 2, marginBottom: 'var(--space-md)', overflow: 'hidden' }}>
          <div style={{ height: '100%', background: secondsLeft > 30 ? '#8FAF9A' : 'var(--color-warning)', width: `${pct}%`, transition: 'width 1s linear, background 300ms' }} />
        </div>
        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', textAlign: 'center', marginBottom: 'var(--space-md)' }}>
          Auto-declining in {secondsLeft}s
        </p>

        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn--primary" style={{ flex: 1, background: 'var(--color-calm)', borderColor: 'var(--color-calm)' }} onClick={() => { clearInterval(timerRef.current); onAccept(); }}>
            Yes, I'm ready
          </button>
          <button className="btn btn--muted" style={{ flex: 1 }} onClick={() => { clearInterval(timerRef.current); onDecline(); }}>
            Not this time
          </button>
        </div>
      </div>
    </div>
  );
}

function PeerQuizModal({ onStartQuiz, onSkip }) {
  const [countdown, setCountdown] = useState(10);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      background: 'rgba(0,0,0,0.55)',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '0 24px',
    }}>
      <div style={{
        width: '100%', maxWidth: 360,
        background: 'rgba(47,38,34,0.82)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid rgba(194,164,138,0.18)',
        borderRadius: 20,
        padding: '28px 22px 24px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <div style={{
            width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
            background: 'rgba(194,164,138,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <UsersThree size={22} weight="duotone" color="rgba(194,164,138,0.9)" />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '1rem', lineHeight: 1.3, color: '#FAF6F2' }}>
              Learn how to help others
            </div>
            <p style={{ fontSize: '0.85rem', color: 'rgba(250,246,242,0.65)', lineHeight: 1.6, marginTop: 6 }}>
              A quick 30-second readiness check means peers can find you when they need support, and you can find them. It's part of your own growth.
            </p>
          </div>
        </div>

        <button
          className="btn btn--primary"
          onClick={onStartQuiz}
          style={{ borderRadius: 12 }}
        >
          Take the readiness check
        </button>

        <button
          onClick={countdown <= 0 ? onSkip : undefined}
          disabled={countdown > 0}
          style={{
            background: 'none', border: 'none',
            cursor: countdown > 0 ? 'default' : 'pointer',
            fontSize: '0.78rem',
            color: countdown > 0 ? 'rgba(250,246,242,0.4)' : 'rgba(250,246,242,1)',
            padding: '2px 0', textAlign: 'center', lineHeight: 1.5,
            transition: 'color 0.3s',
          }}
        >
          {countdown > 0
            ? `Skip in ${countdown}s`
            : `Skip for now`}
        </button>
      </div>
    </div>
  );
}

export default function PeerRequestScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [tab, setTab] = useState('support');
  const [balance, setBalance] = useState(null);
  const [openRequests, setOpenRequests] = useState([]);
  const [topics, setTopics] = useState([]);
  const [quizDone, setQuizDone] = useState(true); // optimistic: hide gate until loaded
  const [showQuizModal, setShowQuizModal] = useState(false);
  const [peerCount, setPeerCount] = useState(null);
  const [channel, setChannel] = useState('text');

  const [topicOpen, setTopicOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0); // seconds remaining
  const cooldownRef = useRef(null);
  const [confidenceRequest, setConfidenceRequest] = useState(null); // request pending confidence check
  const prevReqLenRef = useRef(0);
  const [availableUntil, setAvailableUntil] = useState(null); // ISO string or null
  const [availNow, setAvailNow] = useState('');    // live countdown string
  const [creditGate, setCreditGate] = useState(null); // { cost, channel } — shown when balance < cost

  // Leaderboard state
  const [stats, setStats] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [boardLoading, setBoardLoading] = useState(false);

  // Availability tab state
  const [availSetting, setAvailSetting] = useState(false); // loading indicator for save
  const [customHours, setCustomHours] = useState(2);
  const [fcmStatus, setFcmStatus] = useState(null); // null | 'active' | 'denied' | 'pending' | 'unsupported' | 'error'
  const [fcmErrorCode, setFcmErrorCode] = useState(null);
  const [fcmChecking, setFcmChecking] = useState(false);
  const [nightAlerts, setNightAlerts] = useState(false); // notif_peer_night: push during 22:00–07:00
  const highlightRef = useRef(null); // ref to highlighted request card

  useEffect(() => {
    async function load() {
      try {
        const [balRes, reqRes, quizRes, topicsRes, availRes, countRes] = await Promise.all([
          client.get('/api/credits/balance'),
          client.get('/api/peer/requests/open'),
          client.get('/api/peer/quiz/status'),
          client.get('/api/peer/topics'),
          client.get('/api/peer/availability'),
          client.get('/api/peer/available-count'),
        ]);
        setBalance(balRes.data.balance ?? 0);
        setOpenRequests(reqRes.data.requests ?? reqRes.data ?? []);
        const quizComplete = quizRes.data.peer_quiz_done;
        setQuizDone(quizComplete);
        setTopics(topicsRes.data.topics ?? []);
        if (availRes.data.available) setAvailableUntil(availRes.data.available_until);
        setNightAlerts(!!availRes.data.night_alerts);
        setPeerCount(countRes.data.count ?? 0);

        // Show quiz intercept modal once per account if quiz not done
        if (!quizComplete && user?.id) {
          const seenKey = `peer_quiz_modal_seen_${user.id}`;
          const lastSeen = parseInt(localStorage.getItem(seenKey) || '0', 10);
          const reshowAfter = 8 * 60 * 60 * 1000;
          if (!lastSeen || Date.now() - lastSeen > reshowAfter) {
            setTimeout(() => setShowQuizModal(true), 1000);
          }
        }
      } catch {
        setError('Failed to load. Please try again.');
      } finally {
        setLoading(false);
      }
    }
    load();

    // Poll for new/closed requests — paused when tab is hidden to avoid wasted requests
    const poll = setInterval(async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const { data } = await client.get('/api/peer/requests/open');
        setOpenRequests(data.requests ?? data ?? []);
      } catch { /* non-fatal */ }
    }, 3000);

    // Seed cooldown if navigated back from PeerConnectingScreen after a COOLDOWN_ACTIVE error
    const seedCooldown = location.state?.cooldown;
    if (seedCooldown > 0) {
      setCooldown(seedCooldown);
      cooldownRef.current = setInterval(() => {
        setCooldown(prev => {
          if (prev <= 1) { clearInterval(cooldownRef.current); return 0; }
          return prev - 1;
        });
      }, 1000);
    }

    return () => { clearInterval(poll); clearInterval(cooldownRef.current); };
  }, []);

  // Scroll to and pulse a highlighted request (from notification tap)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const highlightId = params.get('highlight');
    if (!highlightId || loading) return;
    const el = highlightRef.current;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'box-shadow 0.3s ease';
      el.style.boxShadow = '0 0 0 3px var(--color-accent)';
      setTimeout(() => { if (el) el.style.boxShadow = ''; }, 2500);
    }
  }, [loading, location.search]);

  // Auto-dismiss confidence overlay if the request was cancelled while the peer was deciding
  useEffect(() => {
    if (!confidenceRequest) return;
    const stillOpen = openRequests.some(r => r.id === confidenceRequest.id);
    if (!stillOpen) {
      setConfidenceRequest(null);
      setError('This request was just cancelled by the user.');
    }
  }, [openRequests, confidenceRequest]);

  // Ringtone — play when a new peer request appears after page has loaded
  useEffect(() => {
    if (loading) {
      prevReqLenRef.current = openRequests.length;
      return;
    }
    if (openRequests.length > prevReqLenRef.current) {
      playPeerRequestTone(); // shared gate with the App banner: rings once, not twice
    }
    prevReqLenRef.current = openRequests.length;
  }, [openRequests, loading]); // eslint-disable-line

  // Live countdown for availability window
  useEffect(() => {
    if (!availableUntil) { setAvailNow(''); return; }
    function tick() {
      const diffMs = new Date(availableUntil) - Date.now();
      if (diffMs <= 0) { setAvailableUntil(null); setAvailNow(''); return; }
      const totalMins = Math.floor(diffMs / 60000);
      let display;
      if (totalMins >= 60) {
        const hrs = Math.floor(totalMins / 60);
        const remainMins = totalMins % 60;
        display = remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
      } else {
        const secs = Math.floor((diffMs % 60000) / 1000);
        display = `${totalMins}:${String(secs).padStart(2, '0')}`;
      }
      setAvailNow(display);
    }
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [availableUntil]);

  async function loadLeaderboard() {
    if (stats) return;
    setBoardLoading(true);
    try {
      const [statsRes, boardRes] = await Promise.all([
        client.get('/api/peer/stats'),
        client.get('/api/peer/leaderboard'),
      ]);
      setStats(statsRes.data);
      setLeaderboard(boardRes.data.leaderboard ?? []);
    } catch { /* non-fatal */ }
    finally { setBoardLoading(false); }
  }

  function handleTabChange(t) {
    setTab(t);
    if (t === 'leaderboard') loadLeaderboard();
    if (t === 'availability' && fcmStatus === null) checkFCMStatus();
  }

  async function checkFCMStatus() {
    setFcmChecking(true);
    const result = await getFCMStatus();
    setFcmStatus(result.status);
    setFcmErrorCode(result.errorCode || null);
    if (result.status === 'active' && result.token) {
      await client.patch('/api/profile', { fcm_token: result.token }).catch(() => {});
    }
    setFcmChecking(false);
  }

  async function handleSetAvailability(mode, hours) {
    if (availSetting) return;
    setAvailSetting(true);
    // Going available is the moment push matters, so ask for permission here. Started before
    // any await so the browser still sees the tap as the user gesture behind the prompt.
    const pushReady = mode !== 'off' && typeof Notification !== 'undefined' && Notification.permission !== 'denied'
      ? registerFCMToken()
      : null;
    try {
      if (mode === 'off') {
        await client.delete('/api/peer/availability');
        setAvailableUntil(null);
      } else {
        const body = mode === 'all_day' ? { mode: 'all_day' } : { hours };
        const { data } = await client.post('/api/peer/availability', body);
        setAvailableUntil(data.available_until);
      }
    } catch { /* non-fatal */ }
    finally { setAvailSetting(false); }
    if (pushReady) {
      await pushReady;
      const result = await getFCMStatus();
      setFcmStatus(result.status);
      setFcmErrorCode(result.errorCode || null);
    }
  }

  async function handleNightAlerts(value) {
    setNightAlerts(value);
    try {
      await client.patch('/api/notifications/preferences', { notif_peer_night: value });
    } catch {
      setNightAlerts(!value);
    }
  }

  async function handleEnablePush() {
    setFcmChecking(true);
    await registerFCMToken();
    const result = await getFCMStatus();
    setFcmStatus(result.status);
    setFcmChecking(false);
  }

  function handleAcceptIntent(request) {
    setConfidenceRequest(request);
  }

  async function confirmAccept(request) {
    setConfidenceRequest(null);
    setError('');
    try {
      const { data } = await client.patch(`/api/peer/request/${request.id}/accept`);
      navigate(`/peer/session/${data.session_id}/bridge`, { replace: true, state: { channel: data.channel } });
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'QUIZ_REQUIRED') {
        setQuizDone(false);
        return;
      }
      if (code === 'REQUEST_UNAVAILABLE' || code === 'REQUEST_CANCELLED') {
        setOpenRequests(prev => prev.filter(r => r.id !== request.id));
        setError('This request is no longer available.');
        return;
      }
      setError(err.response?.data?.error || 'Could not accept request. Please try again.');
    }
  }

  async function declineAccept(request) {
    setConfidenceRequest(null);
    // Fire-and-forget analytics — increment decline_count
    client.patch(`/api/peer/request/${request.id}/decline`).catch(() => {});
  }

  function handleTopicPick(slug, label) {
    if (cooldown > 0) return;
    const cost = COST_INFO[channel].cost;
    if (balance < cost) {
      setCreditGate({ cost, channel });
      return;
    }
    navigate('/peer/connecting', { state: { topic: slug, channel, topicLabel: label } });
  }

  if (loading) return (
    <div className="screen">
      <div className="page-header">
        <button className="page-header__back" onClick={() => navigate(-1)} aria-label="Back">‹</button>
        <h2 className="page-header__title">Peer Support</h2>
      </div>
      <div style={{ padding: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div className="skeleton" style={{ height: 72, borderRadius: 'var(--radius-lg)' }} />
        <div className="skeleton" style={{ height: 100, borderRadius: 'var(--radius-lg)' }} />
        <div className="skeleton" style={{ height: 52, borderRadius: 'var(--radius-pill)' }} />
      </div>
    </div>
  );

  const balanceLow = balance !== null && balance < 2;

  return (
    <div className="screen" style={{ padding: 0, display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <div className="page-header" style={{ flexShrink: 0 }}>
        <button className="page-header__back" onClick={() => navigate(-1)} aria-label="Back">‹</button>
        <h2 className="page-header__title">Peer Support</h2>
        {/* Credits badge inline in header */}
        <button
          onClick={() => navigate('/credits')}
          style={{
            marginLeft: 'auto', marginRight: 4,
            display: 'flex', alignItems: 'center', gap: 5,
            background: balanceLow ? 'rgba(220,60,60,0.12)' : 'rgba(194,164,138,0.15)',
            border: `1px solid ${balanceLow ? 'var(--color-danger)' : 'var(--color-border)'}`,
            borderRadius: 'var(--radius-pill)', padding: '4px 10px',
            fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer',
            color: balanceLow ? 'var(--color-danger)' : 'var(--color-text)',
          }}
        >
          <Coin size={14} weight="duotone" /> {balance ?? '—'}
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        {[['support', 'Support'], ['leaderboard', 'Leaderboard'], ['availability', 'Availability']].map(([val, label]) => (
          <button
            key={val}
            onClick={() => handleTabChange(val)}
            style={{
              flex: 1, padding: '10px 0', fontSize: 14, fontWeight: tab === val ? 600 : 400,
              color: tab === val ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: tab === val ? '2px solid var(--color-accent)' : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'support' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Scrollable body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', paddingBottom: 'calc(var(--bottom-nav-height, 64px) + env(safe-area-inset-bottom) + 16px)', display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* ── Availability status banner ── */}
            <button
              onClick={() => handleTabChange('availability')}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', borderRadius: 'var(--radius-md)',
                border: `1.5px solid ${availableUntil ? 'rgba(143,175,154,0.6)' : 'var(--color-border)'}`,
                background: availableUntil ? 'rgba(143,175,154,0.08)' : 'var(--color-surface-card)',
                width: '100%', cursor: 'pointer', textAlign: 'left',
              }}
            >
              {availableUntil
                ? <BellRinging size={18} weight="duotone" color="var(--color-calm)" />
                : <BellSlash size={18} weight="duotone" color="var(--color-text-muted)" />}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: availableUntil ? 'var(--color-calm)' : 'var(--color-text)' }}>
                  {availableUntil ? `Available · ${availNow} remaining` : 'You are not available'}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: 1 }}>
                  {availableUntil ? 'You\'ll receive push alerts for new requests' : 'Tap to set your availability'}
                </div>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>›</span>
            </button>

            {/* ── Peer count signal ── */}
            {peerCount !== null && (
              <div style={{
                fontSize: '0.78rem', color: peerCount > 0 ? 'var(--color-calm)' : 'var(--color-text-muted)',
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 12px', borderRadius: 'var(--radius-sm)',
                background: peerCount > 0 ? 'rgba(143,175,154,0.1)' : 'transparent',
              }}>
                <UsersThree size={15} weight="duotone" color={peerCount > 0 ? 'var(--color-calm)' : 'var(--color-text-muted)'} />
                {peerCount > 0
                  ? `${peerCount} peer${peerCount !== 1 ? 's' : ''} available now`
                  : 'No peers available right now — you can still send a request and we\'ll notify them when they\'re next active'}
              </div>
            )}

            {/* ── Accept card — always at top if requests exist ── */}
            {openRequests.length > 0 && (
              <div style={{
                background: 'rgba(143,175,154,0.1)',
                border: '1.5px solid rgba(143,175,154,0.45)',
                borderRadius: 'var(--radius-md)',
                padding: '12px 14px',
              }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--color-calm)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10 }}>
                  Someone needs support now
                </div>
                {!quizDone ? (
                  <PeerQuizGate onComplete={() => setQuizDone(true)} />
                ) : (
                  openRequests.map((req) => {
                    const topicInfo = topics.find(t => t.slug === req.topic_slug);
                    const highlightId = new URLSearchParams(location.search).get('highlight');
                    return (
                      <div key={req.id} ref={req.id === highlightId ? highlightRef : null} style={{ marginBottom: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                          {req.channel_preference === 'voice'
                            ? <Microphone size={15} weight="duotone" color="var(--color-calm)" />
                            : <ChatText size={15} weight="duotone" color="var(--color-calm)" />}
                          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                            {req.channel_preference === 'voice' ? 'Voice' : 'Text'} session
                          </span>
                          {topicInfo && (
                            <span style={{ fontSize: '0.75rem', color: 'var(--color-calm)', marginLeft: 2 }}>· {topicInfo.label}</span>
                          )}
                        </div>
                        <button
                          onClick={() => handleAcceptIntent(req)}
                          className="btn btn--primary"
                          style={{ background: 'var(--color-calm)', borderColor: 'var(--color-calm)' }}
                        >
                          I'm here — accept session
                        </button>
                      </div>
                    );
                  })
                )}
                <p style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: 4 }}>Peers earn 25% of the session cost — credits convert once 2 accumulate.</p>
              </div>
            )}

            {/* Channel toggle */}
            <div style={{ display: 'flex', gap: 8 }}>
              {Object.entries(COST_INFO).map(([val, info]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setChannel(val)}
                  style={{
                    flex: 1, padding: '9px 8px',
                    borderRadius: 'var(--radius-sm)',
                    border: `2px solid ${channel === val ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    background: channel === val ? 'rgba(194,164,138,0.15)' : 'var(--color-surface-card)',
                    cursor: 'pointer', textAlign: 'center',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '0.85rem', color: channel === val ? 'var(--color-text)' : '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                    {val === 'text' ? <ChatText size={14} weight="duotone" /> : <Microphone size={14} weight="duotone" />} {info.label}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: 2 }}>{info.desc}</div>
                </button>
              ))}
            </div>

            {/* Topic grid — always visible, no dropdown */}
            {topics.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                  What do you need support with? <span style={{ color: 'var(--color-danger)' }}>*</span>
                </div>

                {/* "Just listen" — full width */}
                {topics.filter(t => t.slug === 'general').map(t => (
                  <button key={t.slug} type="button"
                    onClick={() => handleTopicPick(t.slug, t.label)}
                    style={{
                      width: '100%', padding: '11px 14px', textAlign: 'left',
                      borderRadius: 'var(--radius-sm)',
                      border: '2px solid var(--color-border)',
                      background: 'var(--color-surface-card)',
                      cursor: 'pointer', fontSize: '0.88rem', fontWeight: 400,
                      color: '#ffffff',
                    }}
                  >{t.label}</button>
                ))}

                {/* Categorised 2-column grid */}
                {TOPIC_CATEGORIES.map(cat => {
                  const catTopics = cat.slugs.map(s => topics.find(t => t.slug === s)).filter(Boolean);
                  if (!catTopics.length) return null;
                  return (
                    <div key={cat.label}>
                      <div style={{ fontSize: '0.67rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 5 }}>{cat.label}</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                        {catTopics.map(t => (
                          <button key={t.slug} type="button"
                            onClick={() => handleTopicPick(t.slug, t.label)}
                            style={{
                              padding: '9px 8px', textAlign: 'left',
                              borderRadius: 'var(--radius-sm)',
                              border: '2px solid var(--color-border)',
                              background: 'var(--color-surface-card)',
                              cursor: 'pointer', fontSize: '0.78rem', lineHeight: 1.35,
                              color: '#ffffff',
                            }}
                          >{t.label}</button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {cooldown > 0 && (
              <div style={{
                background: 'rgba(220,60,60,0.10)', border: '1px solid var(--color-danger)',
                borderRadius: 'var(--radius-md)', padding: '12px 16px',
                fontSize: '0.85rem', color: 'var(--color-danger)', textAlign: 'center',
              }}>
                Too many cancelled requests. Please wait {cooldown}s before trying again.
              </div>
            )}
            {error && <div className="error-msg">{error}</div>}

            {balance < COST_INFO[channel].cost && (
              <p style={{ fontSize: '0.78rem', textAlign: 'center', color: 'var(--color-text-muted)' }}>
                {COST_INFO[channel].label} requires {COST_INFO[channel].cost} credit{COST_INFO[channel].cost > 1 ? 's' : ''} · you have {balance}
              </p>
            )}
          </div>

        </div>
      )}

      {/* Quiz intercept modal — shown once per account when quiz not done */}
      {showQuizModal && (
        <PeerQuizModal
          onStartQuiz={() => { setShowQuizModal(false); setTab('support'); }}
          onSkip={() => {
            if (user?.id) localStorage.setItem(`peer_quiz_modal_seen_${user.id}`, Date.now().toString());
            setShowQuizModal(false);
          }}
        />
      )}

      {/* Confidence overlay */}
      {confidenceRequest && (
        <ConfidenceOverlay
          request={confidenceRequest}
          topicLabel={topics.find(t => t.slug === confidenceRequest.topic_slug)?.label || null}
          onAccept={() => confirmAccept(confidenceRequest)}
          onDecline={() => declineAccept(confidenceRequest)}
        />
      )}

      {/* Credit gate — bottom sheet shown when user taps a topic without enough credits */}
      {creditGate && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end' }}
          onClick={(e) => { if (e.target === e.currentTarget) setCreditGate(null); }}
        >
          <div style={{
            width: '100%',
            background: 'var(--color-surface-card)',
            borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
            padding: '12px 20px 40px',
            display: 'flex', flexDirection: 'column', gap: 16,
          }}>
            <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 4 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.18)' }} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{
                width: 48, height: 48, borderRadius: 13, flexShrink: 0,
                background: 'rgba(220,60,60,0.1)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Coin size={24} weight="duotone" color="var(--color-danger)" />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: '1rem' }}>Not enough credits</div>
                <div style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)', marginTop: 3, lineHeight: 1.45 }}>
                  {COST_INFO[creditGate.channel].label} costs {creditGate.cost} credit{creditGate.cost > 1 ? 's' : ''}.
                  You currently have <strong>{balance}</strong>.
                </div>
              </div>
            </div>

            <button
              className="btn btn--primary"
              onClick={() => { setCreditGate(null); navigate('/credits'); }}
            >
              Top up credits
            </button>
            <button
              onClick={() => setCreditGate(null)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '0.85rem', color: 'var(--color-text-muted)',
                padding: '2px 0', textAlign: 'center',
              }}
            >
              Maybe later
            </button>
          </div>
        </div>
      )}

      {tab === 'leaderboard' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px', paddingBottom: 'calc(var(--bottom-nav-height, 64px) + env(safe-area-inset-bottom) + 16px)', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {boardLoading ? (
            <>
              <div className="skeleton" style={{ height: 80, borderRadius: 'var(--radius-lg)' }} />
              <div className="skeleton" style={{ height: 200, borderRadius: 'var(--radius-lg)' }} />
            </>
          ) : (
            <>
              {stats && (
                <div className="card" style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
                  {[
                    { label: 'Sessions', value: stats.sessions_completed },
                    { label: 'Credits earned', value: stats.credits_earned },
                    { label: 'Rank', value: `#${stats.rank}` },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-accent)' }}>{value}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>{label}</div>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <h3 style={{ marginBottom: 12 }}>Top Peers</h3>
                {leaderboard.length === 0 ? (
                  <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', textAlign: 'center', paddingTop: 16 }}>
                    No peer sessions completed yet. Be the first!
                  </p>
                ) : (
                  leaderboard.map((entry, i) => (
                    <div
                      key={entry.alias}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '10px 0', borderBottom: i < leaderboard.length - 1 ? '1px solid var(--color-border)' : 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{
                          width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 13, fontWeight: 700,
                          background: i === 0 ? '#C8943A' : i === 1 ? '#9E9E9E' : i === 2 ? '#8D6E63' : 'var(--color-surface-secondary)',
                          color: i < 3 ? '#fff' : 'var(--color-text-secondary)',
                        }}>
                          {i + 1}
                        </span>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>{entry.alias}</span>
                      </div>
                      <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                        {entry.sessions_completed} session{entry.sessions_completed !== 1 ? 's' : ''}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'availability' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px', paddingBottom: 'calc(var(--bottom-nav-height, 64px) + env(safe-area-inset-bottom) + 16px)', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Status card */}
          <div style={{
            padding: '20px 18px', borderRadius: 'var(--radius-lg)',
            background: availableUntil ? 'rgba(143,175,154,0.10)' : 'var(--color-surface-card)',
            border: `2px solid ${availableUntil ? 'var(--color-calm)' : 'var(--color-border)'}`,
            display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: '50%', flexShrink: 0,
              background: availableUntil ? 'rgba(143,175,154,0.20)' : 'rgba(194,164,138,0.10)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {availableUntil
                ? <BellRinging size={24} weight="duotone" color="var(--color-calm)" />
                : <BellSlash size={24} weight="duotone" color="var(--color-text-muted)" />}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '1rem', color: availableUntil ? 'var(--color-calm)' : 'var(--color-text)' }}>
                {availableUntil ? 'You are available' : 'You are not available'}
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                {availableUntil
                  ? `Receiving requests · ${availNow} remaining`
                  : 'Set a window below to start receiving requests'}
              </div>
              {availableUntil && fcmStatus && fcmStatus !== 'active' && (
                <div style={{ fontSize: '0.75rem', color: 'var(--color-warning)', marginTop: 4 }}>
                  Push is off on this device. You will only see requests while PeerPal is open.
                </div>
              )}
            </div>
          </div>

          {/* Options */}
          <div>
            <p style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Set availability</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

              <button
                className="btn btn--secondary"
                style={{ justifyContent: 'flex-start', gap: 12, padding: '14px 16px', opacity: availSetting ? 0.6 : 1 }}
                disabled={availSetting}
                onClick={() => handleSetAvailability('all_day')}
              >
                <BellRinging size={20} weight="duotone" color="var(--color-calm)" />
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>All day</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 1 }}>Available until midnight tonight</div>
                </div>
              </button>

              <div style={{ background: 'var(--color-surface-card)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', padding: '14px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <Bell size={20} weight="duotone" color="var(--color-accent)" />
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Custom duration</div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  {[1, 2, 4, 8].map(h => (
                    <button
                      key={h}
                      onClick={() => setCustomHours(h)}
                      style={{
                        flex: 1, padding: '8px 0', borderRadius: 'var(--radius-sm)', fontSize: '0.85rem', fontWeight: 600,
                        border: `1.5px solid ${customHours === h ? 'var(--color-accent)' : 'var(--color-border)'}`,
                        background: customHours === h ? 'rgba(200,148,58,0.12)' : 'transparent',
                        color: customHours === h ? 'var(--color-accent)' : 'var(--color-text-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      {h}h
                    </button>
                  ))}
                </div>
                <button
                  className="btn btn--primary"
                  style={{ opacity: availSetting ? 0.6 : 1 }}
                  disabled={availSetting}
                  onClick={() => handleSetAvailability('hours', customHours)}
                >
                  {availSetting ? 'Saving…' : `Set for ${customHours} hour${customHours > 1 ? 's' : ''}`}
                </button>
              </div>

              {availableUntil && (
                <button
                  className="btn btn--muted"
                  style={{ opacity: availSetting ? 0.6 : 1 }}
                  disabled={availSetting}
                  onClick={() => handleSetAvailability('off')}
                >
                  {availSetting ? 'Saving…' : 'Turn off availability'}
                </button>
              )}
            </div>
          </div>

          {/* Night alerts — quiet hours opt-in (notif_peer_night) */}
          <label
            className="toggle-row"
            style={{ cursor: 'pointer', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Night alerts (10pm to 7am)</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                Also send push alerts during quiet hours while you are available. Off means requests at night wait in the app.
              </div>
            </div>
            <input
              type="checkbox"
              checked={nightAlerts}
              onChange={(e) => handleNightAlerts(e.target.checked)}
              aria-label="Night alerts"
              style={{ width: 20, height: 20, flexShrink: 0, accentColor: 'var(--color-accent)', cursor: 'pointer' }}
            />
          </label>

          {/* FCM status */}
          <div style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', padding: '14px 16px' }}>
            <p style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Push notifications</p>
            {fcmChecking ? (
              <div style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>Checking…</div>
            ) : fcmStatus === null ? (
              <button className="btn btn--secondary" onClick={checkFCMStatus} style={{ fontSize: '0.85rem' }}>Check status</button>
            ) : fcmStatus === 'active' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle size={18} weight="fill" color="var(--color-calm)" />
                <span style={{ fontSize: '0.85rem', color: 'var(--color-calm)', fontWeight: 600 }}>Active — you will receive push alerts</span>
              </div>
            ) : fcmStatus === 'denied' ? (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <WarningCircle size={18} weight="fill" color="var(--color-danger)" />
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-danger)', fontWeight: 600 }}>Notifications blocked</span>
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>Enable notifications in your browser or phone settings, then return here.</p>
              </div>
            ) : fcmStatus === 'pending' ? (
              <div>
                <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', marginBottom: 8 }}>Notifications not yet enabled on this device.</p>
                <button className="btn btn--primary" onClick={handleEnablePush} disabled={fcmChecking}>Enable push notifications</button>
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <WarningCircle size={18} weight="fill" color="var(--color-warning)" />
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-warning)', fontWeight: 600 }}>Registration failed</span>
                </div>
                <p style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginBottom: 4 }}>Could not register for push notifications.</p>
                {fcmErrorCode && (
                  <p style={{ fontSize: '0.72rem', fontFamily: 'monospace', color: 'var(--color-text-muted)', background: 'rgba(0,0,0,0.06)', borderRadius: 4, padding: '3px 6px', marginBottom: 8, wordBreak: 'break-all' }}>{fcmErrorCode}</p>
                )}
                <button className="btn btn--secondary" onClick={handleEnablePush} disabled={fcmChecking}>Retry</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
