import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, CalendarBlank, Clock, NotePencil, ArrowCounterClockwise } from '@phosphor-icons/react';
import client from '../api/client';
import { groupNotesByType } from '../utils/notesUtils';

function formatEAT(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-KE', {
      timeZone: 'Africa/Nairobi',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-KE', {
      timeZone: 'Africa/Nairobi',
      day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch { return iso; }
}

function StatusBadge({ status }) {
  return <span className={`badge badge--${(status || 'pending').toLowerCase()}`}>{status}</span>;
}

function FormatBadge({ format }) {
  return <span className={`badge badge--${(format || 'text').toLowerCase()}`}>{format || 'text'}</span>;
}

const NOTE_TYPE_OPTIONS = [
  { value: 'pre',       label: 'Pre-session' },
  { value: 'session',   label: 'Session' },
  { value: 'follow_up', label: 'Follow-up' },
];

function ClientDetailPanel({ memberUserId, onClose }) {
  const [data, setData]               = useState(null);
  const [loading, setLoading]         = useState(true);
  const [editingNote, setEditingNote] = useState(null);
  const [editText, setEditText]       = useState('');
  const [editType, setEditType]       = useState('session');
  const [saving, setSaving]           = useState(false);
  const [addText, setAddText]         = useState('');
  const [addType, setAddType]         = useState('follow_up');
  const [addSaving, setAddSaving]     = useState(false);
  const [error, setError]             = useState('');

  useEffect(() => {
    client.get(`/api/therapy/therapist/clients/${memberUserId}`)
      .then((r) => setData(r.data))
      .catch(() => setError('Failed to load client history.'))
      .finally(() => setLoading(false));
  }, [memberUserId]);

  const completedBookings = data?.bookings?.filter((b) => b.status === 'completed') || [];
  const lastCompleted     = completedBookings[completedBookings.length - 1];
  const firstSession      = data?.bookings?.[data.bookings.length - 1];

  async function saveEdit() {
    if (!editText.trim()) return;
    setSaving(true);
    try {
      await client.patch(`/api/therapy/session-notes/${editingNote.id}`, {
        content: editText.trim(),
        note_type: editType,
      });
      setData((prev) => ({
        ...prev,
        bookings: prev.bookings.map((b) => ({
          ...b,
          notes: (b.notes || []).map((n) =>
            n.id === editingNote.id ? { ...n, content: editText.trim(), note_type: editType } : n
          ),
        })),
      }));
      setEditingNote(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  async function addNote() {
    if (!addText.trim() || !lastCompleted) return;
    setAddSaving(true);
    setError('');
    try {
      const res = await client.post('/api/therapy/session-notes', {
        booking_id: lastCompleted.id,
        content:    addText.trim(),
        note_type:  addType,
      });
      const newNote = { id: res.data.id, note_type: addType, content: addText.trim(), created_at: new Date().toISOString() };
      setData((prev) => ({
        ...prev,
        bookings: prev.bookings.map((b) =>
          b.id === lastCompleted.id ? { ...b, notes: [...(b.notes || []), newNote] } : b
        ),
      }));
      setAddText('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save note.');
    } finally {
      setAddSaving(false);
    }
  }

  return (
    <>
      <motion.div
        className="panel-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        className="slide-panel"
        style={{ width: 520 }}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
      >
        <div className="slide-panel__header">
          <span className="slide-panel__title">
            {loading ? 'Loading…' : (data?.client?.alias || 'Client')}
          </span>
          <button className="btn btn--ghost btn--sm" onClick={onClose} style={{ padding: '4px 8px' }}>
            <X size={16} />
          </button>
        </div>

        <div className="slide-panel__body">
          {loading ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Loading client history…</div>
          ) : error && !data ? (
            <div className="error-text">{error}</div>
          ) : (
            <>
              {/* Summary stats */}
              <div className="stat-row mb-20">
                <div>
                  <div className="stat-row__item__label">First session</div>
                  <div className="stat-row__item__value">{formatDate(firstSession?.scheduled_at)}</div>
                </div>
                <div>
                  <div className="stat-row__item__label">Total sessions</div>
                  <div className="stat-row__item__value">{data?.bookings?.length || 0}</div>
                </div>
              </div>

              {/* Session history with per-booking notes */}
              <div className="mb-24">
                <div className="uppercase-label mb-10">Session history</div>
                {(data?.bookings || []).length === 0 ? (
                  <div className="text-sm text-muted">No sessions yet.</div>
                ) : (
                  <div className="flex-col gap-12">
                    {(data?.bookings || []).map((b) => {
                      const groups = groupNotesByType(b.notes || []);
                      return (
                        <div key={b.id} className="note-card">
                          {/* Booking header */}
                          <div className="flex items-center gap-8 flex-wrap mb-6">
                            <span className="text-sm fw-500">{formatDate(b.scheduled_at)}</span>
                            <FormatBadge format={b.format} />
                            <StatusBadge status={b.status} />
                            {b.duration_minutes && (
                              <span className="text-xs text-muted">{b.duration_minutes} min</span>
                            )}
                          </div>

                          {/* Notes grouped by type */}
                          {groups.length > 0 && (
                            <div className="flex-col gap-10 mt-8">
                              {groups.map((g) => (
                                <div key={g.type}>
                                  <div style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    letterSpacing: '0.06em',
                                    textTransform: 'uppercase',
                                    color: 'var(--color-text-muted)',
                                    marginBottom: 6,
                                  }}>
                                    {g.label}
                                  </div>
                                  <div className="flex-col gap-6">
                                    {g.notes.map((n) => (
                                      <div key={n.id} style={{
                                        background: 'var(--color-main-bg)',
                                        borderRadius: 6,
                                        padding: '8px 10px',
                                      }}>
                                        {editingNote?.id === n.id ? (
                                          <>
                                            <div className="flex gap-6 mb-8">
                                              {NOTE_TYPE_OPTIONS.map((o) => (
                                                <button key={o.value} type="button"
                                                  className={`btn btn--xs ${editType === o.value ? 'btn--accent' : 'btn--ghost'}`}
                                                  onClick={() => setEditType(o.value)}
                                                >{o.label}</button>
                                              ))}
                                            </div>
                                            <textarea
                                              value={editText}
                                              onChange={(e) => setEditText(e.target.value)}
                                              style={{ minHeight: 80, marginBottom: 8 }}
                                            />
                                            <div className="flex gap-8">
                                              <button className="btn btn--primary btn--xs" disabled={saving} onClick={saveEdit}>
                                                {saving ? 'Saving…' : 'Save'}
                                              </button>
                                              <button className="btn btn--ghost btn--xs" onClick={() => setEditingNote(null)}>Cancel</button>
                                            </div>
                                          </>
                                        ) : (
                                          <>
                                            <div className="flex items-center gap-8 mb-4">
                                              <span className="text-xs text-muted">{formatEAT(n.created_at)}</span>
                                              <button
                                                className="btn btn--ghost btn--xs ml-auto"
                                                onClick={() => { setEditingNote(n); setEditText(n.content); setEditType(n.note_type); }}
                                              >Edit</button>
                                            </div>
                                            <p className="text-sm pre-wrap" style={{ margin: 0 }}>{n.content}</p>
                                          </>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Add note — attaches to most recent completed booking */}
              {lastCompleted && (
                <div>
                  <div className="uppercase-label mb-4">Add note</div>
                  <div className="text-xs text-muted mb-10">
                    Attaches to session on {formatDate(lastCompleted.scheduled_at)}
                  </div>
                  <div className="flex gap-6 mb-10">
                    {NOTE_TYPE_OPTIONS.map((o) => (
                      <button key={o.value} type="button"
                        className={`btn btn--xs ${addType === o.value ? 'btn--accent' : 'btn--ghost'}`}
                        onClick={() => setAddType(o.value)}
                      >{o.label}</button>
                    ))}
                  </div>
                  <textarea
                    value={addText}
                    onChange={(e) => setAddText(e.target.value)}
                    placeholder="Write a note…"
                    style={{ minHeight: 100, marginBottom: 8 }}
                  />
                  {error && <div className="error-text mb-8">{error}</div>}
                  <button
                    className="btn btn--primary btn--sm"
                    disabled={addSaving || !addText.trim()}
                    onClick={addNote}
                  >
                    {addSaving ? 'Saving…' : 'Save Note'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>
    </>
  );
}

export default function ClientsTab() {
  const [clients, setClients]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState(null);
  const [nudged, setNudged]     = useState({});

  async function sendNudge(e, memberId) {
    e.stopPropagation();
    try {
      await client.post(`/api/therapy/therapist/clients/${memberId}/nudge`);
      setNudged((prev) => ({ ...prev, [memberId]: true }));
      setTimeout(() => setNudged((prev) => ({ ...prev, [memberId]: false })), 3000);
    } catch {}
  }

  useEffect(() => {
    client.get('/api/therapy/therapist/clients')
      .then((r) => setClients(r.data.clients || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <AnimatePresence>
        {selected && (
          <ClientDetailPanel
            key={selected}
            memberUserId={selected}
            onClose={() => setSelected(null)}
          />
        )}
      </AnimatePresence>

      <div className="page-header">
        <div>
          <h1 className="page-title">Clients</h1>
          <p className="page-subtitle">Your full client history across all sessions</p>
        </div>
      </div>

      {loading ? (
        <div className="loading">Loading clients…</div>
      ) : clients.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">👥</div>
          <div className="empty-text">No completed sessions yet</div>
        </div>
      ) : (
        <div className="flex-col gap-10">
          {clients.map((c) => (
            <motion.div
              key={c.member_user_id}
              className="card"
              style={{ padding: '16px 20px', cursor: 'pointer' }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 280, damping: 26 }}
              onClick={() => setSelected(c.member_user_id)}
            >
              <div className="flex items-center gap-12">
                <div className="flex-1">
                  <div className="flex items-center gap-8 mb-6">
                    <span className="fw-600" style={{ fontSize: 15 }}>{c.alias || 'Member'}</span>
                    {c.total_sessions > 1 && (
                      <span className="badge badge--session-n" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ArrowCounterClockwise size={11} weight="bold" />
                        Returning
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-16 text-sm" style={{ color: 'var(--color-text-muted)' }}>
                    <span className="flex items-center gap-4">
                      <CalendarBlank size={13} />
                      {c.total_sessions} session{c.total_sessions !== 1 ? 's' : ''}
                    </span>
                    <span className="flex items-center gap-4">
                      <Clock size={13} />
                      {formatDate(c.last_session_at)}
                    </span>
                    {c.note_count > 0 && (
                      <span className="flex items-center gap-4">
                        <NotePencil size={13} />
                        {c.note_count} note{c.note_count !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-8 shrink-0">
                  <FormatBadge format={c.last_session_format} />
                  <button
                    type="button"
                    className="btn btn--ghost btn--xs"
                    style={{ fontSize: 11, padding: '3px 8px', whiteSpace: 'nowrap' }}
                    onClick={(e) => sendNudge(e, c.member_user_id)}
                  >
                    {nudged[c.member_user_id] ? 'Sent ✓' : 'Get the App'}
                  </button>
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 18, lineHeight: 1 }}>›</span>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
