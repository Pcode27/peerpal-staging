import { createContext, useContext, useState, useEffect } from 'react';
import client from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [therapist, setTherapist] = useState(null);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('pt_token');
    const user  = localStorage.getItem('pt_user');
    if (!token || !user) { setLoading(false); return; }
    let parsed;
    try { parsed = JSON.parse(user); } catch { setLoading(false); return; }
    // Hydrate immediately from cache so the UI isn't blank, then refresh
    // from the server to pick up onboarding_complete / is_verified / suspended
    // which may be missing in sessions created before Phase 42.
    setTherapist(parsed);
    client.get('/api/therapy/therapist/profile')
      .then((r) => {
        const profile = r.data.profile || {};
        setTherapist((prev) => {
          if (!prev) return prev;
          const updated = {
            ...prev,
            onboarding_complete: profile.onboarding_complete ?? prev.onboarding_complete ?? false,
            is_verified:        profile.is_verified ?? prev.is_verified ?? false,
            display_name:       profile.display_name || prev.display_name,
            suspended:          profile.suspended ?? prev.suspended ?? false,
          };
          localStorage.setItem('pt_user', JSON.stringify(updated));
          return updated;
        });
      })
      .catch(() => {
        // Token may be expired — leave the stale state; protected routes will
        // return 401 and the user will need to log in again.
      })
      .finally(() => setLoading(false));
  }, []);

  async function login(email, password) {
    const { data } = await client.post('/api/auth/login', { email, password });
    // Store token first so the profile fetch is authenticated
    localStorage.setItem('pt_token', data.token);
    // Profile fetch is the access gate — therapistAuth returns 403 if no profile exists.
    let profile = {};
    try {
      const pr = await client.get('/api/therapy/therapist/profile');
      profile = pr.data.profile || {};
    } catch (profileErr) {
      localStorage.removeItem('pt_token');
      throw new Error('This account does not have therapist access.');
    }
    const userData = {
      id:                 data.userId || data.id,
      alias:              data.alias,
      role:               data.role,
      suspended:          profile.suspended ?? false,
      display_name:       profile.display_name || data.alias,
      onboarding_complete: profile.onboarding_complete ?? false,
      is_verified:        profile.is_verified ?? false,
    };
    localStorage.setItem('pt_user', JSON.stringify(userData));
    setTherapist(userData);
    import('../utils/firebase').then(m => m.registerFCMToken()).catch(() => {});
  }

  function refreshProfile() {
    client.get('/api/therapy/therapist/profile').then((r) => {
      const profile = r.data.profile || {};
      setTherapist((prev) => {
        if (!prev) return prev;
        const updated = {
          ...prev,
          onboarding_complete: profile.onboarding_complete ?? prev.onboarding_complete,
          is_verified:        profile.is_verified ?? prev.is_verified,
          display_name:       profile.display_name || prev.display_name,
          suspended:          profile.suspended ?? prev.suspended,
        };
        localStorage.setItem('pt_user', JSON.stringify(updated));
        return updated;
      });
    }).catch(() => {});
  }

  async function logout() {
    client.post('/api/auth/logout').catch(() => {});
    localStorage.removeItem('pt_token');
    localStorage.removeItem('pt_user');
    setTherapist(null);
  }

  return (
    <AuthContext.Provider value={{ therapist, loading, login, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() { return useContext(AuthContext); }
