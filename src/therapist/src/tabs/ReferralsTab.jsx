import { useState, useEffect, useCallback, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Lock, ArrowsOut, ArrowsIn,
  ClipboardText, Check,
  UserPlus, Hourglass, CurrencyCircleDollar,
  ShareNetwork, ShieldCheck, Scroll,
} from '@phosphor-icons/react';
import { useAuth } from '../context/AuthContext';
import client from '../api/client';

const BASE_URL = 'https://therapist.peer-pal.com/join';

function formatEAT(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-KE', {
      timeZone: 'Africa/Nairobi',
      day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch { return iso; }
}

function formatKES(n) {
  return `KES ${Number(n || 0).toLocaleString()}`;
}

export default function ReferralsTab() {
  const { therapist } = useAuth();
  const [profile,     setProfile]     = useState(null);
  const [referrals,   setReferrals]   = useState([]);
  const [commissions, setCommissions] = useState([]);
  const [totals,      setTotals]      = useState({ pending: 0, paid: 0 });
  const [loading,     setLoading]     = useState(true);
  const [signing,     setSigning]     = useState(false);
  const [signError,   setSignError]   = useState('');
  const [copied,      setCopied]      = useState(false);
  const iframeRef = useRef(null);
  const [fsActive,    setFsActive]    = useState(false);

  const load = useCallback(async () => {
    try {
      const [pRes, rRes, cRes] = await Promise.all([
        client.get('/api/therapy/therapist/profile'),
        client.get('/api/therapy/therapist/my-referrals'),
        client.get('/api/therapy/therapist/my-commissions'),
      ]);
      const p = pRes.data.profile || {};
      setProfile({ addendum_signed_at: p.addendum_signed_at, referral_code: p.referral_code });
      setReferrals(rRes.data.referrals ?? []);
      setCommissions(cRes.data.commissions ?? []);
      setTotals({ pending: cRes.data.total_pending_kes, paid: cRes.data.total_paid_kes });
    } catch { /* silent — states stay at defaults */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onFsChange = () => setFsActive(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  async function handleSign() {
    setSigning(true);
    setSignError('');
    try {
      const { data } = await client.post('/api/therapy/therapist/sign-addendum');
      setProfile((p) => ({ ...p, addendum_signed_at: new Date().toISOString(), referral_code: data.referral_code }));
      load();
    } catch (err) {
      setSignError(err?.response?.data?.error || 'Signing failed — please try again.');
    } finally {
      setSigning(false);
    }
  }

  function copyLink() {
    const link = `${BASE_URL}?ref=${profile?.referral_code}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Clipboard unavailable — select text manually
      setCopied(false);
    });
  }

  const stateKey = loading
    ? 'loading'
    : !therapist?.is_verified
    ? 'unverified'
    : !profile?.addendum_signed_at
    ? 'unsigned'
    : 'active';

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={stateKey}
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
      >

        {/* ── Loading ────────────────────────────────────────────── */}
        {stateKey === 'loading' && (
          <div className="loading">Loading…</div>
        )}

        {/* ── State A: not verified ──────────────────────────────── */}
        {stateKey === 'unverified' && (
          <div style={{ maxWidth: 520, margin: '48px auto 0', padding: '0 8px' }}>
            <div className="card" style={{ padding: '48px 44px', textAlign: 'center' }}>
              {/* Icon */}
              <div style={{
                width: 72, height: 72, borderRadius: 20,
                background: 'rgba(217,164,65,0.12)', color: 'var(--color-status-pending)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 24px',
              }}>
                <Lock size={36} weight="duotone" />
              </div>

              <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 10, color: 'var(--color-text-primary)', letterSpacing: -0.3 }}>
                Referral Programme
              </h2>
              <p style={{ fontSize: 14, color: 'var(--color-text-muted)', lineHeight: 1.7, margin: '0 auto 36px', maxWidth: 360 }}>
                Earn 5% of PeerPal's platform fee for every session completed by a therapist you refer — for 12 months per referral.
                Your account must be verified first.
              </p>

              {/* Journey steps */}
              <div style={{ display: 'flex', gap: 0, alignItems: 'flex-start', justifyContent: 'center', maxWidth: 400, margin: '0 auto' }}>
                {[
                  { Icon: ShieldCheck, label: 'Get verified', done: false, active: true },
                  { Icon: Scroll,      label: 'Sign addendum', done: false, active: false },
                  { Icon: CurrencyCircleDollar, label: 'Earn commissions', done: false, active: false },
                ].map(({ Icon, label, active }, i, arr) => (
                  <div key={label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, position: 'relative' }}>
                    {/* connector line */}
                    {i < arr.length - 1 && (
                      <div style={{
                        position: 'absolute', top: 18, left: '50%', width: '100%',
                        height: 2, background: 'var(--color-card-border)', zIndex: 0,
                      }} />
                    )}
                    <div style={{
                      width: 36, height: 36, borderRadius: '50%', zIndex: 1,
                      background: active ? 'rgba(217,164,65,0.15)' : 'var(--color-main-bg)',
                      border: `2px solid ${active ? 'var(--color-status-pending)' : 'var(--color-card-border)'}`,
                      color: active ? 'var(--color-status-pending)' : 'var(--color-text-muted)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Icon size={16} weight={active ? 'duotone' : 'regular'} />
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, color: active ? 'var(--color-status-pending)' : 'var(--color-text-muted)', textAlign: 'center', lineHeight: 1.3 }}>
                      {label}
                    </span>
                  </div>
                ))}
              </div>

              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 28 }}>
                Verification usually takes 1–2 business days after document submission.
              </p>
            </div>
          </div>
        )}

        {/* ── State B: verified, addendum not signed ──────────────── */}
        {stateKey === 'unsigned' && (
          <div style={{ maxWidth: 640, margin: '0 auto', padding: '0 8px 48px' }}>
            {/* Header */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: 'rgba(143,175,154,0.15)', color: 'var(--color-success)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <Scroll size={22} weight="duotone" />
                </div>
                <div>
                  <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: -0.3, marginBottom: 2 }}>
                    Activate Your Referral Programme
                  </h1>
                  <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>
                    5% commission · 12-month window per referral · paid monthly via M-Pesa
                  </p>
                </div>
              </div>
            </div>

            {/* Journey: step 2 of 3 active */}
            <div style={{ display: 'flex', gap: 0, alignItems: 'flex-start', marginBottom: 28 }}>
              {[
                { Icon: ShieldCheck, label: 'Verified', done: true, active: false },
                { Icon: Scroll,      label: 'Sign addendum', done: false, active: true },
                { Icon: CurrencyCircleDollar, label: 'Earn commissions', done: false, active: false },
              ].map(({ Icon, label, done, active }, i, arr) => (
                <div key={label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, position: 'relative' }}>
                  {i < arr.length - 1 && (
                    <div style={{
                      position: 'absolute', top: 15, left: '50%', width: '100%',
                      height: 2,
                      background: done ? 'var(--color-success)' : 'var(--color-card-border)',
                      zIndex: 0,
                    }} />
                  )}
                  <div style={{
                    width: 30, height: 30, borderRadius: '50%', zIndex: 1,
                    background: done ? 'rgba(143,175,154,0.2)' : active ? 'rgba(194,164,138,0.15)' : 'var(--color-main-bg)',
                    border: `2px solid ${done ? 'var(--color-success)' : active ? 'var(--color-accent)' : 'var(--color-card-border)'}`,
                    color: done ? 'var(--color-success)' : active ? 'var(--color-accent)' : 'var(--color-text-muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Icon size={14} weight={done || active ? 'duotone' : 'regular'} />
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 600, color: done ? 'var(--color-success)' : active ? 'var(--color-text-primary)' : 'var(--color-text-muted)', textAlign: 'center' }}>
                    {label}
                  </span>
                </div>
              ))}
            </div>

            {/* PDF viewer */}
            <div ref={iframeRef} style={{ position: 'relative', height: 400, border: '1px solid var(--color-card-border)', borderRadius: 10, marginBottom: 16, overflow: 'hidden', background: '#f5f5f5' }}>
              <iframe
                src="/therapist-agreement.pdf"
                title="PeerPal Referral Addendum"
                style={{ width: '100%', height: '100%', border: 'none' }}
              />
              <button
                type="button"
                title={fsActive ? 'Exit fullscreen' : 'View fullscreen'}
                onClick={() => fsActive ? document.exitFullscreen() : iframeRef.current?.requestFullscreen()}
                style={{
                  position: 'absolute', top: 10, right: 10,
                  background: 'rgba(0,0,0,0.50)', color: '#fff',
                  border: 'none', borderRadius: 6, width: 32, height: 32,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {fsActive
                  ? <ArrowsIn size={16} weight="bold" />
                  : <ArrowsOut size={16} weight="bold" />}
              </button>
            </div>

            {/* Consent notice */}
            <div style={{
              background: 'rgba(194,164,138,0.08)',
              border: '1px solid rgba(194,164,138,0.30)',
              borderRadius: 8, padding: '12px 16px', fontSize: 13,
              color: 'var(--color-text-primary)', marginBottom: 16, lineHeight: 1.6,
            }}>
              By clicking <strong>Sign &amp; Activate</strong> you confirm you have read the Referral Addendum
              and agree to its terms. This constitutes an electronic signature under the
              Electronic Transactions Act 2007 (Kenya).
            </div>

            {signError && (
              <div style={{
                background: 'var(--color-danger-bg)',
                border: '1px solid rgba(179,92,92,0.25)',
                borderRadius: 6, padding: '9px 12px', fontSize: 13,
                color: 'var(--color-status-open)', marginBottom: 14,
              }}>
                {signError}
              </div>
            )}

            <button
              className="btn btn--primary"
              onClick={handleSign}
              disabled={signing}
              style={{ width: '100%', justifyContent: 'center', padding: '13px 0', fontSize: 15, gap: 8 }}
            >
              <Scroll size={18} weight="duotone" />
              {signing ? 'Signing…' : 'Sign & Activate referral programme'}
            </button>
          </div>
        )}

        {/* ── State C: active ────────────────────────────────────── */}
        {stateKey === 'active' && (
          <div style={{ paddingBottom: 48 }}>

            {/* Hero: referral code + copy link */}
            <div className="dashboard-hero" style={{ marginBottom: 24 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <ShareNetwork size={18} weight="fill" style={{ color: 'var(--color-sidebar-accent)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(245,237,228,0.55)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    Referral Programme · Active
                  </span>
                </div>
                <div style={{ fontSize: 13, color: 'rgba(245,237,228,0.65)', marginBottom: 16 }}>
                  Earn 5% commission on sessions by therapists you refer · 12-month window per referral
                </div>
                {/* Link row */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{
                    flex: 1, minWidth: 200,
                    background: 'rgba(255,255,255,0.08)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 8, padding: '9px 14px',
                    fontSize: 13, color: 'rgba(245,237,228,0.90)',
                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {BASE_URL}?ref={profile?.referral_code}
                  </div>
                  <motion.button
                    className="btn btn--sm"
                    onClick={copyLink}
                    whileTap={{ scale: 0.95 }}
                    style={{
                      background: copied ? 'rgba(143,175,154,0.25)' : 'rgba(194,164,138,0.25)',
                      border: `1px solid ${copied ? 'rgba(143,175,154,0.40)' : 'rgba(194,164,138,0.40)'}`,
                      color: copied ? '#a8d8b8' : 'var(--color-sidebar-accent)',
                      flexShrink: 0, gap: 6, minWidth: 90,
                      transition: 'background 0.2s, border-color 0.2s, color 0.2s',
                    }}
                  >
                    {copied
                      ? <><Check size={14} weight="bold" /> Copied</>
                      : <><ClipboardText size={14} weight="duotone" /> Copy link</>}
                  </motion.button>
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontSize: 11, color: 'rgba(245,237,228,0.40)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Your code
                </div>
                <div style={{
                  fontFamily: "'SF Mono', 'Fira Code', monospace",
                  fontSize: 28, fontWeight: 700, letterSpacing: 6,
                  color: 'var(--color-sidebar-accent)',
                }}>
                  {profile?.referral_code}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(245,237,228,0.35)', marginTop: 4 }}>
                  Signed {formatEAT(profile?.addendum_signed_at)}
                </div>
              </div>
            </div>

            {/* Stats row */}
            <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 28 }}>
              {/* Referred */}
              <div className="stat-card stat-card--sessions">
                <div className="stat-card__icon-wrap stat-card__icon-wrap--sessions">
                  <UserPlus size={22} weight="duotone" />
                </div>
                <div className="stat-card__value" style={{ fontSize: 42 }}>
                  {referrals.length}
                </div>
                <div className="stat-card__label">
                  Therapists referred
                </div>
              </div>

              {/* Pending commissions */}
              <div className="stat-card stat-card--rating">
                <div className="stat-card__icon-wrap stat-card__icon-wrap--rating">
                  <Hourglass size={22} weight="duotone" />
                </div>
                <div className="stat-card__value stat-card__value--lg" style={{ fontSize: 26 }}>
                  {formatKES(totals.pending)}
                </div>
                <div className="stat-card__label">
                  Pending commissions
                </div>
              </div>

              {/* Total paid out */}
              <div className="stat-card stat-card--earnings">
                <div className="stat-card__icon-wrap stat-card__icon-wrap--earnings">
                  <CurrencyCircleDollar size={22} weight="duotone" />
                </div>
                <div className="stat-card__value stat-card__value--lg" style={{ fontSize: 26 }}>
                  {formatKES(totals.paid)}
                </div>
                <div className="stat-card__label">
                  Total paid out
                </div>
              </div>
            </div>

            {/* Referred therapists */}
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12, color: 'var(--color-text-primary)' }}>
              Therapists you've referred
            </h2>
            {referrals.length === 0 ? (
              <div className="card" style={{ padding: '28px 24px', marginBottom: 28, textAlign: 'center' }}>
                <div style={{ width: 48, height: 48, borderRadius: 14, background: 'rgba(123,155,181,0.10)', color: 'var(--color-status-review)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                  <UserPlus size={24} weight="duotone" />
                </div>
                <p style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: 0 }}>
                  No referrals yet — share your link to get started.
                </p>
              </div>
            ) : (
              <div className="card" style={{ padding: 0, marginBottom: 28, overflow: 'hidden' }}>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {['Therapist', 'Verified', 'Addendum', 'Joined'].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {referrals.map((r) => (
                        <motion.tr
                          key={r.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                        >
                          <td style={{ fontWeight: 500 }}>
                            {r.display_name || (
                              <span className="text-muted" style={{ fontStyle: 'italic' }}>Onboarding</span>
                            )}
                          </td>
                          <td>
                            <span className={`badge ${r.is_verified ? 'badge--completed' : 'badge--pending'}`}>
                              {r.is_verified ? 'Verified' : 'Pending'}
                            </span>
                          </td>
                          <td>
                            {r.addendum_signed_at
                              ? <span className="badge badge--completed">Signed</span>
                              : <span className="badge badge--in_review">Not yet</span>}
                          </td>
                          <td className="text-muted text-sm">{formatEAT(r.joined_at)}</td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Commission history */}
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12, color: 'var(--color-text-primary)' }}>
              Commission history
            </h2>
            {commissions.length === 0 ? (
              <div className="card" style={{ padding: '28px 24px', textAlign: 'center' }}>
                <div style={{ width: 48, height: 48, borderRadius: 14, background: 'rgba(143,175,154,0.12)', color: 'var(--color-success)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                  <CurrencyCircleDollar size={24} weight="duotone" />
                </div>
                <p style={{ fontSize: 14, color: 'var(--color-text-muted)', margin: 0 }}>
                  Commissions appear here after referred therapists complete paid sessions.
                </p>
              </div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {['Therapist', 'Session fee', 'Your commission', 'Status', 'Date'].map((h) => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {commissions.map((c) => (
                        <tr key={c.id}>
                          <td style={{ fontWeight: 500 }}>{c.referred_therapist_name}</td>
                          <td className="text-muted">{formatKES(c.session_fee_kes)}</td>
                          <td style={{ fontWeight: 700, color: 'var(--color-accent)' }}>{formatKES(c.commission_kes)}</td>
                          <td>
                            <span className={`badge ${
                              c.status === 'paid'     ? 'badge--completed'
                            : c.status === 'reversed' ? 'badge--cancelled'
                            :                           'badge--pending'
                            }`}>
                              {c.status}
                            </span>
                          </td>
                          <td className="text-muted text-sm">{formatEAT(c.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

      </motion.div>
    </AnimatePresence>
  );
}
