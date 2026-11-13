import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import client from '../../api/client';
import { isValidEmail } from '../../utils/validate';

export default function LoginScreen() {
  const { login, user } = useAuth();
  const navigate = useNavigate();

  // Already verified and logged in — send them into the app
  useEffect(() => {
    if (user?.email_verified) {
      client.get('/api/onboarding/status')
        .then(({ data: s }) => {
          if (!s.consent) navigate('/onboarding/consent', { replace: true });
          else if (!s.persona) navigate('/onboarding/persona', { replace: true });
          else if (!s.first_mood) navigate('/onboarding/first-mood', { replace: true });
          else navigate('/welcome', { replace: true });
        })
        .catch(() => navigate('/welcome', { replace: true }));
    }
  }, [user, navigate]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [cooldownEnd, setCooldownEnd] = useState(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [verificationPending, setVerificationPending] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;

  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Countdown ticker for soft cooldown
  useEffect(() => {
    if (!cooldownEnd) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((cooldownEnd - Date.now()) / 1000));
      setCooldownSeconds(remaining);
      if (remaining === 0) setCooldownEnd(null);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [cooldownEnd]);

  const inCooldown = Boolean(cooldownEnd && Date.now() < cooldownEnd);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!email || !password || inCooldown) return;
    if (!isValidEmail(email)) { setError('Please enter a valid email address.'); return; }
    setLoading(true);
    try {
      const { data } = await client.post('/api/auth/login', { email, password });
      login(data.token, { id: data.userId, alias: data.alias, role: data.role, email_verified: data.email_verified });

      if (!data.email_verified) {
        setVerificationPending(true);
        setLoading(false);
        return;
      }

      try {
        const { data: status } = await client.get('/api/onboarding/status');
        if (!status.consent) navigate('/onboarding/consent', { replace: true });
        else if (!status.persona) navigate('/onboarding/persona', { replace: true });
        else if (!status.first_mood) navigate('/onboarding/first-mood', { replace: true });
        else navigate('/welcome', { replace: true });
      } catch {
        // Login succeeded — token is stored. Navigate to welcome even if onboarding
        // status check fails due to a transient network error.
        navigate('/welcome', { replace: true });
      }
    } catch (err) {
      const code = err.response?.data?.code;
      const retryAfter = err.response?.data?.retry_after ?? 30;
      setFailedAttempts((n) => n + 1);

      if (err.response?.status === 429) {
        if (code === 'COOLDOWN') {
          setCooldownEnd(Date.now() + retryAfter * 1000);
        }
        setError("Having trouble? Take a breath — you can keep trying.");
      } else {
        if (err.response?.status === 401) {
          setError('Incorrect email or password.');
        } else {
          setError('Something went wrong. Please try again.');
        }
      }
    } finally {
      setLoading(false);
    }
  }

  const showSecondaryMsg = failedAttempts >= 10;

  return (
    <div className="screen screen--no-nav" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 'var(--space-xl) var(--space-lg)' }}>
      <div style={{ marginBottom: 'var(--space-xl)', textAlign: 'center' }}>
        <div className="wordmark" style={{ fontSize: 28, marginBottom: 'var(--space-sm)' }}>PeerPal</div>
        <h1 style={{ fontSize: 'var(--text-h2)', marginBottom: 'var(--space-xs)' }}>Welcome back</h1>
        <p style={{ fontSize: 14 }}>Sign in to continue</p>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setVerificationPending(false); }}
            placeholder="your@email.com"
            autoComplete="email"
          />
        </div>
        <div style={{ position: 'relative' }}>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            type={showPw ? 'text' : 'password'}
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
            autoComplete="current-password"
            style={{ paddingRight: 44 }}
          />
          <button type="button" onClick={() => setShowPw(v => !v)} style={{ position: 'absolute', right: 12, bottom: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--color-text-muted)' }} aria-label={showPw ? 'Hide password' : 'Show password'}>
            {showPw
              ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            }
          </button>
        </div>

        {verificationPending && (
          <div className="error-msg" style={{ textAlign: 'left' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Verification still pending</div>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              We've sent a new link to <strong>{email}</strong>. Check your inbox (and spam folder).
            </div>
            <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
              Signing in again will resend the link. If you keep having trouble, check your spam folder.
            </div>
          </div>
        )}

        {error && (
          <div className="error-msg">
            <div>{error}</div>
            {showSecondaryMsg && (
              <div style={{ marginTop: 6, fontSize: 13 }}>
                You can also{' '}
                <Link
                  to="/emergency-public"
                  style={{ color: 'var(--color-accent)', textDecoration: 'underline' }}
                >
                  access support without logging in
                </Link>
                .
              </div>
            )}
          </div>
        )}

        <button
          type="submit"
          className="btn btn--primary"
          disabled={loading || !email || !password || inCooldown}
        >
          {inCooldown
            ? `Try again in ${cooldownSeconds}s…`
            : loading
            ? 'Signing in…'
            : 'Sign In'}
        </button>
      </form>

      <div style={{ marginTop: 'var(--space-lg)', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
        <Link to="/recover" style={{ color: 'var(--color-accent)', textDecoration: 'none', fontSize: 14 }}>
          Forgot your password?
        </Link>
        <p style={{ fontSize: 14 }}>
          Don't have an account?{' '}
          <Link to="/register" style={{ color: 'var(--color-accent)', fontWeight: 600, textDecoration: 'none' }}>Sign up</Link>
        </p>
        <Link
          to="/emergency-public"
          style={{ fontSize: 13, color: 'var(--color-text-muted)', textDecoration: 'none' }}
        >
          Need help right now?
        </Link>
        {!isStandalone && installPrompt && (
          <button
            type="button"
            className="btn btn--muted"
            style={{ fontSize: 13 }}
            onClick={() => { installPrompt.prompt(); setInstallPrompt(null); }}
          >
            Get the App
          </button>
        )}
      </div>
    </div>
  );
}
