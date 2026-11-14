import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Heart, CheckCircle, Clock, Microphone, MicrophoneSlash, PhoneDisconnect, Flag } from '@phosphor-icons/react';
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

const REPORT_REASONS = [
  'Harassment',
  'Inappropriate language',
  'Made me uncomfortable',
  'Shared personal contact details',
  'Other',
];

function ReportAndEndModal({ sessionId, channel, transcript, onConfirm, onClose }) {
  const [step,       setStep]       = useState(1);
  const [reason,     setReason]     = useState('');
  const [other,      setOther]      = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState('');

  async function handleSubmit() {
    if (!reason) { setError('Please select a reason.'); return; }
    if (reason === 'Other' && other.trim().length < 3) { setError('Please describe what happened.'); return; }
    setSubmitting(true);
    setError('');
    try {
      await client.post('/api/peer/report', {
        session_id: sessionId,
        channel,
        description: reason === 'Other' ? other.trim() : reason,
        transcript: transcript?.length > 0 ? JSON.stringify(transcript) : undefined,
      });
      onConfirm();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit report. Please try again.');
      setSubmitting(false);
    }
  }

  if (step === 1) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 120, display: 'flex', alignItems: 'flex-end' }}>
        <div style={{ background: 'var(--color-surface-card)', borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0', padding: 'var(--space-lg)', width: '100%' }}>
          <h3 style={{ marginBottom: 8 }}>Are you sure you want to report this call?</h3>
          <p style={{ fontSize: '0.88rem', color: 'var(--color-text-muted)', marginBottom: 'var(--space-md)', lineHeight: 1.5 }}>
            This will end the call immediately. A transcript of this session will be collected as evidence.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn--danger" style={{ flex: 1 }} onClick={() => setStep(2)}>Yes, report this call</button>
            <button className="btn btn--muted" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 120, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: 'var(--color-surface-card)', borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0', padding: 'var(--space-lg)', width: '100%', maxHeight: '80vh', overflowY: 'auto' }}>
        <h3 style={{ marginBottom: 4 }}>What happened?</h3>
        <p style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)', marginBottom: 'var(--space-md)' }}>
          Select a reason. The call will end immediately after you submit.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 'var(--space-md)' }}>
          {REPORT_REASONS.map((r) => (
            <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', fontSize: '0.9rem' }}>
              <input type="radio" name="report-reason" value={r} checked={reason === r} onChange={() => setReason(r)}
                style={{ width: 18, height: 18, accentColor: 'var(--color-danger)', flexShrink: 0 }} />
              {r}
            </label>
          ))}
        </div>
        {reason === 'Other' && (
          <textarea
            className="textarea"
            rows={3}
            value={other}
            onChange={(e) => setOther(e.target.value.slice(0, 200))}
            placeholder="Describe what happened (max 200 characters)…"
            style={{ marginBottom: 'var(--space-sm)' }}
          />
        )}
        {error && <p style={{ fontSize: 13, color: 'var(--color-danger)', marginBottom: 'var(--space-sm)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn--danger" style={{ flex: 1 }} onClick={handleSubmit} disabled={submitting || !reason}>
            {submitting ? 'Submitting…' : 'Report and end'}
          </button>
          <button className="btn btn--muted" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
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
      await client.post('/api/peer/report', { session_id: sessionId, channel: 'voice', description: description.trim() });
      setSubmitted(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit report. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'flex-end' }}>
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
            <h3 style={{ marginBottom: 'var(--space-xs)' }}>Report this call</h3>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 'var(--space-md)' }}>
              Describe what happened during the call. Include as much detail as you remember.
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

const _apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const WS_URL  = _apiUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');
const SESSION_SECONDS = 30 * 60;

