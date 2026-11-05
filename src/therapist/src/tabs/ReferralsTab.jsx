import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'motion/react';
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
  const [profile,     setProfile]     = useState(null); // addendum_signed_at, referral_code
  const [referrals,   setReferrals]   = useState([]);
  const [commissions, setCommissions] = useState([]);
  const [totals,      setTotals]      = useState({ pending: 0, paid: 0 });
  const [loading,     setLoading]     = useState(true);
  const [signing,     setSigning]     = useState(false);
  const [signError,   setSignError]   = useState('');
  const [copied,      setCopied]      = useState(false);
  const iframeRef = useRef(null);
  const [fsBtn,       setFsBtn]       = useState(false);

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
    const onFsChange = () => setFsBtn(!!document.fullscreenElement);
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
    });
  }

  if (loading) return <div style={s.loading}>Loading…</div>;

  // ── State A: not verified ─────────────────────────────────────────────────
  if (!therapist?.is_verified) {
    return (
      <div style={s.wrap}>
        <div className="card" style={s.stateCard}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🔒</div>
          <h2 style={s.stateTitle}>Verification required</h2>
          <p style={s.stateSub}>
            Your account must be verified by the PeerPal team before you can join the referral programme.
            Once verified, come back here to sign the Referral Addendum and start earning.
          </p>
        </div>
      </div>
    );
  }

  // ── State B: verified, addendum not signed ────────────────────────────────
  if (!profile?.addendum_signed_at) {
    return (
      <div style={s.wrap}>
        <div style={{ maxWidth: 600, width: '100%' }}>
          <h1 style={s.heading}>Referral Addendum</h1>
          <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 20, lineHeight: 1.6 }}>
            Read and sign the Referral Addendum below to activate your referral link and start earning
            5% commission on sessions completed by therapists you refer.
          </p>

          {/* PDF viewer */}
          <div ref={iframeRef} style={{ ...s.docBox, position: 'relative' }}>
            <iframe
              src="/therapist-agreement.pdf"
              title="PeerPal Referral Addendum"
              style={{ width: '100%', height: '100%', border: 'none', borderRadius: 6 }}
            />
            <button
              type="button"
              title={fsBtn ? 'Exit fullscreen' : 'View fullscreen'}
              onClick={() => fsBtn ? document.exitFullscreen() : iframeRef.current?.requestFullscreen()}
              style={s.fsBtn}
            >
              {fsBtn ? '✕' : '⛶'}
            </button>
          </div>

          <div style={{ background: 'rgba(194,164,138,0.1)', border: '1px solid var(--color-accent)', borderRadius: 8, padding: '12px 16px', fontSize: 13, color: 'var(--color-text-primary)', marginBottom: 20, lineHeight: 1.6 }}>
            By clicking <strong>Sign &amp; Activate</strong> you confirm you have read the Referral Addendum
            and agree to its terms. This constitutes an electronic signature under the Electronic
            Transactions Act 2007 (Kenya).
          </div>

          {signError && <p style={s.error}>{signError}</p>}

          <button
            className="btn btn--primary"
            onClick={handleSign}
            disabled={signing}
            style={{ width: '100%', justifyContent: 'center', padding: '12px 0', fontSize: 15 }}
          >
            {signing ? 'Signing…' : 'Sign & Activate referral programme'}
          </button>
        </div>
      </div>
    );
  }

  // ── State C: active ───────────────────────────────────────────────────────
  const referralLink = `${BASE_URL}?ref=${profile.referral_code}`;

  return (
    <div style={s.wrap}>
      <h1 style={s.heading}>Referrals</h1>

      {/* Stats row */}
      <div style={s.statsRow}>
        {[
          { label: 'Your referral code', value: profile.referral_code, mono: true },
          { label: 'Therapists referred', value: referrals.length },
          { label: 'Pending commissions', value: formatKES(totals.pending) },
          { label: 'Total paid out', value: formatKES(totals.paid) },
        ].map(({ label, value, mono }) => (
          <div key={label} className="card" style={s.statCard}>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)', fontFamily: mono ? 'monospace' : undefined, letterSpacing: mono ? 2 : undefined }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Referral link */}
      <div className="card" style={{ padding: '16px 20px', marginBottom: 24 }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8, fontWeight: 600 }}>
          Your referral link — share this with therapists you want to refer
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            readOnly
            value={referralLink}
            style={{ flex: 1, fontSize: 13, background: 'var(--color-main-bg)', border: '1px solid var(--color-card-border)', borderRadius: 6, padding: '8px 12px', color: 'var(--color-text-primary)' }}
            onFocus={(e) => e.target.select()}
          />
          <button className="btn btn--primary btn--sm" onClick={copyLink} style={{ flexShrink: 0, minWidth: 72 }}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8, lineHeight: 1.5 }}>
          Addendum signed {formatEAT(profile.addendum_signed_at)} · 5% commission · 12-month window per referral
        </div>
      </div>

      {/* Referred therapists */}
      <h2 style={s.sectionTitle}>Therapists you've referred</h2>
      {referrals.length === 0 ? (
        <div className="card" style={s.empty}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--color-text-muted)' }}>
            No referrals yet — share your link to get started.
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, marginBottom: 24, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--color-main-bg)' }}>
                {['Therapist', 'Verified', 'Addendum signed', 'Joined'].map((h) => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {referrals.map((r) => (
                <motion.tr key={r.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ borderTop: '1px solid var(--color-card-border)' }}>
                  <td style={s.td}>{r.display_name || <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>Onboarding</span>}</td>
                  <td style={s.td}>
                    <span className={`badge ${r.is_verified ? 'badge--active' : 'badge--review'}`} style={{ fontSize: 10 }}>
                      {r.is_verified ? 'Verified' : 'Pending'}
                    </span>
                  </td>
                  <td style={s.td}>
                    {r.addendum_signed_at
                      ? <span className="badge badge--active" style={{ fontSize: 10 }}>Signed</span>
                      : <span className="badge badge--review" style={{ fontSize: 10 }}>Not yet</span>}
                  </td>
                  <td style={{ ...s.td, color: 'var(--color-text-muted)', fontSize: 12 }}>{formatEAT(r.joined_at)}</td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Commissions */}
      <h2 style={s.sectionTitle}>Commission history</h2>
      {commissions.length === 0 ? (
        <div className="card" style={s.empty}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--color-text-muted)' }}>
            Commissions appear here after referred therapists complete paid sessions.
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--color-main-bg)' }}>
                {['Therapist', 'Session fee', 'Your commission', 'Status', 'Date'].map((h) => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {commissions.map((c) => (
                <tr key={c.id} style={{ borderTop: '1px solid var(--color-card-border)' }}>
                  <td style={s.td}>{c.referred_therapist_name}</td>
                  <td style={s.td}>{formatKES(c.session_fee_kes)}</td>
                  <td style={{ ...s.td, fontWeight: 600, color: 'var(--color-accent)' }}>{formatKES(c.commission_kes)}</td>
                  <td style={s.td}>
                    <span className={`badge ${c.status === 'paid' ? 'badge--active' : c.status === 'reversed' ? 'badge--banned' : 'badge--review'}`} style={{ fontSize: 10 }}>
                      {c.status}
                    </span>
                  </td>
                  <td style={{ ...s.td, color: 'var(--color-text-muted)', fontSize: 12 }}>{formatEAT(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const s = {
  wrap:        { padding: '0 0 48px' },
  loading:     { padding: 32, color: 'var(--color-text-muted)', fontSize: 14 },
  heading:     { fontSize: 22, fontWeight: 700, marginBottom: 20, color: 'var(--color-text-primary)' },
  sectionTitle:{ fontSize: 15, fontWeight: 700, marginBottom: 12, color: 'var(--color-text-primary)' },
  stateCard:   { padding: '48px 40px', maxWidth: 480, margin: '40px auto', textAlign: 'center' },
  stateTitle:  { fontSize: 20, fontWeight: 700, marginBottom: 12, color: 'var(--color-text-primary)' },
  stateSub:    { fontSize: 14, color: 'var(--color-text-muted)', lineHeight: 1.7, margin: 0 },
  statsRow:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 24 },
  statCard:    { padding: '16px 18px' },
  empty:       { padding: '20px 24px', marginBottom: 24 },
  th:          { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' },
  td:          { padding: '11px 16px', fontSize: 13, color: 'var(--color-text-primary)' },
  docBox:      { height: 360, border: '1px solid var(--color-card-border)', borderRadius: 8, marginBottom: 16, overflow: 'hidden', background: '#f9f9f9' },
  fsBtn:       { position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.45)', color: '#fff', border: 'none', borderRadius: 4, width: 28, height: 28, fontSize: 15, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  error:       { background: 'rgba(179,92,92,0.08)', border: '1px solid rgba(179,92,92,0.25)', borderRadius: 6, padding: '9px 12px', fontSize: 13, color: 'var(--color-status-open)', marginBottom: 14 },
};
