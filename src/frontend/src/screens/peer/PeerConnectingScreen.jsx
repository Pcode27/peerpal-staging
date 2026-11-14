import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Heart, ChatText, Microphone } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext';
import client from '../../api/client';

function getInitials(alias) {
  if (!alias) return 'ME';
  const parts = alias.trim().split(/[\s_-]+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return alias.slice(0, 2).toUpperCase();
}

// Staggered bounce dots
function ConnectingDots() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {[0, 1, 2].map(i => (
        <span
          key={i}
          style={{
            width: 7, height: 7, borderRadius: '50%',
            background: 'var(--color-calm)',
            display: 'inline-block',
            animation: `pp-dot-bounce 1.4s ease-in-out ${i * 200}ms infinite`,
          }}
        />
      ))}
    </div>
  );
}

// Solid line shown when connected
function ConnectedLine() {
  return (
    <div style={{
      width: 56, height: 2,
      background: `linear-gradient(90deg, var(--color-calm), #8FAF9A)`,
      borderRadius: 2,
      animation: 'pp-line-appear 400ms ease forwards',
    }} />
  );
}

export default function PeerConnectingScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  const [phase, setPhase] = useState('submitting'); // submitting | waking | waiting | connected | error
  const [requestId, setRequestId] = useState(null);
  const [sessionChannel, setSessionChannel] = useState(location.state?.channel || 'text');
  const [topicLabel, setTopicLabel] = useState(location.state?.topicLabel || '');
  const [errorMsg, setErrorMsg] = useState('');
  const [retryKey, setRetryKey] = useState(0);

  const initRef = useRef(false);
  const pollRef = useRef(null);
  const userCancelledRef = useRef(false);
  const requestIdRef = useRef(null); // mirrors requestId state for use in cancel during submitting phase
  const initials = getInitials(user?.alias);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    async function init() {
      setPhase('submitting');

      // On a network error, poll /api/health until alive (Render free tier cold start ~20-30s),
      // then retry the actual request once automatically.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // 1. Recover any existing active request (handles refresh / remount)
          const { data: activeData } = await client.get('/api/peer/request/active', { timeout: 35000 });

          let rid = null;

          if (activeData.request) {
            const r = activeData.request;
            rid = r.id;
            setSessionChannel(r.channel_preference || 'text');
            if (r.topic_label) setTopicLabel(r.topic_label);

            // Already matched — go straight to bridge
            if (r.status === 'active' && r.session_id) {
              navigate(`/peer/session/${r.session_id}/bridge`, { replace: true, state: { channel: r.channel_preference || 'text' } });
              return;
            }
          } else {
            // 2. No existing request — create one from route state
            const { topic, channel, topicLabel: tl } = location.state || {};
            if (!topic || !channel) {
              navigate('/peer', { replace: true });
              return;
            }
            if (tl) setTopicLabel(tl);
            setSessionChannel(channel);

            const { data } = await client.post('/api/peer/request', {
              channel_preference: channel,
              topic_slug: topic,
            }, { timeout: 35000 });
            rid = data.request_id;
          }

          setRequestId(rid);
          requestIdRef.current = rid;
          setPhase('waiting');

          // Outgoing request tone — same pattern as therapist call (660→880 Hz)
          try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const beep = (t, f, d) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = f; g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + d); o.start(t); o.stop(t + d); };
            beep(ctx.currentTime, 660, 0.2); beep(ctx.currentTime + 0.28, 880, 0.2);
          } catch { /* AudioContext unavailable */ }

          // 3. Poll every 2s — navigate immediately when peer accepts (no button click needed)
          pollRef.current = setInterval(async () => {
            try {
              const { data } = await client.get(`/api/peer/request/${rid}/status`);
              if (data.status === 'active' && data.session_id) {
                clearInterval(pollRef.current);
                navigate(`/peer/session/${data.session_id}/bridge`, { replace: true, state: { channel: data.channel_preference || sessionChannel } });
              } else if (data.status === 'closed' || data.status === 'escalated') {
                clearInterval(pollRef.current);
                if (!userCancelledRef.current) {
                  navigate('/calm-space', {
                    replace: true,
                    state: { topicLabel, topicSlug: location.state?.topic },
                  });
                }
              }
            } catch { /* keep polling on transient errors */ }
          }, 2000);

          return; // success

        } catch (err) {
          const code = err.response?.data?.code;
          if (code === 'INSUFFICIENT_CREDITS') {
            navigate('/credits', { replace: true });
            return;
          }
          if (code === 'COOLDOWN_ACTIVE') {
            navigate('/peer', { replace: true, state: { cooldown: err.response.data.retry_after || 90 } });
            return;
          }
          // Hard 4xx errors don't benefit from retrying
          if (err.response?.status >= 400 && err.response?.status < 500) {
            setPhase('error');
            setErrorMsg(err.response?.data?.error || 'Something went wrong. Please try again.');
            return;
          }
          // Network/timeout error — server is cold-starting. Show 'waking' state and
          // poll /api/health every 5s (up to 45s) before retrying the request automatically.
          if (attempt === 0) {
            setPhase('waking');
            const deadline = Date.now() + 50000;
            let alive = false;
            while (Date.now() < deadline) {
              try {
                // Use unauthenticated /health so the axios interceptor never fires
                // and no navigation side-effects occur during the probe.
                await client.get('/health', { timeout: 8000 });
                alive = true;
                break;
              } catch {
                await new Promise(r => setTimeout(r, 5000));
              }
            }
            if (!alive) {
              setPhase('error');
              setErrorMsg('Server is taking too long to respond. Please try again.');
              return;
            }
            // Give the server 2s after the health check before hitting authenticated routes.
            await new Promise(r => setTimeout(r, 2000));
            setPhase('submitting');
            // loop continues — attempt 1
          } else {
            setPhase('error');
            setErrorMsg('Could not connect to the server. Please try again.');
          }
        }
      }
    }

    init();
    return () => clearInterval(pollRef.current);
  }, [retryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleCancel() {
    userCancelledRef.current = true;
    clearInterval(pollRef.current);
    const rid = requestIdRef.current || requestId;
    if (rid) client.patch(`/api/peer/request/${rid}/close`).catch(() => {});
    navigate('/peer', { replace: true });
  }

  function handleRetry() {
    clearInterval(pollRef.current);
    initRef.current = false;
    setPhase('submitting');
    setErrorMsg('');
    setRequestId(null);
    setRetryKey(k => k + 1);
  }

  const isVoice = sessionChannel === 'voice';

  return (
    <>
      {/* Keyframes — injected once */}
      <style>{`
        @keyframes pp-dot-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
          30% { transform: translateY(-7px); opacity: 1; }
        }
        @keyframes pp-ring-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(143,175,154,0.55); }
          50% { box-shadow: 0 0 0 10px rgba(143,175,154,0); }
        }
        @keyframes pp-line-appear {
          from { opacity: 0; transform: scaleX(0); }
          to { opacity: 1; transform: scaleX(1); }
        }
        @keyframes pp-peer-pop {
          0% { transform: scale(0.6); opacity: 0; }
          70% { transform: scale(1.08); opacity: 1; }
          100% { transform: scale(1); }
        }
      `}</style>

      <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', minHeight: '100dvh' }}>
        {/* Header */}
        <div className="page-header" style={{ flexShrink: 0 }}>
          <button className="page-header__back" onClick={handleCancel} aria-label="Back">‹</button>
          <h2 className="page-header__title">Finding your peer</h2>
        </div>

        {/* Body */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          padding: '24px 24px 48px', gap: 28,
        }}>
          {/* Heading */}
          <div style={{ textAlign: 'center' }}>
            <h2 style={{ fontFamily: 'var(--font-editorial)', fontSize: '1.45rem', lineHeight: 1.3, marginBottom: 8 }}>
              {phase === 'connected' ? "Someone's here for you" : "Let's find you someone to talk to"}
            </h2>
            {(topicLabel || isVoice) && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: '0.82rem', color: 'var(--color-text-muted)' }}>
                {isVoice ? <Microphone size={13} weight="duotone" /> : <ChatText size={13} weight="duotone" />}
                {topicLabel || (isVoice ? 'Voice session' : 'Text session')}
              </div>
            )}
          </div>

          {/* Avatar card */}
          <div style={{
            width: '100%', maxWidth: 360,
            background: 'var(--color-surface-card)',
            borderRadius: 'var(--radius-lg)',
            border: `1.5px solid ${phase === 'connected' ? 'rgba(143,175,154,0.5)' : 'var(--color-border)'}`,
            boxShadow: phase === 'connected'
              ? '0 8px 32px rgba(143,175,154,0.18)'
              : '0 4px 20px rgba(47,38,34,0.07)',
            padding: '36px 24px 28px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
            transition: 'box-shadow 400ms ease, border-color 400ms ease',
          }}>
            {/* Two avatars + connector */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {/* Requester */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 72, height: 72, borderRadius: '50%',
                  background: 'var(--color-calm)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.3rem', fontWeight: 700, color: '#fff',
                  letterSpacing: '0.02em',
                }}>
                  {initials}
                </div>
                <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontWeight: 500 }}>You</span>
              </div>

              {/* Connector */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingBottom: 20 }}>
                {phase === 'connected' ? <ConnectedLine /> : <ConnectingDots />}
              </div>

              {/* Peer */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                {phase === 'connected' ? (
                  <div style={{
                    width: 72, height: 72, borderRadius: '50%',
                    background: 'rgba(143,175,154,0.18)',
                    border: '2px solid var(--color-calm)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    animation: 'pp-peer-pop 500ms cubic-bezier(0.34,1.56,0.64,1) forwards',
                  }}>
                    <Heart size={28} weight="fill" color="var(--color-calm)" />
                  </div>
                ) : (
                  <div style={{
                    width: 72, height: 72, borderRadius: '50%',
                    background: 'transparent',
                    border: '2px dashed rgba(143,175,154,0.45)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    animation: 'pp-ring-pulse 2s ease-in-out infinite',
                  }}>
                    <span style={{ fontSize: '1.4rem', opacity: 0.3 }}>?</span>
                  </div>
                )}
                <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', fontWeight: 500 }}>
                  {phase === 'connected' ? 'Peer' : 'Matching…'}
                </span>
              </div>
            </div>

            {/* Status text */}
            <p style={{
              fontSize: '0.88rem',
              color: phase === 'connected' ? 'var(--color-calm)' : 'var(--color-text-secondary)',
              textAlign: 'center', lineHeight: 1.5, fontWeight: phase === 'connected' ? 600 : 400,
            }}>
              {phase === 'submitting' && 'Getting things ready…'}
              {phase === 'waking' && 'Starting up, please wait…'}
              {phase === 'waiting' && 'Looking for the right peer…'}
              {phase === 'connected' && 'Peer found — joining your session…'}
              {phase === 'error' && errorMsg}
            </p>
          </div>

          {/* Retry — only on error */}
          {phase === 'error' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, width: '100%', maxWidth: 360 }}>
              <button className="btn btn--primary" onClick={handleRetry} style={{ width: '100%' }}>
                Try again
              </button>
            </div>
          )}

          {/* Cancel — always shown except on error */}
          {phase !== 'error' && (
            <button
              onClick={handleCancel}
              className="btn btn--muted"
              style={{ width: '100%', maxWidth: 360 }}
            >
              Cancel request
            </button>
          )}
          {phase === 'error' && (
            <button
              onClick={handleCancel}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '0.82rem', color: 'var(--color-text-muted)',
                padding: '4px 8px',
              }}
            >
              Go back
            </button>
          )}
        </div>
      </div>
    </>
  );
}
