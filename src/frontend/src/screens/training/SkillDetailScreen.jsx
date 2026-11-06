import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Ear, Heart, Lock, Shield, Lifebuoy, Leaf, Flame, Rainbow,
  Lightbulb, Link, Umbrella, Mountains, Compass, Plant, Anchor,
  Lighthouse, DoorOpen, Globe, Clock, Star, CheckCircle, XCircle,
} from '@phosphor-icons/react';
import client from '../../api/client';

const SKILL_ICONS = {
  ear:          Ear,
  heart:        Heart,
  lock:         Lock,
  shield:       Shield,
  lifebuoy:     Lifebuoy,
  clover:       Leaf,
  candle:       Flame,
  prism:        Rainbow,
  lantern:      Lightbulb,
  bridge:       Link,
  umbrella:     Umbrella,
  mountain:     Mountains,
  compass:      Compass,
  sapling:      Plant,
  anchor:       Anchor,
  lighthouse:   Lighthouse,
  'door-open':  DoorOpen,
  globe:        Globe,
};

export default function SkillDetailScreen() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [startError, setStartError] = useState('');

  useEffect(() => {
    client.get(`/api/training/skills/${slug}`)
      .then(r => setData(r.data))
      .catch(() => setError('Could not load skill details.'))
      .finally(() => setLoading(false));
  }, [slug]);

  async function handleStart() {
    setStartError('');
    setStarting(true);
    try {
      const { data: startData } = await client.post(`/api/training/skills/${slug}/start`);
      navigate(`/training/scenario/${startData.attempt_id}`, {
        state: {
          node: startData.node,
          intro: startData.intro,
          scenario_title: startData.scenario_title,
          slug,
        },
      });
    } catch (err) {
      const code = err.response?.data?.code;
      setStartError(
        code === 'PREREQS_REQUIRED'
          ? 'You need to complete prerequisite skills first.'
          : err.response?.data?.error || 'Could not start scenario. Please try again.'
      );
    } finally {
      setStarting(false);
    }
  }

  function handleResume(attemptId) {
    navigate(`/training/scenario/${attemptId}`);
  }

  if (loading) return (
    <div className="screen">
      <div className="page-header">
        <button className="page-header__back" onClick={() => navigate(-1)}>‹</button>
        <h2 className="page-header__title">Skill</h2>
      </div>
      <div style={{ padding: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {[1,2,3].map(i => <div key={i} className="skeleton" style={{ height: 80, borderRadius: 'var(--radius-md)' }} />)}
      </div>
    </div>
  );

  if (error) return (
    <div className="screen">
      <div className="page-header">
        <button className="page-header__back" onClick={() => navigate(-1)}>‹</button>
        <h2 className="page-header__title">Skill</h2>
      </div>
      <div className="error-msg" style={{ margin: 'var(--space-md)' }}>{error}</div>
    </div>
  );

  const { skill: s, scenario, recent_attempts } = data ?? {};
  const earned = s?.status === 'earned';
  const locked = s?.status === 'locked';
  const groupColor = earned ? (s.skill_group === 'baseline' ? '#8FAF9A' : '#C8943A') : 'var(--color-accent)';
  const IconComp = SKILL_ICONS[s?.icon_name] || Star;
  const activeAttempt = recent_attempts?.find(a => !a.completed_at);

  return (
    <div className="screen">
      <div className="page-header">
        <button className="page-header__back" onClick={() => navigate(-1)} aria-label="Back">‹</button>
        <h2 className="page-header__title">{s?.name}</h2>
      </div>

      <div style={{ padding: '0 var(--space-md) var(--space-xl)', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        {/* Skill hero */}
        <div className="card" style={{ textAlign: 'center', padding: '24px 16px', borderTop: `4px solid ${groupColor}` }}>
          <div style={{ marginBottom: 12 }}><IconComp size={48} weight="duotone" color={groupColor} /></div>
          <h2 style={{ fontFamily: 'var(--font-editorial)', fontSize: '1.25rem', marginBottom: 8, color: groupColor }}>{s?.name}</h2>
          <p style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>{s?.description}</p>
          {earned && s?.earned_at && (
            <div style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, background: groupColor + '22', borderRadius: 'var(--radius-pill)', padding: '4px 14px' }}>
              <CheckCircle size={14} weight="fill" color={groupColor} />
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: groupColor }}>
                Earned {new Date(s.earned_at).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>

        {/* Scenario info */}
        {scenario && (
          <div className="card">
            <h3 style={{ marginBottom: 'var(--space-sm)' }}>Scenario</h3>
            <p style={{ fontWeight: 500, marginBottom: 6 }}>{scenario.title}</p>
            {scenario.estimated_minutes && (
              <p style={{ fontSize: '0.82rem', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Clock size={13} weight="regular" />About {scenario.estimated_minutes} minutes
              </p>
            )}
          </div>
        )}

        {/* Prerequisite notice */}
        {locked && (
          <div className="card" style={{ borderLeft: '4px solid var(--color-warning)' }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
              Complete prerequisite foundation skills before starting this one.
            </p>
            <button
              className="btn btn--ghost btn--sm"
              style={{ marginTop: 10, width: 'auto' }}
              onClick={() => navigate('/training')}
            >
              View all skills
            </button>
          </div>
        )}

        {/* Recent attempts */}
        {recent_attempts?.filter(a => a.completed_at).length > 0 && (
          <div className="card">
            <h3 style={{ marginBottom: 'var(--space-sm)' }}>Recent Attempts</h3>
            {recent_attempts.filter(a => a.completed_at).map((a, i) => (
              <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < recent_attempts.length - 1 ? '1px solid var(--color-divider)' : 'none', fontSize: '0.82rem' }}>
                <span style={{ color: a.passed ? '#8FAF9A' : 'var(--color-danger)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {a.passed
                    ? <><CheckCircle size={13} weight="fill" /> Passed</>
                    : <><XCircle size={13} weight="fill" /> Did not pass</>
                  }
                </span>
                <span style={{ color: 'var(--color-text-muted)' }}>{new Date(a.started_at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}

        {startError && <div className="error-msg">{startError}</div>}

        {/* Action buttons */}
        {scenario && !locked && (
          <>
            {activeAttempt ? (
              <button className="btn btn--primary" onClick={() => handleResume(activeAttempt.id)}>
                Resume Scenario
              </button>
            ) : null}
            <button
              className={activeAttempt ? 'btn btn--ghost' : 'btn btn--primary'}
              onClick={handleStart}
              disabled={starting}
            >
              {starting ? 'Starting…' : activeAttempt ? 'Start Over' : earned ? 'Try Again' : 'Start Scenario'}
            </button>
          </>
        )}

        {!scenario && !locked && (
          <p style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--color-text-muted)', padding: 'var(--space-md) 0' }}>
            Scenario not yet available for this skill.
          </p>
        )}
      </div>
    </div>
  );
}
