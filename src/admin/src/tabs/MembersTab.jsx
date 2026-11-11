import { useState } from 'react';
import { UsersThree, MagnifyingGlass } from '@phosphor-icons/react';
import client from '../api/client';

export default function MembersTab() {
  const [query,   setQuery]   = useState('');
  const [field,   setField]   = useState('email');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  async function handleSearch(e) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    setResults(null);
    try {
      const { data } = await client.get('/api/admin/members', { params: { [field]: q } });
      setResults(data.members);
    } catch (err) {
      setError(err.response?.data?.error || 'Search failed.');
    } finally {
      setLoading(false);
    }
  }

  async function handleGrantPeer(member) {
    if (!window.confirm(
      `Grant peer status to "${member.alias}" (${member.email})?\n\nThis allows them to receive peer session broadcasts immediately without completing the peer quiz.`
    )) return;
    try {
      await client.post(`/api/admin/members/${member.id}/grant-peer-status`);
      setResults((prev) => prev.map((m) => m.id === member.id ? { ...m, peer_quiz_done: true } : m));
    } catch (err) {
      alert(err.response?.data?.error || 'Grant peer status failed.');
    }
  }

  async function handleDeactivate(member) {
    if (!window.confirm(
      `Deactivate account "${member.alias}" (${member.email})?\n\nThe account will be blocked from signing in. All data is preserved. This action can be reversed by re-enabling the account directly in Supabase.`
    )) return;
    try {
      await client.delete(`/api/admin/members/${member.id}`);
      setResults((prev) => prev.map((m) => m.id === member.id ? { ...m, is_active: false } : m));
    } catch (err) {
      alert(err.response?.data?.error || 'Deactivate failed.');
    }
  }

  return (
    <div className="tab-content">
      <div className="tab-header">
        <div>
          <h2 className="tab-title">Members</h2>
          <p className="tab-subtitle">Find any user account by email or alias</p>
        </div>
      </div>

      <form onSubmit={handleSearch} className="members-search-form">
        <select
          value={field}
          onChange={(e) => setField(e.target.value)}
          className="members-select"
        >
          <option value="email">Email</option>
          <option value="alias">Alias</option>
        </select>
        <input
          type={field === 'email' ? 'email' : 'text'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={field === 'email' ? 'user@example.com' : 'SolarPanda53'}
          className="members-input"
        />
        <button type="submit" className="btn btn--primary btn--sm" disabled={loading || !query.trim()}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error && <div className="error-msg" style={{ marginBottom: 16 }}>{error}</div>}

      {loading && (
        <div>
          {[...Array(5)].map((_, i) => (
            <div key={i} className="skeleton skeleton-row" />
          ))}
        </div>
      )}

      {!loading && results !== null && results.length === 0 && (
        <div className="empty-state">
          <MagnifyingGlass size={40} className="empty-state__icon" />
          <p className="empty-state__title">No results</p>
          <p className="empty-state__sub">Try a different search term.</p>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Alias</th>
                <th>Email</th>
                <th>Role</th>
                <th>Verified</th>
                <th>Active</th>
                <th>Peer</th>
                <th>Credits</th>
                <th>Joined</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {results.map((m) => (
                <tr key={m.id}>
                  <td className="alias">{m.alias}</td>
                  <td className="text-sm">{m.email}</td>
                  <td>
                    <span className={`role-badge role-badge--${m.role}`}>{m.role}</span>
                  </td>
                  <td>
                    {m.email_verified
                      ? '✓'
                      : <span className="text-muted" style={{ color: 'var(--color-warning)' }}>Pending</span>
                    }
                  </td>
                  <td>
                    {m.is_active ? 'Yes' : <span style={{ color: 'var(--color-danger)' }}>No</span>}
                  </td>
                  <td>
                    {m.peer_quiz_done
                      ? <span className="role-badge role-badge--peer">Peer</span>
                      : <span className="text-muted">—</span>}
                  </td>
                  <td>{m.credit_balance ?? '—'}</td>
                  <td className="elapsed">{new Date(m.created_at).toLocaleDateString()}</td>
                  <td>
                    {m.role === 'member' ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {!m.peer_quiz_done && (
                          <button
                            className="btn btn--primary btn--sm"
                            onClick={() => handleGrantPeer(m)}
                            title="Grant peer status without quiz"
                          >
                            Grant Peer
                          </button>
                        )}
                        <button
                          className="btn btn--danger btn--sm"
                          onClick={() => handleDeactivate(m)}
                          disabled={!m.is_active}
                          title={m.is_active ? 'Deactivate this account' : 'Already inactive'}
                        >
                          {m.is_active ? 'Deactivate' : 'Inactive'}
                        </button>
                      </div>
                    ) : (
                      <span className="text-sm text-muted">
                        Use {m.role === 'therapist' ? 'Therapists' : 'N/A'} tab
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && results === null && (
        <div className="empty-state">
          <UsersThree size={40} className="empty-state__icon" />
          <p className="empty-state__title">No members found</p>
          <p className="empty-state__sub">Search by email or alias to get started.</p>
        </div>
      )}
    </div>
  );
}
