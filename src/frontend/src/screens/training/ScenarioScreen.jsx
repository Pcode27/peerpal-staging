import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Leaf, Star, Plant } from '@phosphor-icons/react';
import client from '../../api/client';

export default function ScenarioScreen() {
  const { attemptId } = useParams();
  const { state: navState } = useLocation();
  const navigate = useNavigate();

  const [phase, setPhase] = useState(() => {
    if (!navState?.node) return 'loading';
    return navState.intro ? 'intro' : 'question';
  });
  const [node, setNode] = useState(navState?.node || null);
  const intro = navState?.intro || null;
  const [title, setTitle] = useState(navState?.scenario_title || '');
  const [slug, setSlug] = useState(navState?.slug || '');
  const [selectedChoice, setSelectedChoice] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  // Resume from backend if no navState (page refresh / direct nav)
  useEffect(() => {
    if (navState?.node) return; // phase already initialised correctly in useState
    client.get(`/api/training/scenarios/${attemptId}`)
      .then(r => {
        setNode(r.data.node);
        setTitle(r.data.scenario_title || '');
        setSlug(r.data.skill_slug || '');
        setPhase('question');
      })
      .catch(() => setError('Could not resume scenario. Please go back and try again.'));
  }, [attemptId]); // eslint-disable-line

  const handleChoice = useCallback(async (choiceId) => {
    if (submitting) return;
    setSelectedChoice(choiceId);
    setSubmitting(true);
    setError('');
    try {
      const { data } = await client.post(`/api/training/scenarios/${attemptId}/respond`, { choice_id: choiceId });
      if (data.done) {
        setResult(data);
        setPhase('result');
      } else {
        setNode(data.node);
        setSelectedChoice(null);
        setPhase('question');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit — please try again.');
      setSelectedChoice(null);
    } finally {
      setSubmitting(false);
    }
  }, [attemptId, submitting]);

  // ── Loading / error ──────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 20, padding: 32 }}>
        {error ? (
          <>
            <p style={{ color: 'var(--color-danger)', textAlign: 'center' }}>{error}</p>
            <button className="btn btn--ghost" onClick={() => navigate(-1)}>Back</button>
          </>
        ) : (
          <>
            <div className="skeleton" style={{ width: 64, height: 64, borderRadius: '50%' }} />
            <div className="skeleton" style={{ width: 200, height: 16, borderRadius: 8 }} />
          </>
        )}
      </div>
    );
  }

  // ── Intro ────────────────────────────────────────────────────────────────────
  if (phase === 'intro') {
    return (
      <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '32px 24px', gap: 24, textAlign: 'center' }}>
        <Leaf size={52} weight="duotone" color="var(--color-calm)" />
        <h2 style={{ fontFamily: 'var(--font-editorial)', fontSize: '1.3rem', color: 'var(--color-accent)' }}>{title}</h2>
        <p style={{ fontSize: '0.95rem', color: 'var(--color-text-secondary)', lineHeight: 1.75 }}>{intro}</p>
        <p style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          Respond as you genuinely would. There are no trick questions — this is about reflection, not performance.
        </p>
        <button className="btn btn--primary" onClick={() => setPhase('question')}>Begin</button>
        <button
          style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: '0.82rem', cursor: 'pointer', textDecoration: 'underline' }}
          onClick={() => navigate(-1)}
        >
          Not now
        </button>
      </div>
    );
  }

  // ── Result ───────────────────────────────────────────────────────────────────
  if (phase === 'result') {
    const passed = result?.passed;
    const message = passed ? result?.node?.pass_message : result?.node?.fail_message;
    return (
      <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '32px 24px', gap: 20, textAlign: 'center' }}>
        {passed
          ? <Star size={56} weight="fill" color="#C8943A" />
          : <Plant size={56} weight="duotone" color="var(--color-calm)" />
        }
        {passed ? (
          <>
            <h2 style={{ fontFamily: 'var(--font-editorial)', fontSize: '1.2rem', color: '#8FAF9A' }}>Skill Earned</h2>
            <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
              {message || 'You\'ve demonstrated real care and skill. This has been added to your profile.'}
            </p>
            <div style={{ background: 'rgba(143,175,154,0.15)', borderRadius: 'var(--radius-md)', border: '1px solid #8FAF9A', padding: '14px 16px', textAlign: 'left' }}>
              <div style={{ fontWeight: 700, color: '#8FAF9A', fontSize: '0.88rem', marginBottom: 6 }}>What this unlocks</div>
              <p style={{ fontSize: '0.82rem', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                Your new skill may activate peer support permissions. Check My Permissions to see what's available to you now.
              </p>
            </div>
          </>
        ) : (
          <>
            <h2 style={{ fontFamily: 'var(--font-editorial)', fontSize: '1.2rem' }}>You can try again</h2>
            <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
              {message || 'This scenario explores nuanced situations. Each attempt builds your awareness — there\'s no penalty for trying again.'}
            </p>
          </>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          {passed && (
            <button className="btn btn--primary" onClick={() => navigate('/training/permissions')}>
              View My Permissions
            </button>
          )}
          <button className={passed ? 'btn btn--ghost' : 'btn btn--primary'} onClick={() => navigate('/training')}>
            Back to Training
          </button>
          {!passed && slug && (
            <button className="btn btn--ghost" onClick={() => navigate(`/training/${slug}`)}>
              Try Again
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Question ─────────────────────────────────────────────────────────────────
  return (
    <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <div style={{
        padding: '12px 16px', background: 'var(--color-bg-primary)',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <button
          onClick={() => navigate(-1)}
          style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 22, cursor: 'pointer', padding: '4px 8px 4px 0', lineHeight: 1 }}
        >‹</button>
        <span style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)', fontWeight: 500, textAlign: 'center', flex: 1 }}>{title}</span>
        <div style={{ width: 28 }} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {node?.scene && (
          <p style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>{node.scene}</p>
        )}

        <div style={{ background: 'var(--color-calm-bg)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-calm)', padding: '18px 16px' }}>
          <p style={{ fontSize: '1rem', lineHeight: 1.75, color: 'var(--color-text-primary)', fontFamily: 'var(--font-editorial)' }}>
            {node?.prompt}
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
          {(node?.choices || []).map(choice => (
            <button
              key={choice.id}
              onClick={() => handleChoice(choice.id)}
              disabled={submitting}
              style={{
                padding: '14px 16px',
                background: selectedChoice === choice.id ? 'rgba(194,164,138,0.18)' : 'var(--color-surface-card)',
                border: `2px solid ${selectedChoice === choice.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-md)',
                textAlign: 'left',
                cursor: submitting ? 'default' : 'pointer',
                fontSize: '0.9rem',
                lineHeight: 1.55,
                color: 'var(--color-text-primary)',
                opacity: submitting && selectedChoice !== choice.id ? 0.45 : 1,
                transition: 'all 150ms',
              }}
            >
              {choice.text}
            </button>
          ))}
        </div>

        {error && (
          <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', textAlign: 'center' }}>{error}</p>
        )}
      </div>
    </div>
  );
}