function formatTime(seconds) {
  const m = Math.floor(Math.max(0, seconds) / 60);
  const s = Math.max(0, seconds) % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function PeerVoiceCallScreen() {
  const { id: sessionId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [callState, setCallState] = useState('connecting');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(SESSION_SECONDS);
  const [showExtendPrompt, setShowExtendPrompt] = useState(false);
  const [extending, setExtending] = useState(false);
  const [extendError, setExtendError] = useState('');
  const [sessionEnded, setSessionEnded] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showReportAndEnd, setShowReportAndEnd] = useState(false);
  const [showReflection, setShowReflection] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [peerLeftMsg, setPeerLeftMsg] = useState(false);
  const [peerAlias, setPeerAlias] = useState('');
  const [topicLabel, setTopicLabel] = useState('');
  const [showEndConfirm, setShowEndConfirm] = useState(false);

  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const isInitiator = useRef(false);
  const requestIdRef = useRef(null);
  const isPeerRef = useRef(false);
  const endTimeRef = useRef(null);
  const timerRef = useRef(null);
  const promptShownRef = useRef(false);
  const callWasActiveRef = useRef(false);
  const connectTimeoutRef = useRef(null);
  const transcriptRef = useRef([]);
  const srRef = useRef(null);


  // Warn on tab close / refresh during active call.
  useEffect(() => {
    if (callState !== 'active' || sessionEnded) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [callState, sessionEnded]);

  const endCall = useCallback(async (reason = 'manual') => {
    clearInterval(timerRef.current);
    srRef.current?.stop();
    // Give speech recogniser 100ms to flush any pending final results, then POST
    setTimeout(() => {
      if (transcriptRef.current.length > 0) {
        client.post(`/api/peer/session/${sessionId}/transcript`, {
          entries: transcriptRef.current,
        }).catch(() => {});
      }
    }, 100);
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    pcRef.current?.close();
    wsRef.current?.close();
    const reqId = requestIdRef.current;
    if (reqId && reason === 'manual') {
      const body = callWasActiveRef.current ? {} : { never_connected: true };
      try { await client.patch(`/api/peer/request/${reqId}/close`, body); } catch { /* best-effort */ }
    }
    trackEvent('peer_session_completed', { channel: 'voice', reason });
    if (reason === 'time_limit') {
      setSessionEnded(true);
      if (isPeerRef.current) setShowReflection(true);
      else setShowFeedback(true);
    } else if (reason === 'peer_left' && !isPeerRef.current) {
      setPeerLeftMsg(true);
      setSessionEnded(true);
      setShowFeedback(true);
    } else if (isPeerRef.current) {
      setShowReflection(true);
    } else {
      navigate('/peer', { replace: true });
    }
  }, [navigate]);

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
        endCall('time_limit');
      }
    }, 1000);
  }

  useEffect(() => {
    let pc;
    async function init() {
      try {
        const { data } = await client.get(`/api/peer/session/${sessionId}`);
        requestIdRef.current = data.session?.request_id ?? null;
        isPeerRef.current = data.session?.responder_id === user?.id;
        setPeerAlias(data.session?.peer_alias || 'Peer');
        setTopicLabel(data.session?.topic_label || '');
        // Timer starts only when WebRTC actually connects (pc.ontrack), not at session creation

        const iceServers = data.ice_servers || [{ urls: 'stun:stun.l.google.com:19302' }];
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;

        pc = new RTCPeerConnection({ iceServers });
        pcRef.current = pc;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        pc.ontrack = (e) => {
          if (remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = e.streams[0];
            remoteAudioRef.current.play().catch(() => {});
          }
          clearTimeout(connectTimeoutRef.current);
          callWasActiveRef.current = true;
          setCallState('active');
          // Timer starts from actual audio connection, not session creation timestamp
          startTimer(Date.now() + SESSION_SECONDS * 1000);
          // Best-effort transcript via Web Speech API (evidence for reports)
          const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
          if (SR) {
            const sr = new SR();
            sr.continuous = true;
            sr.interimResults = false;
            sr.lang = 'sw-KE';
            sr.onresult = (ev) => {
              for (let i = ev.resultIndex; i < ev.results.length; i++) {
                const text = ev.results[i][0].transcript.trim();
                if (text) transcriptRef.current.push({ ts: Date.now(), text });
              }
            };
            sr.onerror = () => {};
            sr.start();
            srRef.current = sr;
          }
        };

        const ws = new WebSocket(`${WS_URL}/ws/signal?session=${sessionId}`);
        wsRef.current = ws;

        // ICE candidates that arrive before remote description is set are queued here
        const iceCandidateQueue = [];
        let remoteDescSet = false;

        async function flushIceCandidates() {
          while (iceCandidateQueue.length) {
            const c = iceCandidateQueue.shift();
            await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
        }

        // Fail-safe: if WebRTC never connects within 35 s, refund and show error
        connectTimeoutRef.current = setTimeout(async () => {
          const state = pcRef.current?.connectionState;
          if (state !== 'connected' && state !== 'completed') {
            setError('Could not establish a connection — your credits have been refunded. Try again or switch to a different network.');
            localStreamRef.current?.getTracks().forEach((t) => t.stop());
            pcRef.current?.close();
            wsRef.current?.close();
            if (requestIdRef.current) {
              await client.patch(`/api/peer/request/${requestIdRef.current}/close`, { never_connected: true }).catch(() => {});
            }
          }
        }, 35000);

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'join', session_id: sessionId }));
          // Keepalive ping every 20s to prevent Render free tier from dropping idle WS connections
          const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
            else clearInterval(pingInterval);
          }, 20000);
          ws._pingInterval = pingInterval;
        };

        ws.onerror = () => {
          clearTimeout(connectTimeoutRef.current);
          setError('Signaling connection failed — please check your network and try again.');
        };

        ws.onclose = (ev) => {
          clearInterval(ws._pingInterval);
          if (callWasActiveRef.current) return; // normal close after active call
          if (ev.code !== 1000 && ev.code !== 1005) {
            clearTimeout(connectTimeoutRef.current);
            setError(`Connection lost before the call started (code ${ev.code}) — your credits have been refunded.`);
            if (requestIdRef.current) {
              client.patch(`/api/peer/request/${requestIdRef.current}/close`, { never_connected: true }).catch(() => {});
            }
          }
        };

        ws.onmessage = async (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'peer_joined') {
            if (!msg.isCallee) {
              // We are the initiator — create the WebRTC offer.
              isInitiator.current = true;
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              ws.send(JSON.stringify({ type: 'offer', sdp: offer, session_id: sessionId }));
            }
          } else if (msg.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            remoteDescSet = true;
            await flushIceCandidates();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({ type: 'answer', sdp: answer, session_id: sessionId }));
          } else if (msg.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            remoteDescSet = true;
            await flushIceCandidates();
          } else if (msg.type === 'ice') {
            if (remoteDescSet) {
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
            } else {
              iceCandidateQueue.push(msg.candidate);
            }
          } else if (msg.type === 'peer_left') {
            setCallState('ended');
            endCall('peer_left');
          }
        };

        pc.onicecandidate = (e) => {
          if (e.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ice', candidate: e.candidate, session_id: sessionId }));
          }
        };

        pc.onconnectionstatechange = () => {
          const state = pcRef.current?.connectionState;
          if (state === 'failed') {
            clearTimeout(connectTimeoutRef.current);
            setError('Could not connect — likely a network issue. Your credits have been refunded.');
            localStreamRef.current?.getTracks().forEach((t) => t.stop());
            wsRef.current?.close();
            if (requestIdRef.current) {
              client.patch(`/api/peer/request/${requestIdRef.current}/close`, { never_connected: true }).catch(() => {});
            }
          }
        };

        pc.oniceconnectionstatechange = () => {
          const state = pcRef.current?.iceConnectionState;
          if (state === 'failed') {
            clearTimeout(connectTimeoutRef.current);
            pcRef.current?.restartIce?.();
          }
        };
      } catch (err) {
        if (err.name === 'NotAllowedError') {
          setError('Microphone permission is required for voice calls.');
        } else {
          setError('Could not establish voice call. Please try again.');
        }
      }
    }

    init();
    return () => {
      clearTimeout(connectTimeoutRef.current);
      clearInterval(timerRef.current);
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      pc?.close();
      wsRef.current?.close();
      srRef.current?.stop();
    };
  }, [sessionId]);

  async function handleExtend() {
    setExtendError('');
    setExtending(true);
    try {
      const { data } = await client.post(`/api/peer/request/${requestIdRef.current}/extend`);
      setShowExtendPrompt(false);
      startTimer(new Date(data.new_end_time).getTime());
    } catch (err) {
      setExtendError(err.response?.data?.error || 'Could not extend session.');
    } finally {
      setExtending(false);
    }
  }

  function toggleMute() {
    if (!localStreamRef.current) return;
    localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = muted; });
    setMuted((m) => !m);
  }

  if (sessionEnded) {
    return (
      <>
        <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: 32, textAlign: 'center', gap: 16 }}>
          <Clock size={40} weight="duotone" color="var(--color-text-muted)" />
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>{peerLeftMsg ? 'Your peer left the call' : 'Call time ended'}</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--color-text-muted)', maxWidth: 280, lineHeight: 1.6 }}>
            {peerLeftMsg ? 'The peer ended the session. If you still need support, the resources below are available.' : 'Your 30-minute voice call has ended. You can start a new session any time.'}
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
    <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', background: 'var(--color-bg-deep)', minHeight: '100dvh', padding: 'var(--space-xl)' }}>
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* Timer */}
      <div style={{
        position: 'absolute', top: 20, right: 20,
        fontSize: '1.1rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        color: isLow ? 'var(--color-danger)' : 'rgba(245,237,228,0.70)',
        transition: 'color 300ms',
      }}>
        {formatTime(secondsLeft)}
      </div>

      {/* Extension prompt */}
      {showExtendPrompt && (
        <div style={{
          position: 'absolute', top: 60, left: 16, right: 16,
          padding: '14px 16px',
          background: isLow ? 'rgba(179,92,92,0.15)' : 'rgba(217,164,65,0.15)',
          border: `1px solid ${isLow ? 'var(--color-danger)' : 'var(--color-warning)'}`,
          borderRadius: 'var(--radius-md)',
        }}>
          <p style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 8, color: isLow ? 'var(--color-danger)' : 'var(--color-warning)' }}>
            Call ending in {Math.ceil(secondsLeft / 60)} min — extend for 2 credits?
          </p>
          {extendError && <p style={{ fontSize: '0.78rem', color: 'var(--color-danger)', marginBottom: 6 }}>{extendError}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleExtend} disabled={extending} className="btn btn--success btn--sm" style={{ flex: 1 }}>
              {extending ? '…' : 'Extend (+30 min)'}
            </button>
            <button onClick={() => setShowExtendPrompt(false)} className="btn btn--secondary btn--sm" style={{ flex: 1 }}>
              No thanks
            </button>
          </div>
        </div>
      )}

      <div style={{ textAlign: 'center', marginBottom: 'var(--space-2xl)' }}>
        <Microphone size={64} weight="duotone" color="var(--color-accent)" style={{ marginBottom: 'var(--space-md)' }} />
        <h2 style={{ marginBottom: 4 }}>
          {callState === 'connecting' ? 'Connecting…' : callState === 'active' ? (peerAlias || 'Voice Call') : 'Call Ended'}
        </h2>
        <p style={{ fontSize: '0.85rem', color: 'rgba(245,237,228,0.55)', marginBottom: 0 }}>
          {callState === 'active'
            ? (topicLabel || 'Peer support session')
            : callState === 'connecting' ? 'Establishing connection…' : 'Your peer has left the call'}
        </p>
        {callState === 'active' && (
          <p style={{ fontSize: '0.72rem', color: 'rgba(245,237,228,0.30)', marginTop: 6, marginBottom: 0 }}>
            If you report this session, a transcript may be sent to our safety team.
          </p>
        )}
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-lg)', alignItems: 'center' }}>
        <button
          onClick={toggleMute}
          style={{
            width: 64, height: 64, borderRadius: '50%',
            background: muted ? 'rgba(194,164,138,0.10)' : 'rgba(194,164,138,0.20)',
            border: '2px solid var(--color-border-focus)',
            color: 'var(--color-text-primary)', fontSize: 28, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <MicrophoneSlash size={28} weight="duotone" /> : <Microphone size={28} weight="duotone" />}
        </button>
        <button
          onClick={() => setShowEndConfirm(true)}
          style={{
            width: 72, height: 72, borderRadius: '50%',
            background: 'var(--color-danger)', border: 'none',
            color: 'var(--color-text-primary)', fontSize: 28, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 20px rgba(179,92,92,0.45)',
          }}
          aria-label="End call"
        >
          <PhoneDisconnect size={28} weight="fill" />
        </button>
      </div>
      {callState === 'active' && (
        <button
          onClick={() => setShowReportAndEnd(true)}
          style={{
            marginTop: 28,
            background: 'none', border: 'none',
            color: 'rgba(245,237,228,0.35)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: '0.78rem',
          }}
          aria-label="Report and end call"
        >
          <Flag size={13} weight="duotone" />
          Report peer
        </button>
      )}

      {/* End call confirmation */}
      {showEndConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 120, display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ background: 'var(--color-surface-card)', borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0', padding: 'var(--space-lg)', width: '100%' }}>
            <h3 style={{ marginBottom: 8 }}>End call?</h3>
            <p style={{ fontSize: '0.88rem', color: 'var(--color-text-muted)', marginBottom: 'var(--space-md)' }}>Your peer will be notified that you left.</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn--danger" style={{ flex: 1 }} onClick={() => { setShowEndConfirm(false); endCall('manual'); }}>End call</button>
              <button className="btn btn--muted" style={{ flex: 1 }} onClick={() => setShowEndConfirm(false)}>Stay</button>
            </div>
          </div>
        </div>
      )}

      {callState === 'ended' && (
        <button className="btn btn--ghost" style={{ marginTop: 'var(--space-xl)', width: 'auto', padding: '10px 24px' }} onClick={() => navigate('/peer', { replace: true })}>
          Back
        </button>
      )}

      {showReport && <ReportModal sessionId={sessionId} onClose={() => setShowReport(false)} />}
      {showReportAndEnd && (
        <ReportAndEndModal
          sessionId={sessionId}
          channel="voice"
          transcript={transcriptRef.current.length > 0 ? transcriptRef.current : null}
          onConfirm={() => { setShowReportAndEnd(false); endCall('manual'); }}
          onClose={() => setShowReportAndEnd(false)}
        />
      )}
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
