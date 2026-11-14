import { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { ChatText, Microphone, Heart } from '@phosphor-icons/react';
import client from '../../api/client';
import { track } from '../../lib/analytics';

const HOLD_SECONDS = 4;

const TIPS = [
  'You\'re here to listen, not to fix. That matters more than you think.',
  'Neither of you can see who the other is — that\'s the point.',
  'If the conversation gets heavy, it\'s okay to say "I hear you."',
  'You don\'t need to have answers. Presence is enough.',
];

export default function PeerBridgeScreen() {
  const { id: sessionId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [countdown, setCountdown] = useState(HOLD_SECONDS);
  const [topic, setTopic] = useState('');
  // Seed from navigation state so the correct route is used even if the session fetch fails
  const [channel, setChannel] = useState(location.state?.channel || 'text');
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const { data } = await client.get(`/api/peer/session/${sessionId}`);
        setTopic(data.session?.topic_label || '');
        setChannel(data.session?.channel || 'text');
        track('peer_session_started', { channel: data.session?.channel || 'text', topic: data.session?.topic_label || null });
      } catch { /* non-fatal — proceed without topic */ }
      finally { setLoading(false); }
    }
    load();
  }, [sessionId]);

  useEffect(() => {
    if (loading) return;
    const t = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(t);
          navigate(`/peer/session/${sessionId}/${channel}`, { replace: true });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [loading, sessionId, channel, navigate]);

  function skip() {
    navigate(`/peer/session/${sessionId}/${channel}`, { replace: true });
  }

  const ChannelIcon = channel === 'voice' ? Microphone : ChatText;

  return (
    <div className="screen screen--no-nav" style={{
      display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      minHeight: '100dvh', padding: 'var(--space-xl)', textAlign: 'center', gap: 'var(--space-lg)',
      background: 'var(--color-bg-deep)',
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: '50%',
        background: 'rgba(200,148,58,0.15)', border: '2px solid var(--color-accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <ChannelIcon size={32} weight="duotone" color="var(--color-accent)" />
      </div>

      <div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: 6 }}>
          {channel === 'voice' ? 'Voice call starting' : 'Chat session starting'}
        </h2>
        {topic ? (
          <p style={{ fontSize: '0.88rem', color: 'var(--color-text-muted)' }}>
            Topic: <strong style={{ color: 'var(--color-text-primary)' }}>{topic}</strong>
          </p>
        ) : null}
      </div>

      <div style={{
        maxWidth: 300, padding: '16px 20px',
        background: 'rgba(200,148,58,0.08)', borderRadius: 'var(--radius-md)',
        border: '1px solid rgba(200,148,58,0.20)',
      }}>
        <Heart size={16} weight="duotone" color="var(--color-accent)" style={{ marginBottom: 8 }} />
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', lineHeight: 1.6, margin: 0 }}>
          {tip}
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          border: '2px solid var(--color-accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '1.2rem', fontWeight: 700, color: 'var(--color-accent)',
        }}>
          {loading ? '…' : countdown}
        </div>
        <button
          onClick={skip}
          className="btn btn--ghost"
          style={{ fontSize: '0.85rem', padding: '8px 20px', width: 'auto' }}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
