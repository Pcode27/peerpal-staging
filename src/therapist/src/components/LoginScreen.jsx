import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import client from '../api/client';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ErrorBox({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      background: 'rgba(179,92,92,0.08)',
      border: '1px solid rgba(179,92,92,0.25)',
      borderRadius: 6,
      padding: '9px 12px',
      fontSize: 13,
      color: 'var(--color-status-open)',
      marginBottom: 16,
    }}>
      {msg}
    </div>
  );
}

function ForgotPasswordView({ onBack }) {
  const [email,   setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const [sent,    setSent]    = useState(false);
  const [error,   setError]   = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await client.post('/api/auth/recover', { email });
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div style={{ textAlign: 'center', padding: '8px 0' }}>
        <div style={{ fontSize: 28, marginBottom: 12 }}>📬</div>
        <p style={{ fontSize: 14, color: 'var(--color-text-primary)', marginBottom: 6 }}>
          Check your inbox
        </p>
        <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 24, lineHeight: 1.5 }}>
          If that email is registered, a password reset link has been sent. Check your spam folder if it doesn't arrive within a few minutes.
        </p>
        <button className="btn btn--ghost" onClick={onBack} style={{ fontSize: 13 }}>
          ← Back to sign in
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 20, lineHeight: 1.5 }}>
        Enter your email and we'll send a link to reset your password.
      </p>
      <div className="form-group" style={{ marginBottom: error ? 8 : 20 }}>
        <label className="form-label">Email address</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="therapist@example.com"
          required
          autoFocus
        />
      </div>
      <ErrorBox msg={error} />
      <button
        type="submit"
        className="btn btn--primary"
        disabled={loading}
        style={{ width: '100%', justifyContent: 'center', padding: '11px 14px', fontSize: 14 }}
      >
        {loading ? 'Sending…' : 'Send reset link'}
      </button>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={onBack}
        style={{ width: '100%', justifyContent: 'center', marginTop: 10, fontSize: 13 }}
      >
        ← Back to sign in
      </button>
    </form>
  );
}

export default function LoginScreen() {
  const { login }                   = useAuth();
  const [email, setEmail]           = useState('');
  const [password, setPassword]     = useState('');
  const [showPw, setShowPw]         = useState(false);
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;

  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!EMAIL_RE.test(email)) { setError('Enter a valid email address.'); return; }
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      if (err.message === 'This account does not have therapist access.') {
        setError(err.message);
      } else if (err.response?.status === 401) {
        setError('Incorrect email or password.');
      } else if (err.response?.status === 400 && err.response.data?.code === 'INVALID_EMAIL') {
        setError('Enter a valid email address.');
      } else if (!err.response) {
        setError('Could not reach the server. Make sure the backend is running and try again.');
      } else {
        setError(err.response.data?.error || 'Login failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-brand">
          <div className="login-brand-icon">🩺</div>
          <div>
            <div className="login-title">PeerPal Therapist Portal</div>
            <div className="login-sub">
              {showForgot ? 'Password reset' : 'Professional access only'}
            </div>
          </div>
        </div>

        {showForgot ? (
          <ForgotPasswordView onBack={() => setShowForgot(false)} />
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Email address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="therapist@example.com"
                required
                autoFocus
              />
            </div>
            <div className="form-group" style={{ marginBottom: error ? 8 : 4 }}>
              <label className="form-label">Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  style={{ paddingRight: 44 }}
                />
                <button type="button" onClick={() => setShowPw(v => !v)} style={{ position: 'absolute', right: 12, bottom: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--color-text-muted)' }} aria-label={showPw ? 'Hide password' : 'Show password'}>
                  {showPw
                    ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  }
                </button>
              </div>
            </div>

            <div style={{ textAlign: 'right', marginBottom: 16 }}>
              <button
                type="button"
                onClick={() => setShowForgot(true)}
                style={{
                  background: 'none', border: 'none', padding: 0,
                  fontSize: 12, color: 'var(--color-text-muted)',
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                Forgot password?
              </button>
            </div>

            <ErrorBox msg={error} />

            <button
              type="submit"
              className="btn btn--primary"
              disabled={loading}
              style={{ width: '100%', justifyContent: 'center', padding: '11px 14px', fontSize: 14 }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        <p style={{ marginTop: 20, fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
          This portal is for registered PeerPal therapists only.
        </p>
        {!isStandalone && installPrompt && (
          <button
            type="button"
            className="btn btn--ghost"
            style={{ width: '100%', justifyContent: 'center', marginTop: 10, fontSize: 13 }}
            onClick={() => { installPrompt.prompt(); setInstallPrompt(null); }}
          >
            Get the App
          </button>
        )}
      </div>
    </div>
  );
}
