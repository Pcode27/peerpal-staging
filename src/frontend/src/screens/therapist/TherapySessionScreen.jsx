import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Microphone, MicrophoneSlash, VideoCamera, VideoCameraSlash, PhoneDisconnect, PaperPlaneTilt, Star } from '@phosphor-icons/react';
import client from '../../api/client';
import { useAuth } from '../../context/AuthContext';

const _apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const WS_URL  = _apiUrl.replace(/^https/, 'wss').replace(/^http/, 'ws');

// Off-platform contact filter — same patterns as peer signaling screen
const CONTACT_PATTERNS = [
  /\b(\+?254|0)[17]\d{8}\b/,                      // Kenyan phone numbers
  /\b07\d{8}\b/,                                   // 07xx format
  /[a-zA-Z0-9._%+@-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,  // email
  /\bwhatsapp\b/i,
  /\bt\.me\b|\btelegram\b/i,
  /\binstagram\.com\b|\b@[\w.]+\b/,               // Instagram handles
  /\bfacebook\.com\b|\bfb\.com\b/i,
  /\btwitter\.com\b|\bx\.com\b/i,
  /\bsnapchat\b/i,
  /\btiktok\b/i,
];

function containsContactInfo(text) {
  return CONTACT_PATTERNS.some(p => p.test(text));
}

function RatingPrompt({ booking, onDone }) {
  const [stars, setStars] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (stars === 0) return;
    setSubmitting(true);
    try {
      await client.post('/api/therapy/ratings', { booking_id: booking.id, rating: stars, comment: comment.trim() || null });
    } catch { /* best-effort */ }
    onDone();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'var(--color-bg-primary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-lg)' }}>
      <Star size={48} weight="duotone" color="#F5A623" style={{ marginBottom: 16 }} />
      <h2 style={{ fontFamily: 'var(--font-editorial)', marginBottom: 8, textAlign: 'center' }}>How was your session?</h2>
      <p style={{ fontSize: '0.86rem', color: 'var(--color-text-muted)', marginBottom: 24, textAlign: 'center' }}>
        Rate your experience with your therapist
      </p>

      <div style={{ display: 'flex', gap: 14, marginBottom: 24 }}>
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} onMouseEnter={() => setHovered(n)} onMouseLeave={() => setHovered(0)} onClick={() => setStars(n)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }} aria-label={`${n} star${n !== 1 ? 's' : ''}`}>
            <Star size={40} weight={n <= (hovered || stars) ? 'fill' : 'regular'} color={n <= (hovered || stars) ? '#F5A623' : 'var(--color-border)'} />
          </button>
        ))}
      </div>

      <textarea
        value={comment}
        onChange={e => setComment(e.target.value.slice(0, 300))}
        placeholder="Share your experience (optional)"
        rows={3}
        style={{ width: '100%', maxWidth: 340, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', padding: '10px 12px', fontSize: '0.88rem', resize: 'none', fontFamily: 'inherit', background: 'var(--color-surface)', color: 'var(--color-text-primary)', marginBottom: 20, boxSizing: 'border-box' }}
      />

      <div style={{ display: 'flex', gap: 10, width: '100%', maxWidth: 340 }}>
        <button className="btn btn--muted" style={{ flex: 1 }} onClick={onDone}>Skip</button>
        <button className="btn btn--primary" style={{ flex: 1 }} onClick={submit} disabled={stars === 0 || submitting}>
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

// ── Video / Voice session (WebRTC) ────────────────────────────────────────────
function MediaSession({ booking, joinData, onEnd }) {
  useAuth();
  const localVideoRef  = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const pcRef          = useRef(null);
  const wsRef          = useRef(null);
  const localStreamRef = useRef(null);
  const iceCandidateQueue = useRef([]);
  const remoteDescSet  = useRef(false);

  const isVideo = booking.session_format === 'video';
  const [muted, setMuted] = useState(false);
  const [videoOff, setVideoOff] = useState(false);
  const [connState, setConnState] = useState('connecting');
  const [connError, setConnError] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(booking.duration_minutes * 60);
  const [showWarnBanner, setShowWarnBanner] = useState(false);
  const [sentReply, setSentReply] = useState(false);
  const timerRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  const QUICK_REPLIES = ['Joining in a moment', 'Give me 2 minutes', 'Be right there'];

  function sendQuickReply(text) {
    if (sentReply || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'quick_reply', text }));
    setSentReply(true);
  }

  const endSession = useCallback(() => {
    clearInterval(timerRef.current);
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    pcRef.current?.close();
    wsRef.current?.close();
    onEnd();
  }, [onEnd]);

  useEffect(() => {
    let pc;

    async function init() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error('Media devices unavailable'), { name: 'NotSupportedError' });
      }
      const iceServers = joinData.turn_credentials?.ice_servers?.length
        ? joinData.turn_credentials.ice_servers
        : [{ urls: 'stun:stun.l.google.com:19302' }];

      const mediaConstraints = isVideo ? { audio: true, video: { facingMode: 'user' } } : { audio: true };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
      } catch (permErr) {
        console.error('[TherapySession] getUserMedia failed:', permErr.name, permErr.message);
        throw permErr;
      }
      localStreamRef.current = stream;

      if (isVideo && localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        localVideoRef.current.play().catch(() => {});
      }

      pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      pc.ontrack = e => {
        if (isVideo && remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = e.streams[0];
          remoteVideoRef.current.play().catch(() => {});
        } else if (!isVideo && remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = e.streams[0];
          remoteAudioRef.current.play().catch(() => {});
        }
        setConnState('active');
        clearTimeout(reconnectTimerRef.current);
        // Start countdown
        const duration = booking.duration_minutes * 60;
        let left = duration;
        timerRef.current = setInterval(() => {
          left--;
          setSecondsLeft(left);
          if (left === 300) {
            setShowWarnBanner(true);
            setTimeout(() => setShowWarnBanner(false), 8000);
            try {
              const ctx = new (window.AudioContext || window.webkitAudioContext)();
              const beep = (t, f, d) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = f; g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + d); o.start(t); o.stop(t + d); };
              beep(ctx.currentTime, 660, 0.2); beep(ctx.currentTime + 0.28, 880, 0.2);
            } catch (_e) { /* audio context unavailable */ }
          }
          if (left <= 0) { clearInterval(timerRef.current); endSession(); }
        }, 1000);
      };

      async function flushIce() {
        while (iceCandidateQueue.current.length) {
          await pc.addIceCandidate(new RTCIceCandidate(iceCandidateQueue.current.shift())).catch(() => {});
        }
        remoteDescSet.current = true;
      }

      pc.onicecandidate = e => {
        if (e.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
        }
      };

      // therapy namespace: session_type=therapy
      const ws = new WebSocket(`${WS_URL}/ws/signal?session=${booking.id}&token=${joinData.room_token}&session_type=therapy`);
      wsRef.current = ws;

      ws.onmessage = async e => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          await flushIce();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
        } else if (msg.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          await flushIce();
        } else if (msg.type === 'ice') {
          if (remoteDescSet.current) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
          } else {
            iceCandidateQueue.current.push(msg.candidate);
          }
        } else if (msg.type === 'peer_joined') {
          clearTimeout(reconnectTimerRef.current);
          if (connState === 'reconnecting') setConnState('connecting');
        } else if (msg.type === 'session_ended') {
          endSession();
        } else if (msg.type === 'peer_left') {
          if (connState === 'active') {
            setConnState('reconnecting');
            reconnectTimerRef.current = setTimeout(() => endSession(), 15000);
          } else {
            endSession();
          }
        } else if (msg.type === 'quick_reply') {
          // no-op on member side
        }
      };

      ws.onopen = () => {
        // Member is non-owner - therapist initiates the WebRTC offer
        ws.send(JSON.stringify({ type: 'join', session_id: `therapy:${booking.id}`, role: 'member' }));
      };
    }

    init().catch(err => {
      console.error('[TherapySession] init error', err);
      const msg = err.name === 'NotAllowedError' ? 'Camera/microphone access denied. Allow permissions and rejoin.'
        : err.name === 'NotFoundError' ? 'No camera or microphone found. Check your device and rejoin.'
        : 'Connection failed. In Brave: brave://settings/privacy → set WebRTC to Default. Other: allow camera/mic.';
      setConnError(msg);
      setConnState('error');
    });

    return () => {
      clearInterval(timerRef.current);
      clearTimeout(reconnectTimerRef.current);
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      pcRef.current?.close();
      wsRef.current?.close();
    };
  }, []);

  function toggleMute() {
    if (!localStreamRef.current) return;
    localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
    setMuted(m => !m);
  }

  function toggleVideo() {
    if (!localStreamRef.current) return;
    localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    setVideoOff(v => !v);
  }

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const timerStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const timerRed = secondsLeft < 300;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#111' }}>
      {isVideo ? (
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {/* Remote video fills screen */}
          <video ref={remoteVideoRef} style={{ width: '100%', height: '100%', objectFit: 'cover' }} playsInline autoPlay />

          {/* Connecting / reconnecting overlay */}
          {connState !== 'active' && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.7)', flexDirection: 'column', gap: 16, padding: '0 24px' }}>
              <div style={{ width: 48, height: 48, borderRadius: '50%', border: '3px solid #fff', borderTopColor: 'var(--color-calm)', animation: 'spin 1s linear infinite' }} />
              <p style={{ color: '#fff', fontSize: '0.88rem', textAlign: 'center' }}>
                {connState === 'error' ? (connError || 'Connection failed.')
                  : connState === 'reconnecting' ? 'Reconnecting…'
                  : 'Connecting to your therapist…'}
              </p>
              {connState === 'connecting' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 280 }}>
                  {QUICK_REPLIES.map(text => (
                    <button
                      key={text}
                      onClick={() => sendQuickReply(text)}
                      disabled={sentReply}
                      style={{ padding: '10px 16px', borderRadius: 20, border: '1px solid rgba(255,255,255,0.35)', background: sentReply ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.12)', color: sentReply ? 'rgba(255,255,255,0.35)' : '#fff', fontSize: '0.82rem', cursor: sentReply ? 'default' : 'pointer', transition: 'background 0.15s' }}
                    >
                      {text}
                    </button>
                  ))}
                  {sentReply && <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem', textAlign: 'center', margin: 0 }}>Message sent to your therapist</p>}
                </div>
              )}
            </div>
          )}

          {/* 5-minute warning banner */}
          {showWarnBanner && (
            <div style={{ position: 'absolute', top: 52, left: 16, right: 16, background: 'rgba(192,57,43,0.92)', color: '#fff', borderRadius: 10, padding: '8px 16px', textAlign: 'center', fontWeight: 600, fontSize: '0.86rem' }}>
              5 minutes remaining
            </div>
          )}

          {/* Local video pip */}
          <video ref={localVideoRef} style={{ position: 'absolute', bottom: 80, right: 16, width: 90, height: 120, objectFit: 'cover', borderRadius: 8, border: '2px solid #fff' }} playsInline autoPlay muted />

          {/* Timer */}
          <div style={{ position: 'absolute', top: 16, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
            <div style={{ background: timerRed ? 'rgba(192,57,43,0.9)' : 'rgba(0,0,0,0.6)', color: '#fff', padding: '4px 16px', borderRadius: 20, fontSize: '0.9rem', fontWeight: 700 }}>
              {timerStr}
            </div>
          </div>
        </div>
      ) : (
        /* Voice session — waveform placeholder */
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#1a1a2e', gap: 24 }}>
          <audio ref={remoteAudioRef} autoPlay />
          <div style={{ width: 100, height: 100, borderRadius: '50%', background: 'var(--color-calm)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: connState === 'active' ? 'waveform 1.5s ease-in-out infinite' : 'none' }}>
            <svg width="40" height="32" viewBox="0 0 40 32" fill="none">
              {[4, 10, 16, 22, 28, 34].map((x, i) => (
                <rect key={i} x={x} y={16 - [6, 10, 14, 14, 10, 6][i]} width="3" height={[12, 20, 28, 28, 20, 12][i]} rx="2" fill="#fff" opacity="0.9" />
              ))}
            </svg>
          </div>
          <p style={{ color: '#fff', fontWeight: 600, fontSize: '1rem' }}>{connState === 'active' ? 'In session' : 'Connecting…'}</p>
          {connState === 'connecting' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 280, padding: '0 24px', boxSizing: 'border-box' }}>
              {QUICK_REPLIES.map(text => (
                <button
                  key={text}
                  onClick={() => sendQuickReply(text)}
                  disabled={sentReply}
                  style={{ padding: '10px 16px', borderRadius: 20, border: '1px solid rgba(255,255,255,0.35)', background: sentReply ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.12)', color: sentReply ? 'rgba(255,255,255,0.35)' : '#fff', fontSize: '0.82rem', cursor: sentReply ? 'default' : 'pointer' }}
                >
                  {text}
                </button>
              ))}
              {sentReply && <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem', textAlign: 'center', margin: 0 }}>Message sent to your therapist</p>}
            </div>
          )}
          <div style={{ background: timerRed ? 'rgba(192,57,43,0.9)' : 'rgba(255,255,255,0.15)', color: '#fff', padding: '6px 20px', borderRadius: 20, fontSize: '1rem', fontWeight: 700 }}>
            {timerStr}
          </div>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 24, padding: '16px 0 32px', background: isVideo ? 'rgba(0,0,0,0.85)' : '#0d0d1a' }}>
        <ControlBtn onClick={toggleMute} active={muted} label={muted ? 'Unmute' : 'Mute'}>
          {muted ? <MicrophoneSlash size={22} color="#fff" /> : <Microphone size={22} color="#fff" />}
        </ControlBtn>
        {isVideo && (
          <ControlBtn onClick={toggleVideo} active={videoOff} label={videoOff ? 'Show video' : 'Hide video'}>
            {videoOff ? <VideoCameraSlash size={22} color="#fff" /> : <VideoCamera size={22} color="#fff" />}
          </ControlBtn>
        )}
        <button
          onClick={endSession}
          style={{ width: 60, height: 60, borderRadius: '50%', background: '#c0392b', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          aria-label="End session"
        >
          <PhoneDisconnect size={26} color="#fff" />
        </button>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes waveform { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
      `}</style>
    </div>
  );
}

// ── Text session ──────────────────────────────────────────────────────────────
function TextSession({ booking, joinData, onEnd }) {
  useAuth();
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [contactWarning, setContactWarning] = useState(false);
  const [ended, setEnded] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const ws = new WebSocket(`${WS_URL}/ws/signal?session=${booking.id}&token=${joinData.room_token}&session_type=therapy`);
    wsRef.current = ws;

    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', role: 'member' }));
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'chat') {
        setMessages(prev => [...prev, { from: 'therapist', text: msg.text, ts: Date.now() }]);
      } else if (msg.type === 'session_ended') {
        setEnded(true);
        setTimeout(onEnd, 2000);
      }
    };

    return () => ws.close();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function send() {
    const text = input.trim();
    if (!text || ended) return;
    if (containsContactInfo(text)) {
      setContactWarning(true);
      return;
    }
    setContactWarning(false);
    wsRef.current?.send(JSON.stringify({ type: 'chat', text }));
    setMessages(prev => [...prev, { from: 'member', text, ts: Date.now() }]);
    setInput('');
  }

  const elapsedStr = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  const totalStr   = `${booking.duration_minutes ?? 60} min`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-bg-primary)' }}>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px var(--space-md)', borderBottom: '1px solid var(--color-border)', flexShrink: 0, background: 'var(--color-bg-primary)' }}>
        <span style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
          {booking.therapist_display_name ?? 'Therapist'} · Text session
        </span>
        <span style={{ fontSize: '0.84rem', color: elapsed >= (booking.duration_minutes ?? 60) * 60 * 0.9 ? 'var(--color-warning, #E88B3F)' : 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {elapsedStr} / {totalStr}
        </span>
      </div>
      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ended && (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--color-text-muted)', fontSize: '0.86rem' }}>
            Session ended
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.from === 'member' ? 'flex-end' : 'flex-start' }}>
            <div style={{
              maxWidth: '78%', padding: '10px 14px', borderRadius: m.from === 'member' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
              background: m.from === 'member' ? 'var(--color-calm)' : 'var(--color-surface-card)',
              color: m.from === 'member' ? '#fff' : 'var(--color-text-primary)',
              fontSize: '0.88rem', lineHeight: 1.5,
            }}>
              {m.text}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Contact warning */}
      {contactWarning && (
        <div style={{ background: 'var(--color-warning, #E88B3F)', color: '#fff', padding: '10px var(--space-md)', fontSize: '0.82rem', lineHeight: 1.4, flexShrink: 0 }}>
          Sharing contact information outside the platform is not permitted.
        </div>
      )}

      {/* Input */}
      {!ended ? (
        <div style={{ display: 'flex', gap: 8, padding: 'var(--space-sm) var(--space-md)', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-primary)', flexShrink: 0 }}>
          <input
            value={input}
            onChange={e => { setInput(e.target.value); if (contactWarning) setContactWarning(false); }}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
            placeholder="Type a message…"
            style={{ flex: 1, border: '1px solid var(--color-border)', borderRadius: 20, padding: '10px 14px', fontSize: '0.88rem', background: 'var(--color-surface)', color: 'var(--color-text-primary)', outline: 'none', fontFamily: 'inherit' }}
          />
          <button onClick={send} disabled={!input.trim()} style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--color-calm)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: input.trim() ? 1 : 0.5 }} aria-label="Send">
            <PaperPlaneTilt size={20} color="#fff" weight="fill" />
          </button>
        </div>
      ) : (
        <div style={{ padding: 'var(--space-md)', borderTop: '1px solid var(--color-border)', flexShrink: 0 }}>
          <button className="btn btn--primary" style={{ width: '100%' }} onClick={onEnd}>Return to my bookings</button>
        </div>
      )}
    </div>
  );
}

function ControlBtn({ onClick, active, label, children }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{
        width: 50, height: 50, borderRadius: '50%', border: 'none', cursor: 'pointer',
        background: active ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.15)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function TherapySessionScreen() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const [joinData, setJoinData] = useState(null);
  const [booking, setBooking] = useState(null);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const [showRating, setShowRating] = useState(false);

  useEffect(() => {
    async function init() {
      try {
        const { data } = await client.get(`/api/therapy/sessions/${bookingId}/join`);
        setJoinData(data);
        // Also fetch booking for format + duration
        const { data: bData } = await client.get(`/api/therapy/bookings/${bookingId}`);
        setBooking(bData.booking);
      } catch (err) {
        const code = err.response?.data?.code;
        if (code === 'TOKEN_CONSUMED') {
          setError('This session link has already been used. Please return to your bookings.');
        } else {
          setError(err.response?.data?.message || 'Could not join session. Please try again.');
        }
      }
    }
    init();
  }, [bookingId]);

  // Poll booking status — if cancelled externally, close the room
  useEffect(() => {
    if (!booking || ended) return;
    const iv = setInterval(async () => {
      try {
        const { data } = await client.get(`/api/therapy/bookings/${booking.id}`);
        if (!['in_progress', 'confirmed'].includes(data.booking?.status)) {
          clearInterval(iv);
          setEnded(true);
          navigate('/therapy/my', { replace: true });
        }
      } catch { /* best-effort */ }
    }, 8000);
    return () => clearInterval(iv);
  }, [booking, ended]);

  function handleEnd() {
    setEnded(true);
    setShowRating(true);
  }

  if (showRating && booking) {
    return (
      <RatingPrompt
        booking={booking}
        onDone={() => navigate('/therapy/my', { replace: true })}
      />
    );
  }

  if (error) {
    return (
      <div className="screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-lg)', textAlign: 'center' }}>
        <p style={{ color: 'var(--color-error, #c0392b)', fontWeight: 600, marginBottom: 20 }}>{error}</p>
        <button className="btn btn--primary" onClick={() => navigate('/therapy/my')}>Back to my bookings</button>
      </div>
    );
  }

  if (!joinData || !booking) {
    return (
      <div className="screen" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', border: '3px solid var(--color-calm)', borderTopColor: 'transparent', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.86rem' }}>Joining session…</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const format = booking.session_format;

  if (format === 'text') {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <TextSession booking={booking} joinData={joinData} onEnd={handleEnd} />
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MediaSession booking={booking} joinData={joinData} onEnd={handleEnd} />
    </div>
  );
}