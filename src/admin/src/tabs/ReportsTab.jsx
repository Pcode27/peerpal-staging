import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck } from '@phosphor-icons/react';
import client from '../api/client';

export default function ReportsTab({ onCountChange }) {
  const [items,   setItems]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [acting,  setActing]  = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await client.get('/api/admin/reports');
      const list = data.reports ?? [];
      setItems(list);
      onCountChange?.(list.length);
    } catch { setError('Failed to load reports.'); }
    finally   { setLoading(false); }
  }, [onCountChange]);

  useEffect(() => { load(); }, [load]);

  const groupReports = items.filter((r) => r.report_type === 'group');
  const peerReports  = items.filter((r) => r.report_type === 'peer');

  async function markReviewed(id) {
    try {
      await client.patch(`/api/admin/peer-reports/${id}/review`);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to mark reviewed.');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports Queue</h1>
          <p className="page-subtitle">Flagged content from groups and peer voice sessions</p>
        </div>
        <button className="refresh-btn" onClick={load} title="Refresh">↻</button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : items.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <ShieldCheck size={40} className="empty-state__icon" />
            <p className="empty-state__title">No open reports</p>
            <p className="empty-state__sub">The queue is clear.</p>
          </div>
        </div>
      ) : (
        <>
          {/* ── Group reports ── */}
          {groupReports.length > 0 && (
            <div className="card" style={{ marginBottom: 'var(--space-lg)' }}>
              <h2 style={{ fontSize: '0.9rem', fontWeight: 600, padding: '12px 16px 0', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Group chat · {groupReports.length}
              </h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th>Reported</th>
                      <th>Reporter</th>
                      <th>Reason</th>
                      <th>Message</th>
                      <th>Date</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupReports.map((r) => (
                      <tr key={r.id}>
                        <td>{r.group_name}</td>
                        <td><span className="alias">{r.reported_alias}</span></td>
                        <td><span className="alias" style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>{r.reporter_alias}</span></td>
                        <td><span className="badge badge--pending">{r.reason}</span></td>
                        <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: 'italic', color: 'var(--color-text-muted)' }}>
                          "{r.message_preview}"
                        </td>
                        <td><span className="elapsed">{new Date(r.created_at).toLocaleDateString()}</span></td>
                        <td>
                          <div className="btn-group">
                            <button className="btn btn--ghost btn--sm"   onClick={() => setActing({ report: r, action: 'dismiss' })}>Dismiss</button>
                            <button className="btn btn--warning btn--sm" onClick={() => setActing({ report: r, action: 'warn' })}>Warn</button>
                            <button className="btn btn--danger btn--sm"  onClick={() => setActing({ report: r, action: 'ban' })}>Ban</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Peer session reports ── */}
          {peerReports.length > 0 && (
            <div className="card">
              <h2 style={{ fontSize: '0.9rem', fontWeight: 600, padding: '12px 16px 0', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Peer voice/text · {peerReports.length}
              </h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th>Reported peer</th>
                      <th>Reporter</th>
                      <th>Reason</th>
                      <th>Date</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {peerReports.map((r) => (
                      <>
                        <tr key={r.id}>
                          <td>
                            <span className={`badge ${r.channel === 'voice' ? 'badge--pending' : ''}`} style={{ textTransform: 'capitalize' }}>
                              {r.channel || 'unknown'}
                            </span>
                          </td>
                          <td><span className="alias">{r.reported_alias || '—'}</span></td>
                          <td><span className="alias" style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>{r.reporter_alias}</span></td>
                          <td style={{ maxWidth: 240 }}>{r.description}</td>
                          <td><span className="elapsed">{new Date(r.created_at).toLocaleDateString()}</span></td>
                          <td>
                            <div className="btn-group">
                              {r.transcript && (
                                <button className="btn btn--ghost btn--sm" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                                  {expanded === r.id ? 'Hide transcript' : 'Transcript'}
                                </button>
                              )}
                              <button className="btn btn--success btn--sm" onClick={() => markReviewed(r.id)}>
                                Mark reviewed
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expanded === r.id && r.transcript && (
                          <tr key={`${r.id}-transcript`}>
                            <td colSpan={6} style={{ background: 'var(--color-bg-surface)', borderRadius: 'var(--radius-sm)', padding: '12px 16px' }}>
                              <p style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Session transcript</p>
                              <p style={{ fontSize: '0.88rem', lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'var(--color-text-primary)' }}>{r.transcript}</p>
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {acting && (
        <ActionModal
          report={acting.report}
          action={acting.action}
          onClose={() => setActing(null)}
          onDone={() => { setActing(null); load(); }}
        />
      )}
    </div>
  );
}

function ActionModal({ report, action, onClose, onDone }) {
  const [notes,  setNotes]  = useState('');
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  const labels   = { dismiss: 'Dismiss Report', warn: 'Warn User', ban: 'Ban User' };
  const btnClass = { dismiss: 'btn--ghost',      warn: 'btn--warning', ban: 'btn--danger' };

  async function handleConfirm() {
    setSaving(true);
    setError('');
    try {
      await client.patch(`/api/admin/reports/${report.id}/action`, {
        action,
        admin_notes: notes.trim() || undefined,
      });
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Action failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <p className="modal__title">{labels[action]}</p>
        <div className="modal__preview">
          <strong>Group:</strong> {report.group_name}<br />
          <strong>Reported user:</strong> <span className="alias">{report.reported_alias}</span><br />
          <strong>Reason:</strong> {report.reason}
          {report.message_preview && <><br /><strong>Message:</strong> <em>"{report.message_preview}"</em></>}
        </div>
        {action !== 'dismiss' && (
          <div className="form-group">
            <label className="form-label">
              {action === 'warn' ? 'Warning message (sent to user)' : 'Reason for ban'}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={action === 'warn' ? 'Warning message…' : 'Reason for ban…'}
              rows={3}
              autoFocus
            />
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="modal-footer">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className={`btn ${btnClass[action]}`} onClick={handleConfirm} disabled={saving}>
            {saving ? 'Working…' : `Confirm ${labels[action]}`}
          </button>
        </div>
      </div>
    </div>
  );
}
