import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams, useBlocker } from 'react-router-dom';
import { Heart, CheckCircle, Clock, ChatText, PaperPlaneTilt, Flag } from '@phosphor-icons/react';
import client from '../../api/client';
import { trackEvent } from '../../utils/analytics';
import { useAuth } from '../../context/AuthContext';
import { registerFCMToken } from '../../utils/firebase';

// ── Post-session reflection modal (peer only) ─────────────────────────────────
const REFLECTION_QUESTIONS = [
  { key: 'topic_stayed_in_category',   label: 'The conversation stayed within the area I expected.' },
  { key: 'unexpected_topic_arose',     label: 'An unexpected topic came up that I wasn\'t prepared for.' },
  { key: 'felt_prepared',              label: 'I felt prepared for this session.' },
  { key: 'additional_training_wanted', label: 'I\'d like additional training after this session.' },
];

function ReflectionModal({ sessionId, onDone }) {
  const [answers, setAnswers] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function toggle(key) {
    setAnswers(prev => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await client.post(`/api/peer/session/${sessionId}/reflection`, answers);
      setSubmitted(true);
      setTimeout(onDone, 1500);
    } catch { onDone(); }
    finally { setSubmitting(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 150, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: 'var(--color-surface-card)', borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0', padding: 'var(--space-lg)', width: '100%', maxHeight: '80vh', overflowY: 'auto' }}>
        {submitted ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-md) 0' }}>
            <Heart size={36} weight="fill" color="#C8943A" style={{ marginBottom: 8 }} />
            <p style={{ fontWeight: 600 }}>Thank you — your reflection helps us improve.</p>
          </div>
        ) : (
          <>
            <h3 style={{ marginBottom: 4 }}>Quick reflection</h3>
            <p style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)', marginBottom: 'var(--space-md)' }}>Optional — takes 30 seconds</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 'var(--space-md)' }}>
              {REFLECTION_QUESTIONS.map(q => (
                <label key={q.key} style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', fontSize: '0.88rem', lineHeight: 1.4 }}>
                  <input
                    type="checkbox"
                    checked={answers[q.key] === true}
                    onChange={() => toggle(q.key)}
                    style={{ width: 20, height: 20, accentColor: 'var(--color-calm)', flexShrink: 0 }}
                  />
                  {q.label}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn--primary" style={{ flex: 1 }} onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : 'Submit'}
              </button>
              <button className="btn btn--muted" style={{ flex: 1 }} onClick={onDone}>Skip</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RequesterFeedbackModal({ sessionId, onDone }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!rating) return onDone();
    setSubmitting(true);
    try { await client.post(`/api/peer/session/${sessionId}/requester-feedback`, { rating, comment: comment.trim() || undefined }); }
    catch { /* best-effort */ }
    finally { setSubmitting(false); onDone(); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 150, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: 'var(--color-surface-card)', borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0', padding: 'var(--space-lg)', width: '100%' }}>
        <h3 style={{ marginBottom: 4 }}>How was your peer?</h3>
        <p style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)', marginBottom: 'var(--space-md)' }}>Optional — helps us maintain quality</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 'var(--space-md)' }}>
          {[1,2,3,4,5].map(n => (
            <button key={n} type="button" onClick={() => setRating(n)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 32, opacity: n <= rating ? 1 : 0.3 }}>
              ★
            </button>
          ))}
        </div>
        <textarea className="textarea" rows={2} value={comment} onChange={e => setComment(e.target.value)}
          placeholder="Any comments? (optional)" style={{ marginBottom: 'var(--space-sm)' }} />
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn--primary" style={{ flex: 1 }} onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saving…' : rating ? 'Submit' : 'Skip'}
          </button>
          <button className="btn btn--muted" style={{ flex: 1 }} onClick={onDone}>Skip</button>
        </div>
      </div>
    </div>
  );
}

function ReportModal({ sessionId, onClose }) {
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (description.trim().length < 10) { setError('Please describe what happened (at least 10 characters).'); return; }
    setSubmitting(true);
    setError('');
    try {
      await client.post('/api/peer/report', { session_id: sessionId, channel: 'text', description: description.trim() });
      setSubmitted(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit report. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'flex-end', padding: 0 }}>
      <div style={{ background: 'var(--color-surface-card)', borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0', padding: 'var(--space-lg)', width: '100%', maxHeight: '80vh', overflowY: 'auto' }}>
        {submitted ? (
          <div style={{ textAlign: 'center', padding: 'var(--space-lg) 0' }}>
            <CheckCircle size={36} weight="fill" color="var(--color-calm)" style={{ marginBottom: 'var(--space-sm)' }} />
            <h3 style={{ marginBottom: 'var(--space-xs)' }}>Report submitted</h3>
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 'var(--space-lg)' }}>Our team will review it. Thank you for keeping this space safe.</p>
            <button className="btn btn--primary" onClick={onClose}>Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h3 style={{ marginBottom: 'var(--space-xs)' }}>Report this session</h3>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 'var(--space-md)' }}>
              Describe what happened. If it was a text session, you can attach a screenshot from your photo library when you submit.
            </p>
            <textarea
              className="textarea"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what the peer said or did that violated the community guidelines…"
              style={{ marginBottom: 'var(--space-sm)' }}
            />
            {error && <p style={{ fontSize: 13, color: 'var(--color-danger)', marginBottom: 'var(--space-sm)' }}>{error}</p>}
            <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
              <button type="submit" className="btn btn--danger" style={{ flex: 1, animation: 'none' }} disabled={submitting}>
                {submitting ? 'Submitting…' : 'Submit Report'}
              </button>
              <button type="button" className="btn btn--muted" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// Always use wss:// on HTTPS to prevent mixed-content browser block
const _apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const _rawWs  = import.meta.env.VITE_WS_URL  || _apiUrl.replace(/^http/, 'ws');
const WS_URL  = window.location.protocol === 'https:' ? _rawWs.replace(/^ws:\/\//, 'wss://') : _rawWs;
const SESSION_SECONDS = 30 * 60; // 30 minutes

function formatTime(seconds) {
  const m = Math.floor(Math.max(0, seconds) / 60);
  const s = Math.max(0, seconds) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function PeerTextChatScreen() {
  const { id: sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [peerLeft, setPeerLeft] = useState(false);
  const [error, setError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(SESSION_SECONDS);
  const [showExtendPrompt, setShowExtendPrompt] = useState(false);
  const [extending, setExtending] = useState(false);
  const [extendError, setExtendError] = useState('');
  const [sessionEnded, setSessionEnded] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showReflection, setShowReflection] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [peerLeftEnded, setPeerLeftEnded] = useState(false);
  const [peerJoined, setPeerJoined] = useState(false);
  const [peerAlias, setPeerAlias] = useState('Peer');
  const [topicLabel, setTopicLabel] = useState('');
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const isPeerRef = useRef(false);

  const [contactWarning, setContactWarning] = useState(false);

  const wsRef = useRef(null);
  const bottomRef = useRef(null);
  const requestIdRef = useRef(null);
  const hadContactRef = useRef(false); // true once any message is sent or received
  const endTimeRef = useRef(null);
  const timerRef = useRef(null);
  const promptShownRef = useRef(false); // track per-block so it only fires once
  const warnTimerRef = useRef(null);

  // Block accidental navigation (back swipe, browser back) while session is live.
  const blocker = useBlocker(peerJoined && !sessionEnded && !peerLeft && !peerLeftEnded);
  useEffect(() => {
    if (blocker.state === 'blocked') setShowEndConfirm(true);
  }, [blocker.state]);

  // Warn on browser tab close / refresh during active session.
  useEffect(() => {
    if (!peerJoined || sessionEnded || peerLeft) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [peerJoined, sessionEnded, peerLeft]);

  const handleEndSession = useCallback(async (reason = 'manual') => {
    clearInterval(timerRef.current);
    wsRef.current?.close();
    const reqId = requestIdRef.current;
    if (reqId && reason === 'manual') {
      const body = hadContactRef.current ? {} : { never_connected: true };
      try { await client.patch(`/api/peer/request/${reqId}/close`, body); } catch { /* best-effort */ }
    }
    trackEvent('peer_session_completed', { channel: 'text', reason });
    if (reason === 'time_limit') {
      setSessionEnded(true);
      if (isPeerRef.current) setShowReflection(true);
      else setShowFeedback(true);
    } else if (reason === 'peer_left' && !isPeerRef.current) {
      setPeerLeftEnded(true);
      setSessionEnded(true);
      setShowFeedback(true);
    } else if (isPeerRef.current) {
      setShowReflection(true);
    } else {
      navigate('/peer', { replace: true });
    }
  }, [navigate]);

  // Start countdown interval using endTime as source of truth
  function startTimer(endTime) {
    endTimeRef.current = endTime;
    promptShownRef.current = false;
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const secs = Math.round((endTimeRef.current - Date.now()) / 1000);
      setSecondsLeft(secs);
      if (secs <= 300 && !promptShownRef.current && !isPeerRef.current) {
        promptShownRef.current = true;
        setShowExtendPrompt(true);
      }
      if (secs <= 0) {
        clearInterval(timerRef.current);
        handleEndSession('time_limit');
      }
    }, 1000);
  }

  useEffect(() => {
    async function init() {
      try {
        const { data } = await client.get(`/api/peer/session/${sessionId}`);
        requestIdRef.current = data.session?.request_id ?? null;
        isPeerRef.current = data.session?.responder_id === user?.id;
        setPeerAlias(data.session?.peer_alias || 'Peer');
        setTopicLabel(data.session?.topic_label || '');
        // Timer starts on peer_joined, not session creation (44.5)

        const ws = new WebSocket(`${WS_URL}/ws/signal?session=${sessionId}`);
        wsRef.current = ws;

        function setupPing(socket) {
          const pingInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
            else clearInterval(pingInterval);
          }, 20000);
          socket._pingInterval = pingInterval;
        }

        ws.onopen = () => {
          setConnected(true);
          ws.send(JSON.stringify({ type: 'join', session_id: sessionId }));
          setupPing(ws);
        };

        function handleMessage(e) {
          const msg = JSON.parse(e.data);
          if (msg.type === 'peer_joined') {
            setPeerJoined(true);
            // Start timer from actual peer connection, not session creation
            startTimer(Date.now() + SESSION_SECONDS * 1000);
          } else if (msg.type === 'chat') {
            hadContactRef.current = true;
            setMessages((prev) => [...prev, { from: 'peer', text: msg.text, ts: msg.ts || Date.now() }]);
          } else if (msg.type === 'peer_left') {
            setPeerLeft(true);
            handleEndSession('peer_left');
          } else if (msg.type === 'contact_warning') {
            setContactWarning(true);
            clearTimeout(warnTimerRef.current);
            warnTimerRef.current = setTimeout(() => setContactWarning(false), 8000);
          }
        }

        ws.onmessage = handleMessage;
        ws.onclose = (ev) => {
          clearInterval(ws._pingInterval);
          setConnected(false);
          if (ev.code === 1000 || ev.code === 1005) return;
          setTimeout(() => {
            if (wsRef.current?.readyState !== WebSocket.OPEN) {
              const ws2 = new WebSocket(`${WS_URL}/ws/signal?session=${sessionId}`);
              wsRef.current = ws2;
              ws2.onopen = () => {
                setConnected(true);
                ws2.send(JSON.stringify({ type: 'join', session_id: sessionId }));
                setupPing(ws2);
              };
              ws2.onmessage = handleMessage;
              ws2.onclose = ws.onclose;
            }
          }, 2000);
        };
      } catch {
        setError('Could not connect to session.');
      }
    }
    init();
    return () => { clearInterval(timerRef.current); clearTimeout(warnTimerRef.current); wsRef.current?.close(); };
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleExtend() {
    setExtendError('');
    setExtending(true);
    try {
      const { data } = await client.post(`/api/peer/request/${requestIdRef.current}/extend`);
      const newEndTime = new Date(data.new_end_time).getTime();
      setShowExtendPrompt(false);
      startTimer(newEndTime);
    } catch (err) {
      setExtendError(err.response?.data?.error || 'Could not extend session.');
    } finally {
      setExtending(false);
    }
  }

  function handleSend() {
    if (!input.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const text = input.trim();
    hadContactRef.current = true;
    wsRef.current.send(JSON.stringify({ type: 'chat', text, session_id: sessionId }));
    setMessages((prev) => [...prev, { from: 'me', text, ts: Date.now() }]);
    setInput('');
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  // Session ended — show safety resources
  if (sessionEnded) {
    return (
      <>
        <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: 32, textAlign: 'center', gap: 16 }}>
          <Clock size={40} weight="duotone" color="var(--color-text-muted)" />
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>{peerLeftEnded ? 'Your peer left the chat' : 'Session time ended'}</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--color-text-muted)', maxWidth: 280, lineHeight: 1.6 }}>
            {peerLeftEnded ? 'The peer ended the session. If you still need support, the resources below are available.' : 'Your 30-minute session has ended. You can start a new session any time.'}
          </p>
          <div style={{ padding: '14px 16px', background: 'var(--color-calm-bg)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-calm)', width: '100%', maxWidth: 320 }}>
            <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-calm)', marginBottom: 4 }}>Need immediate support?</p>
            <p style={{ fontSize: '0.85rem' }}>Befrienders Kenya</p>
            <a href="tel:0800723253" style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--color-accent)', textDecoration: 'none' }}>0800 723 253</a>
            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 4 }}>Free · 24/7</p>
          </div>
          {typeof Notification !== 'undefined' && Notification.permission === 'default' && (
            <div style={{ width: '100%', maxWidth: 320, padding: '14px 16px', background: 'var(--color-bg-surface)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', textAlign: 'left' }}>
              <p style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 4 }}>Get notified when a peer is available or your companion has something for you.</p>
              <button className="btn btn--primary" style={{ width: '100%', marginTop: 8 }} onClick={() => registerFCMToken()}>
                Enable notifications
              </button>
            </div>
          )}
          <button className="btn btn--primary" style={{ maxWidth: 320, width: '100%' }} onClick={() => navigate('/peer', { replace: true })}>
            Back to Peer Support
          </button>
          <button className="btn btn--secondary" style={{ maxWidth: 320, width: '100%' }} onClick={() => navigate('/emergency')}>
            Emergency SOS
          </button>
          <button
            className="btn btn--muted"
            style={{ maxWidth: 320, width: '100%', fontSize: 13 }}
            onClick={() => setShowReport(true)}
          >
            Report this session
          </button>
        </div>
        {showReport && <ReportModal sessionId={sessionId} onClose={() => setShowReport(false)} />}
        {showReflection && (
          <ReflectionModal
            sessionId={sessionId}
            onDone={() => {
              setShowReflection(false);
              navigate('/peer', { replace: true });
            }}
          />
        )}
        {showFeedback && (
          <RequesterFeedbackModal
            sessionId={sessionId}
            onDone={() => {
              setShowFeedback(false);
              navigate('/peer', { replace: true });
            }}
          />
        )}
      </>
    );
  }

  if (error) {
    return (
      <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
        <p style={{ marginBottom: 16 }}>{error}</p>
        <button className="btn btn--primary" onClick={() => navigate('/peer', { replace: true })}>Back</button>
      </div>
    );
  }

  const isLow = secondsLeft <= 300;

  return (
    <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--color-bg-primary)', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: 6 }}>
            <ChatText size={18} weight="duotone" /> {peerAlias}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>
            {peerLeft ? 'Peer has left' : !peerJoined ? 'Waiting for peer…' : connected ? topicLabel || 'Peer support session' : 'Reconnecting…'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setShowReport(true)}
            style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}
            aria-label="Report peer"
          >
            <Flag size={18} weight="duotone" />
          </button>
          <span style={{
            fontSize: '0.85rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
            color: isLow ? 'var(--color-danger)' : 'var(--color-text-muted)',
            transition: 'color 300ms',
          }}>
            {formatTime(secondsLeft)}
          </span>
          <button onClick={() => setShowEndConfirm(true)} style={{ background: 'var(--color-danger)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', padding: '6px 12px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
            End
          </button>
        </div>
      </div>

      {/* Extension prompt */}
      {showExtendPrompt && (
        <div style={{ padding: '12px 16px', background: isLow ? 'var(--color-danger-bg)' : 'var(--color-warning-bg)', borderBottom: `1px solid ${isLow ? 'var(--color-danger)' : 'var(--color-warning)'}`, flexShrink: 0 }}>
          <p style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 8, color: isLow ? 'var(--color-danger)' : 'var(--color-warning)' }}>
            Session ending in {Math.ceil(secondsLeft / 60)} min — extend for 1 credit?
          </p>
          {extendError && <p style={{ fontSize: '0.78rem', color: 'var(--color-danger)', marginBottom: 6 }}>{extendError}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleExtend}
              disabled={extending}
              className="btn btn--success btn--sm"
              style={{ flex: 1 }}
            >
              {extending ? '…' : 'Extend (+30 min)'}
            </button>
            <button
              onClick={() => setShowExtendPrompt(false)}
              className="btn btn--secondary btn--sm"
              style={{ flex: 1 }}
            >
              No thanks
            </button>
          </div>
        </div>
      )}

      {peerLeft && (
        <div className="info-banner info-banner--warning" style={{ borderRadius: 0, borderLeft: 'none', borderRight: 'none', textAlign: 'center', fontSize: '0.85rem' }}>
          Your peer has left the session.
        </div>
      )}

      {contactWarning && (
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '10px 14px', background: 'var(--color-warning-bg, #3a2a10)', borderBottom: '1px solid var(--color-warning, #C8943A)', flexShrink: 0 }}>
          <p style={{ fontSize: '0.8rem', color: 'var(--color-warning, #C8943A)', lineHeight: 1.5, margin: 0 }}>
            For your safety, please avoid sharing personal contact details — phone numbers, email addresses, or locations are against community guidelines.
          </p>
          <button onClick={() => setContactWarning(false)} style={{ background: 'none', border: 'none', color: 'var(--color-warning, #C8943A)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, flexShrink: 0, padding: 0 }} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--color-bg-primary)' }}>
        {messages.length === 0 && !peerLeft && (
          <div style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: 24, fontSize: '0.9rem' }}>
            {peerJoined
              ? 'You are connected. Neither party can see the other\'s identity.'
              : 'Waiting for your peer to join…'}
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`bubble ${msg.from === 'me' ? 'bubble--user' : 'bubble--peer'}`}>
            {msg.text}
            <div style={{ fontSize: '0.65rem', opacity: 0.7, marginTop: 4, textAlign: msg.from === 'me' ? 'right' : 'left' }}>
              {msg.from === 'me' ? 'You' : peerAlias} · {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '12px 16px', background: 'var(--color-bg-deep)', borderTop: '1px solid rgba(245,237,228,0.10)', display: 'flex', gap: 8, flexShrink: 0 }}>
        <textarea
          className="textarea"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message…"
          disabled={peerLeft || !connected || !peerJoined}
          style={{ resize: 'none', flex: 1 }}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || !connected || peerLeft || !peerJoined}
          className="btn btn--primary"
          style={{ width: 'auto', padding: '0 16px', flexShrink: 0 }}
          aria-label="Send"
        >
          <PaperPlaneTilt size={20} weight="fill" />
        </button>
      </div>

      {showEndConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 120, display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ background: 'var(--color-surface-card)', borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0', padding: 'var(--space-lg)', width: '100%' }}>
            <h3 style={{ marginBottom: 8 }}>End session?</h3>
            <p style={{ fontSize: '0.88rem', color: 'var(--color-text-muted)', marginBottom: 'var(--space-md)' }}>Your peer will be notified that you left.</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn--danger" style={{ flex: 1 }} onClick={() => { setShowEndConfirm(false); if (blocker.state === 'blocked') blocker.reset(); handleEndSession('manual'); }}>End session</button>
              <button className="btn btn--muted" style={{ flex: 1 }} onClick={() => { setShowEndConfirm(false); if (blocker.state === 'blocked') blocker.reset(); }}>Stay</button>
            </div>
          </div>
        </div>
      )}

      {showReport && <ReportModal sessionId={sessionId} onClose={() => setShowReport(false)} />}
      {showReflection && (
        <ReflectionModal
          sessionId={sessionId}
          onDone={() => {
            setShowReflection(false);
            if (!sessionEnded) navigate('/peer', { replace: true });
          }}
        />
      )}
    </div>
  );
}
