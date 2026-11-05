import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import client from '../api/client';

const STEPS = ['Agreement', 'Your details', 'Sign'];

const MOTIVATIONAL = [
  "You're one step away from making a real difference.",
  "Thousands of people are looking for someone like you.",
  "Your expertise could be the turning point for someone today.",
];

export default function TherapistJoinScreen() {
  const params  = new URLSearchParams(window.location.search);
  const refCode = params.get('ref') || '';

  const [step,       setStep]       = useState(0);
  const [referrer,   setReferrer]   = useState(null);   // { valid, referrer_name }
  const [refChecked, setRefChecked] = useState(false);

  // Form state
  const [agreed,    setAgreed]    = useState(false);
  const [name,      setName]      = useState('');
  const [email,     setEmail]     = useState('');
  const [phone,     setPhone]     = useState('');
  const [profBody,  setProfBody]  = useState('');
  const [regNumber, setRegNumber] = useState('');
  const [message,   setMessage]   = useState('');
  const [sigName,   setSigName]   = useState('');
  const [sigAgreed, setSigAgreed] = useState(false);

  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [submitted, setSubmitted] = useState(false);

  const docBoxRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Resolve referral code on mount
  useEffect(() => {
    if (!refCode) { setRefChecked(true); return; }
    client.get(`/api/therapy/referral-code/${refCode}`)
      .then(r => setReferrer(r.data))
      .catch(() => setReferrer({ valid: false }))
      .finally(() => setRefChecked(true));
  }, [refCode]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (sigName.trim().toLowerCase() !== name.trim().toLowerCase()) {
      setError('Signature name must match your full legal name exactly.');
      return;
    }
    if (!sigAgreed) {
      setError('Please confirm your electronic signature.');
      return;
    }

    setLoading(true);
    try {
      await client.post('/api/therapy/referral-applications', {
        full_legal_name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        signature_name: sigName.trim(),
        professional_body: profBody.trim() || undefined,
        reg_number: regNumber.trim() || undefined,
        message: message.trim() || undefined,
        ref_code: referrer?.valid ? refCode : undefined,
        doc_version: 'v1',
      });
      setSubmitted(true);
    } catch (err) {
      const code = err?.response?.data?.code;
      if (code === 'DUPLICATE') {
        setError(err.response.data.error);
      } else {
        setError(err?.response?.data?.error || 'Submission failed — please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  if (!refChecked) return null; // wait for referrer check before rendering

  if (submitted) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8, color: 'var(--color-text-primary)' }}>
              Application received
            </h2>
            <p style={{ fontSize: 14, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
              We'll contact you at <strong>{email}</strong> within 2 business days.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🩺</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            Join PeerPal
          </div>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginTop: 4 }}>
            {MOTIVATIONAL[step]}
          </div>
        </div>

        {/* Referrer banner */}
        {refCode && referrer?.valid && (
          <div style={styles.banner('rgba(194,164,138,0.15)', '#8a6a4a')}>
            👋 You were referred by <strong>{referrer.referrer_name}</strong>
          </div>
        )}
        {refCode && !referrer?.valid && (
          <div style={styles.banner('rgba(179,92,92,0.08)', 'var(--color-status-open)')}>
            This referral link is not valid — you can still apply directly.
          </div>
        )}

        {/* Step indicator */}
        <div style={styles.stepRow}>
          {STEPS.map((label, i) => (
            <div key={i} style={styles.stepItem(i === step, i < step)}>
              <div style={styles.stepDot(i === step, i < step)}>
                {i < step ? '✓' : i + 1}
              </div>
              <span style={{ fontSize: 11 }}>{label}</span>
            </div>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.18 }}
          >
            {/* ── Step 0: Agreement ── */}
            {step === 0 && (
              <div>
                <div ref={docBoxRef} style={{ ...styles.docBox, position: 'relative' }}>
                  <iframe
                    src="/therapist-agreement.pdf"
                    title="PeerPal Therapist Agreement"
                    style={{ width: '100%', height: '100%', border: 'none', borderRadius: 6 }}
                  />
                  <button
                    type="button"
                    title={isFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
                    onClick={() => isFullscreen ? document.exitFullscreen() : docBoxRef.current?.requestFullscreen()}
                    style={styles.fsBtn}
                  >
                    {isFullscreen ? '✕' : '⛶'}
                  </button>
                </div>
                <label style={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={e => setAgreed(e.target.checked)}
                    style={{ marginRight: 8, accentColor: 'var(--color-accent)' }}
                  />
                  <span style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
                    I have read and understood the Therapist Agreement
                  </span>
                </label>
                <button
                  className="btn btn--primary"
                  disabled={!agreed}
                  onClick={() => setStep(1)}
                  style={styles.fullBtn}
                >
                  Continue
                </button>
              </div>
            )}

            {/* ── Step 1: Details ── */}
            {step === 1 && (
              <form onSubmit={e => { e.preventDefault(); setStep(2); }}>
                <div className="form-group">
                  <label className="form-label">Full legal name <span style={{ color: 'var(--color-status-open)' }}>*</span></label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="As it appears on your ID"
                    required
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Email address <span style={{ color: 'var(--color-status-open)' }}>*</span></label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Phone / M-Pesa number <span style={{ color: 'var(--color-status-open)' }}>*</span></label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder="0712 345 678"
                    required
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Professional body</label>
                    <input
                      type="text"
                      value={profBody}
                      onChange={e => setProfBody(e.target.value)}
                      placeholder="e.g. KPA, KCPA"
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Registration no.</label>
                    <input
                      type="text"
                      value={regNumber}
                      onChange={e => setRegNumber(e.target.value)}
                      placeholder="e.g. KPA/0001"
                    />
                  </div>
                </div>
                <div className="form-group" style={{ marginTop: 12 }}>
                  <label className="form-label">Brief message <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(optional)</span></label>
                  <textarea
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    placeholder="Anything you'd like us to know"
                    maxLength={500}
                    rows={3}
                    style={{ resize: 'vertical' }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)', textAlign: 'right', marginTop: 2 }}>
                    {message.length}/500
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                  <button type="button" className="btn btn--ghost" onClick={() => setStep(0)} style={{ flex: 1 }}>
                    Back
                  </button>
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={!name.trim() || !email.trim() || !phone.trim()}
                    style={{ flex: 2 }}
                  >
                    Continue
                  </button>
                </div>
              </form>
            )}

            {/* ── Step 2: Sign ── */}
            {step === 2 && (
              <form onSubmit={handleSubmit}>
                <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
                  By signing below you agree to the PeerPal Therapist Agreement.
                </p>
                <div className="form-group">
                  <label className="form-label">
                    Type your full legal name as your electronic signature
                  </label>
                  <input
                    type="text"
                    value={sigName}
                    onChange={e => setSigName(e.target.value)}
                    placeholder={name || 'Your full legal name'}
                    required
                    autoFocus
                    style={{
                      fontFamily: 'Georgia, serif',
                      fontSize: 16,
                      letterSpacing: 0.5,
                    }}
                  />
                  {sigName && sigName.trim().toLowerCase() !== name.trim().toLowerCase() && (
                    <div style={{ fontSize: 12, color: 'var(--color-status-open)', marginTop: 4 }}>
                      Must match: {name}
                    </div>
                  )}
                </div>
                <label style={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={sigAgreed}
                    onChange={e => setSigAgreed(e.target.checked)}
                    style={{ marginRight: 8, accentColor: 'var(--color-accent)' }}
                  />
                  <span style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
                    I confirm this is my electronic signature and I agree to all documents above
                  </span>
                </label>
                <div style={{
                  fontSize: 11,
                  color: 'var(--color-text-muted)',
                  margin: '12px 0 16px',
                  lineHeight: 1.5,
                  borderTop: '1px solid var(--color-card-border)',
                  paddingTop: 10,
                }}>
                  Submitted {new Date().toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })} · constitutes a legally binding electronic signature under the Electronic Transactions Act 2007 (Kenya)
                </div>

                {error && (
                  <div style={styles.errorBox}>
                    {error}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="button" className="btn btn--ghost" onClick={() => setStep(1)} style={{ flex: 1 }}>
                    Back
                  </button>
                  <button
                    type="submit"
                    className="btn btn--primary"
                    disabled={loading || !sigName.trim() || !sigAgreed}
                    style={{ flex: 2 }}
                  >
                    {loading ? 'Submitting…' : 'Submit application'}
                  </button>
                </div>
              </form>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: 'var(--color-main-bg)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '32px 16px 48px',
  },
  card: {
    background: 'var(--color-card-bg)',
    borderRadius: 16,
    boxShadow: 'var(--shadow-modal)',
    padding: 'clamp(24px, 5vw, 40px)',
    width: '100%',
    maxWidth: 560,
  },
  docBox: {
    height: 340,
    border: '1px solid var(--color-card-border)',
    borderRadius: 8,
    marginBottom: 16,
    overflow: 'hidden',
    background: '#f9f9f9',
  },
  checkRow: {
    display: 'flex',
    alignItems: 'flex-start',
    marginBottom: 16,
    cursor: 'pointer',
  },
  fullBtn: {
    width: '100%',
    justifyContent: 'center',
    padding: '11px 14px',
    fontSize: 14,
  },
  stepRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 24,
  },
  stepItem: (active, done) => ({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    color: active ? 'var(--color-accent)' : done ? 'var(--color-text-muted)' : 'var(--color-card-border)',
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    flex: 1,
  }),
  stepDot: (active, done) => ({
    width: 24,
    height: 24,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 700,
    background: active ? 'var(--color-accent)' : done ? 'var(--color-text-muted)' : 'var(--color-card-border)',
    color: '#fff',
  }),
  banner: (bg, color) => ({
    background: bg,
    border: `1px solid ${color}33`,
    borderRadius: 8,
    padding: '10px 14px',
    fontSize: 13,
    color,
    marginBottom: 16,
  }),
  fsBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    background: 'rgba(0,0,0,0.45)',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    width: 28,
    height: 28,
    fontSize: 15,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  },
  errorBox: {
    background: 'rgba(179,92,92,0.08)',
    border: '1px solid rgba(179,92,92,0.25)',
    borderRadius: 6,
    padding: '9px 12px',
    fontSize: 13,
    color: 'var(--color-status-open)',
    marginBottom: 14,
  },
};
