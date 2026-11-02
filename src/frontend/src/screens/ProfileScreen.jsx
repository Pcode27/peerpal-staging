import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Coin, SignOut, Fire, GraduationCap, Gift, Copy, Check } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import client from '../api/client';
import { buildReferralLink } from '../utils/referral';
import { track } from '../lib/analytics';


function ProfileSkeleton() {
  return (
    <div style={{ padding: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="skeleton" style={{ width: '100%', height: 80, borderRadius: 'var(--radius-lg)' }} />
      ))}
    </div>
  );
}

export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [notifPrefs, setNotifPrefs] = useState(null);
  const [error, setError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState(0);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [feedbackType, setFeedbackType] = useState('general');
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [impactOpen, setImpactOpen] = useState(false);

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile'],
    queryFn: () => client.get('/api/profile').then(r => r.data),
  });
  const { data: balanceData } = useQuery({
    queryKey: ['credits', 'balance'],
    queryFn: () => client.get('/api/credits/balance').then(r => r.data),
  });
  const { data: notifsData } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => client.get('/api/notifications').then(r => r.data),
  });
  const { data: peerStats } = useQuery({
    queryKey: ['peer', 'stats'],
    queryFn: () => client.get('/api/peer/stats').then(r => r.data),
  });
  const { data: referralStats } = useQuery({
    queryKey: ['referrals', 'my-stats'],
    queryFn: () => client.get('/api/referrals/my-stats').then(r => r.data),
  });
  const [linkCopied, setLinkCopied] = useState(false);
  const referralLink = referralStats?.referral_code
    ? buildReferralLink(referralStats.referral_code, import.meta.env.VITE_APP_URL || window.location.origin)
    : null;

  async function handleCopyReferral() {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
    } catch {
      // Older WebViews: fall back to a temporary textarea.
      const ta = document.createElement('textarea');
      ta.value = referralLink;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* nothing else to try */ }
      document.body.removeChild(ta);
    }
    setLinkCopied(true);
    track('referral_link_copied');
    setTimeout(() => setLinkCopied(false), 2000);
  }
  const { data: trainingData } = useQuery({
    queryKey: ['training', 'my-skills'],
    queryFn: () => client.get('/api/training/my-skills').then(r => r.data),
  });

  useEffect(() => {
    if (profile && notifPrefs === null) {
      setNotifPrefs({
        peer_broadcast:   profile.notif_peer_broadcast ?? true,
        checkin_reminder: profile.notif_checkin_reminder ?? true,
        group_messages:   profile.notif_group_messages ?? true,
        credit_low:       profile.notif_credit_low ?? true,
      });
    }
  }, [profile, notifPrefs]);

  async function updateNotifPref(key, value) {
    setNotifPrefs((p) => ({ ...p, [key]: value }));
    try {
      // Backend columns are notif_-prefixed (routes/notifications.js NOTIF_PREF_COLUMNS).
      await client.patch('/api/notifications/preferences', { [`notif_${key}`]: value });
    } catch {
      setNotifPrefs((p) => ({ ...p, [key]: !value }));
    }
  }

  async function handleDeleteData() {
    setDeleting(true);
    try {
      await client.post('/api/profile/delete-data');
      logout();
      navigate('/login', { replace: true });
    } catch {
      setError('Something went wrong on our end. We\'re on it.');
    } finally {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  }

  async function handleClearJournal() {
    if (!window.confirm('Delete all journal entries permanently? This cannot be undone.')) return;
    try {
      await client.delete('/api/journals');
      qc.invalidateQueries({ queryKey: ['journals'] });
    } catch {
      setError('Something went wrong. Please try again.');
    }
  }

  async function handleClearAIMemory() {
    if (!window.confirm('Clear your AI companion\'s memory? It will no longer recall past conversations. This cannot be undone.')) return;
    try {
      await client.delete('/api/ai/memories');
    } catch {
      setError('Something went wrong. Please try again.');
    }
  }

  async function handleFeedbackSubmit() {
    setSendingFeedback(true);
    try {
      await client.post('/api/feedback', { type: feedbackType, rating: feedbackRating || undefined, comment: feedbackComment.trim() || undefined });
      setFeedbackSent(true);
      setTimeout(() => { setFeedbackOpen(false); setFeedbackSent(false); setFeedbackRating(0); setFeedbackComment(''); }, 2000);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSendingFeedback(false);
    }
  }

  async function handleLogout() {
    try { await client.post('/api/auth/logout'); } catch { /* best-effort */ }
    logout();
    navigate('/login', { replace: true });
  }

  const loading = isLoading;
  const balance = balanceData?.balance ?? null;
  const notifications = notifsData?.notifications ?? (Array.isArray(notifsData) ? notifsData : []);

  if (loading) {
    return (
      <div className="screen">
        <div className="page-header">
          <h2 className="page-header__title">Profile</h2>
        </div>
        <ProfileSkeleton />
      </div>
    );
  }

  const balanceLow = balance !== null && balance <= 2;
  const unreadCount = notifications.filter((n) => !n.read_at).length;

  return (
    <div className="screen">
      <div className="page-header">
        <h2 className="page-header__title">Profile</h2>
        {unreadCount > 0 && (
          <span style={{ marginLeft: 'auto', background: 'var(--color-danger)', color: 'var(--color-text-primary)', borderRadius: 'var(--radius-pill)', padding: '2px 8px', fontSize: 12, fontWeight: 700 }}>
            {unreadCount} new
          </span>
        )}
      </div>

      <div style={{ padding: '0 var(--space-md)', display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
        {error && <div className="error-msg">{error}</div>}

        {/* Identity */}
        <div className="card">
          <h3 style={{ marginBottom: 'var(--space-md)' }}>My Account</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Alias</span>
              <span style={{ fontWeight: 600, color: 'var(--color-accent)', fontSize: 16 }}>{user?.alias || profile?.alias}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Email</span>
              <span style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>{profile?.email || '—'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Streak</span>
              <span style={{ fontWeight: 600, color: 'var(--color-warning)', display: 'flex', alignItems: 'center', gap: 4 }}>
                {profile?.streak_count ?? 0} <Fire size={15} weight="fill" color="var(--color-warning)" />
              </span>
            </div>
          </div>
        </div>

        {/* AI Companion */}
        {profile?.persona && (
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-md)' }}>
              <h3>My AI Companion</h3>
              <button
                onClick={() => navigate('/persona/edit')}
                style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-pill)', padding: '4px 14px', fontSize: 12, color: 'var(--color-text-secondary)', cursor: 'pointer' }}
              >
                Edit
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Name</span>
                <span style={{ fontWeight: 600, fontFamily: 'var(--font-editorial)', color: 'var(--color-accent)' }}>{profile.persona.persona_name}</span>
              </div>
              {[
                { label: 'Tone',      value: profile.persona.tone },
                { label: 'Style',     value: profile.persona.response_style },
                { label: 'Formality', value: profile.persona.formality },
                { label: 'Language',  value: profile.persona.language || 'english' },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{label}</span>
                  <span style={{ fontSize: 13, color: 'var(--color-text-primary)', textTransform: 'capitalize' }}>{value}</span>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 12, marginTop: 'var(--space-sm)', color: 'var(--color-text-muted)' }}>Name is permanent. Tone, style, formality, and language can be updated anytime.</p>
          </div>
        )}

        {/* Credits */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-sm)' }}>
            <h3>Credits</h3>
            <button
              onClick={() => navigate('/credits')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.82rem', color: 'var(--color-calm)', fontWeight: 600, padding: '4px 0' }}
            >
              {balanceLow ? 'Top up now' : 'Manage →'}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <Coin size={22} weight="duotone" color={balanceLow ? 'var(--color-danger)' : 'var(--color-accent)'} aria-hidden="true" />
            <span style={{ fontSize: 28, fontWeight: 700, color: balanceLow ? 'var(--color-danger)' : 'var(--color-text-primary)' }}>{balance ?? '—'}</span>
            <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>credits remaining</span>
          </div>
          {balanceLow && (
            <p style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 6 }}>Running low — tap "Top up now" to continue using sessions.</p>
          )}
        </div>

        {/* Refer a Friend — Phase 46 */}
        {referralLink && (
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 'var(--space-sm)' }}>
              <Gift size={22} weight="duotone" color="var(--color-accent)" aria-hidden="true" />
              <h3>Refer a Friend</h3>
            </div>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 'var(--space-sm)' }}>
              Share your link — earn 2 credits when a friend makes their first top-up.
            </p>
            <button
              type="button"
              onClick={handleCopyReferral}
              aria-label={linkCopied ? 'Referral link copied' : 'Copy referral link'}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', width: '100%',
                padding: '10px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                // Dark inset: .card redefines --color-text-primary to cream, so a light box is unreadable.
                background: 'var(--color-bg-deep)', border: '1px solid var(--color-border)',
                color: 'var(--color-text-primary)', textAlign: 'left',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {referralLink}
              </span>
              {linkCopied
                ? <><Check size={18} weight="bold" color="var(--color-calm)" aria-hidden="true" /><span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-calm)' }}>Copied</span></>
                : <><Copy size={18} color="var(--color-accent)" aria-hidden="true" /><span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-accent)' }}>Copy</span></>}
            </button>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 'var(--space-sm)' }}>
              {referralStats.total_referred} {referralStats.total_referred === 1 ? 'friend' : 'friends'} referred · {referralStats.total_credits_earned} credits earned
            </p>
          </div>
        )}

        {/* Peer Impact — only shown if user has completed any peer sessions */}
        {((peerStats?.sessions_completed ?? 0) > 0 || (peerStats?.pending_credits ?? 0) > 0) && (() => {
          const pending = parseFloat(peerStats.pending_credits ?? 0);
          const pct = Math.min(100, (pending / 2) * 100);
          const toGo = Math.max(0, 2 - pending);
          return (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-md)' }}>
                <h3>Your Peer Impact</h3>
                <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                  {peerStats.sessions_completed} session{peerStats.sessions_completed !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Accumulating progress */}
              <div style={{ marginBottom: 'var(--space-md)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Accumulating</span>
                  <span style={{ fontWeight: 700, color: 'var(--color-accent)', fontSize: 17 }}>
                    {pending.toFixed(2)} / 2.00 cr
                  </span>
                </div>
                <div style={{ background: 'var(--color-border)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 4, background: 'var(--color-calm)',
                    width: `${pct}%`, transition: 'width 0.4s ease',
                  }} />
                </div>
                <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 5 }}>
                  {pending >= 1.5
                    ? `${toGo.toFixed(2)} credits away — almost there!`
                    : 'Each session you help adds to this. Unlock 2 credits when you hit 2.00.'}
                </p>
              </div>

              {/* Lifetime stats row */}
              <div style={{
                display: 'flex', justifyContent: 'space-around',
                padding: '10px 0', borderTop: '1px solid var(--color-divider)',
                marginBottom: 'var(--space-sm)',
              }}>
                {[
                  { label: 'Total earned', value: parseFloat(peerStats.earned_credits_lifetime ?? 0).toFixed(2) + ' cr' },
                  { label: 'Redeemed',     value: (peerStats.redeemed_credits_lifetime ?? 0) + ' cr' },
                  { label: 'Rank',         value: `#${peerStats.rank ?? '—'}` },
                ].map(({ label, value }) => (
                  <div key={label} style={{ textAlign: 'center' }}>
                    <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--color-text-primary)' }}>{value}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>{label}</div>
                  </div>
                ))}
              </div>

              {/* How it works — collapsible */}
              <button
                onClick={() => setImpactOpen(v => !v)}
                style={{ background: 'none', border: 'none', color: 'var(--color-accent)', fontSize: 12, cursor: 'pointer', padding: 0, fontWeight: 600 }}
              >
                {impactOpen ? 'Hide details ▲' : 'How it works ▼'}
              </button>
              {impactOpen && (
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.65, marginTop: 8 }}>
                  <p>You earn 25% of what the person you helped spent. Text sessions earn 0.25 cr, voice sessions earn 0.50 cr.</p>
                  <p style={{ marginTop: 6 }}>Credits accumulate here and are added to your balance automatically once you reach 2.00 — then use them for your own sessions.</p>
                </div>
              )}
            </div>
          );
        })()}

        {/* Peer Training */}
        <div className="card" style={{ cursor: 'pointer' }} onClick={() => navigate('/training')}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3>Peer Training</h3>
            <span style={{ color: 'var(--color-accent)', fontSize: '0.85rem', fontWeight: 600 }}>View →</span>
          </div>
          <div style={{ marginTop: 'var(--space-sm)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <GraduationCap size={28} weight="duotone" color="var(--color-calm)" />
            <div>
              {trainingData?.skills?.length > 0 ? (
                <>
                  <div style={{ fontWeight: 600, fontSize: '1rem', color: '#8FAF9A' }}>
                    {trainingData.skills.length} skill{trainingData.skills.length !== 1 ? 's' : ''} earned
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                    Tap to view your progress and add more skills
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Start peer training</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                    Earn skills to become a qualified peer supporter
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Privacy & Data */}
        <div className="card">
          <h3 style={{ marginBottom: 'var(--space-md)' }}>Privacy & Data</h3>
          {profile?.consent_version && (
            <p style={{ fontSize: 13, marginBottom: 'var(--space-md)', color: 'var(--color-text-muted)' }}>
              Consent v{profile.consent_version} accepted {profile.consented_at ? new Date(profile.consented_at).toLocaleDateString() : ''}
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <button className="btn btn--muted btn--sm" onClick={handleClearJournal}>Clear My Journal</button>
            <button className="btn btn--muted btn--sm" onClick={handleClearAIMemory}>Clear AI Memory</button>
            {deleteConfirm ? (
              <div>
                <p style={{ fontSize: 13, marginBottom: 'var(--space-sm)', color: 'var(--color-danger)' }}>
                  This will delete all your data within 24 hours. Are you sure?
                </p>
                <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
                  <button className="btn btn--danger btn--sm" onClick={handleDeleteData} disabled={deleting} style={{ flex: 1, animation: 'none' }}>
                    {deleting ? 'Deleting…' : 'Yes, delete everything'}
                  </button>
                  <button className="btn btn--muted btn--sm" onClick={() => setDeleteConfirm(false)} style={{ flex: 1 }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="btn btn--danger btn--sm" onClick={() => setDeleteConfirm(true)} style={{ animation: 'none' }}>Delete My Data</button>
            )}
          </div>
        </div>

        {/* Notifications */}
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-sm)' }}>
            <h3>Notifications</h3>
            <button
              onClick={() => navigate('/notifications')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.82rem', color: 'var(--color-calm)', fontWeight: 600, padding: '4px 0' }}
            >
              {unreadCount > 0 ? `View (${unreadCount > 9 ? '9+' : unreadCount} unread)` : 'View all'}
            </button>
          </div>
          {[
            { key: 'peer_broadcast',   label: 'Peer request broadcasts' },
            { key: 'checkin_reminder', label: 'Daily check-in reminder' },
            { key: 'group_messages',   label: 'Group messages' },
            { key: 'credit_low',       label: 'Low balance alerts' },
          ].map(({ key, label }) => (
            <label key={key} className="toggle-row" style={{ cursor: 'pointer' }}>
              <span className="toggle-label">{label}</span>
              <input
                type="checkbox"
                checked={(notifPrefs ?? {})[key] ?? true}
                onChange={(e) => updateNotifPref(key, e.target.checked)}
                style={{ width: 20, height: 20, accentColor: 'var(--color-accent)', cursor: 'pointer' }}
              />
            </label>
          ))}
        </div>

        {/* Safety Plan */}
        <button className="btn btn--ghost" onClick={() => navigate('/safety-plan')}>My Safety Plan</button>

        {/* Feedback */}
        <div className="card">
          <h3 style={{ marginBottom: 'var(--space-md)' }}>App Feedback</h3>
          {feedbackOpen ? (
            feedbackSent ? (
              <p style={{ textAlign: 'center', color: 'var(--color-calm)' }}>Thank you for your feedback!</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
                <select className="select" value={feedbackType} onChange={(e) => setFeedbackType(e.target.value)}>
                  <option value="general">General</option>
                  <option value="peer_session">Peer Session</option>
                  <option value="ai_chat">AI Chat</option>
                  <option value="bug">Bug Report</option>
                </select>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[1,2,3,4,5].map((s) => (
                    <button key={s} type="button" onClick={() => setFeedbackRating(s)} style={{ fontSize: 24, background: 'none', border: 'none', cursor: 'pointer', opacity: s <= feedbackRating ? 1 : 0.3, minWidth: 44, minHeight: 44 }} aria-label={`Rate ${s}`}>⭐</button>
                  ))}
                </div>
                <textarea className="textarea" rows={3} maxLength={300} value={feedbackComment} onChange={(e) => setFeedbackComment(e.target.value)} placeholder="Optional comment…" />
                <div style={{ display: 'flex', gap: 'var(--space-sm)' }}>
                  <button className="btn btn--primary btn--sm" onClick={handleFeedbackSubmit} disabled={sendingFeedback} style={{ flex: 1 }}>
                    {sendingFeedback ? 'Sending…' : 'Send'}
                  </button>
                  <button className="btn btn--muted btn--sm" onClick={() => setFeedbackOpen(false)} style={{ flex: 1 }}>Cancel</button>
                </div>
              </div>
            )
          ) : (
            <button className="btn btn--ghost btn--sm" style={{ width: 'auto' }} onClick={() => setFeedbackOpen(true)}>Send Feedback</button>
          )}
        </div>

        <button
          className="btn btn--muted"
          onClick={handleLogout}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--color-danger)' }}
        >
          <SignOut size={20} weight="duotone" aria-hidden="true" />
          Log Out
        </button>

        {/* Legal footer */}
        <div style={{ textAlign: 'center', paddingTop: 'var(--space-sm)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
            <Link to="/privacy-policy" style={{ fontSize: 12, color: 'var(--color-text-muted)', textDecoration: 'none' }}>Privacy Policy</Link>
            <Link to="/terms-of-service" style={{ fontSize: 12, color: 'var(--color-text-muted)', textDecoration: 'none' }}>Terms of Service</Link>
            <Link to="/data-compliance" style={{ fontSize: 12, color: 'var(--color-text-muted)', textDecoration: 'none' }}>Data Compliance</Link>
          </div>
          <p style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            © {new Date().getFullYear()} PeerPal. All rights reserved.
          </p>
          <p style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            PeerPal is not a medical service.
          </p>
        </div>
      </div>
    </div>
  );
}
