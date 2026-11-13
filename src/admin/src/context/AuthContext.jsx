import { createContext, useContext, useState, useEffect } from 'react';
import client from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [admin, setAdmin] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('mb_admin_token');
    const user  = localStorage.getItem('mb_admin_user');
    if (token && user) {
      try { setAdmin(JSON.parse(user)); } catch { /* ignore */ }
    }
    setLoading(false);
  }, []);

  async function login(email, password) {
    const { data } = await client.post('/api/auth/login', { email, password });
    if (data.role !== 'admin') {
      throw new Error('This account does not have admin access.');
    }
    localStorage.setItem('mb_admin_token', data.token);
    localStorage.setItem('mb_admin_user', JSON.stringify({ alias: data.alias, role: data.role }));
    setAdmin({ alias: data.alias, role: data.role });
    import('../utils/firebase').then(m => m.registerFCMToken()).catch(() => {});
  }

  async function logout() {
    client.post('/api/auth/logout').catch(() => {});
    localStorage.removeItem('mb_admin_token');
    localStorage.removeItem('mb_admin_user');
    setAdmin(null);
  }

  return (
    <AuthContext.Provider value={{ admin, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() { return useContext(AuthContext); }
