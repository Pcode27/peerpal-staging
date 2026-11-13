import { useState, useEffect } from 'react';
import { Eye, EyeSlash } from '@phosphor-icons/react';
import { useAuth } from '../context/AuthContext';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginScreen() {
  const { login }              = useAuth();
  const [email, setEmail]      = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]    = useState(false);
  const [error, setError]      = useState('');
  const [loading, setLoading]  = useState(false);
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
      if (!err.response) {
        setError('Connection error. Check your internet and try again.');
      } else if (err.response.status === 401) {
        setError('Incorrect email or password.');
      } else if (err.response.status === 400 && err.response.data?.code === 'INVALID_EMAIL') {
        setError('Enter a valid email address.');
      } else {
        setError(err.response.data?.error || 'Login failed.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-box">
        <div className="login-brand">
          <div className="login-brand-icon">🧠</div>
          <div>
            <div className="login-title">PeerPal Admin</div>
            <div className="login-sub">Control panel — authorised access only</div>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Email address</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <div className="pw-field">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="pw-input"
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowPw(v => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
              >
                {showPw ? <EyeSlash size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="btn btn--primary btn--full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="login-footer">
          This panel is for authorised PeerPal administrators only.
        </p>
        {!isStandalone && installPrompt && (
          <button
            type="button"
            className="btn btn--ghost btn--full"
            style={{ marginTop: 10, fontSize: 13 }}
            onClick={() => { installPrompt.prompt(); setInstallPrompt(null); }}
          >
            Get the App
          </button>
        )}
      </div>
    </div>
  );
}
