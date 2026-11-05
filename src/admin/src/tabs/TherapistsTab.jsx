import { useEffect, useState, useCallback, useRef } from 'react';
import { Stethoscope, Folder } from '@phosphor-icons/react';
import client from '../api/client';

const SESSION_FORMATS  = ['video', 'in_person'];
const AVAILABILITY_OPT = ['available', 'limited', 'unavailable'];

const AVAIL_BADGE = {
  available:   { bg: 'var(--color-calm-bg)',    text: 'var(--color-calm)',    label: 'Available' },
  limited:     { bg: 'var(--color-warning-bg)', text: 'var(--color-warning)', label: 'Limited' },
  unavailable: { bg: 'var(--color-danger-bg)',  text: 'var(--color-danger)',  label: 'Unavailable' },
};

// ─── Main tab ─────────────────────────────────────────────────────────────────
export default function TherapistsTab() {
  const [therapists,    setTherapists]    = useState([]);
  const [categories,    setCategories]    = useState([]);
  const [applications,  setApplications]  = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  const [panel,         setPanel]         = useState(null); // { mode: 'edit'|'verify'|'category'|'application', data? }
  const [view,          setView]          = useState('therapists'); // 'therapists' | 'categories' | 'applications'

  const load = useCallback(async () => {
    try {
      const [tRes, cRes, aRes] = await Promise.all([
        client.get('/api/admin/therapists'),
        client.get('/api/admin/therapist-categories'),
        client.get('/api/admin/referral-applications'),
      ]);
      setTherapists(tRes.data.therapists ?? []);
      setCategories(cRes.data.categories ?? []);
      setApplications(aRes.data.applications ?? []);
    } catch { setError('Failed to load data.'); }
    finally   { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleAvailability(id, status) {
    try {
      await client.patch(`/api/admin/therapists/${id}/availability`, { availability_status: status });
      load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to update availability.'); }
  }

  async function handleToggleActive(id, current) {
    try {
      await client.patch(`/api/admin/therapists/${id}`, { is_active: !current });
      load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to update.'); }
  }

  async function handleUnsuspend(id) {
    if (!window.confirm('Unsuspend this therapist and set them back to Available?')) return;
    try {
      await client.patch(`/api/admin/therapists/${id}/unsuspend`);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to unsuspend.'); }
  }

  async function handleDelete(t) {
    if (!window.confirm(`Permanently delete ${t.display_name}? This removes their profile and login account. This cannot be undone.`)) return;
    try {
      await client.delete(`/api/admin/therapists/${t.id}`);
      load();
    } catch (err) { setError(err.response?.data?.error || 'Failed to delete.'); }
  }

  async function handleResetPassword(t) {
    try {
      const { data } = await client.post(`/api/admin/therapists/${t.id}/reset-password`);
      window.prompt(`Reset link for ${data.email} (valid 72 hrs) — copy this:`, `https://therapist.peer-pal.com?set_password=${data.reset_token}`);
    } catch (err) { setError(err.response?.data?.error || 'Failed to generate reset link.'); }
  }

  function categoryName(id) {
    return categories.find((c) => c.id === id)?.name ?? id;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Therapist Marketplace</h1>
          <p className="page-subtitle">Manage therapists, verification, and categories</p>
        </div>
        <div className="filter-row">
          <button
            className={`btn btn--sm ${view === 'therapists' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setView('therapists')}
          >
            Therapists
          </button>
          <button
            className={`btn btn--sm ${view === 'categories' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setView('categories')}
          >
            Categories
          </button>
          <button
            className={`btn btn--sm ${view === 'applications' ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => setView('applications')}
            style={{ position: 'relative' }}
          >
            Applications
            {applications.filter(a => a.status === 'pending').length > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -6,
                background: 'var(--color-danger, #e74c3c)', color: '#fff',
                borderRadius: '50%', width: 16, height: 16,
                fontSize: 10, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {applications.filter(a => a.status === 'pending').length}
              </span>
            )}
          </button>
          {view === 'therapists' && (
            <button className="btn btn--primary btn--sm" onClick={() => setPanel({ mode: 'edit', data: null })}>
              + Add Therapist
            </button>
          )}
          {view === 'categories' && (
            <button className="btn btn--primary btn--sm" onClick={() => setPanel({ mode: 'category', data: null })}>
              + Add Category
            </button>
          )}
          <button className="refresh-btn" onClick={load} title="Refresh">↻</button>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : view === 'categories' ? (
        <CategoriesTable
          categories={categories}
          onEdit={(cat) => setPanel({ mode: 'category', data: cat })}
        />
      ) : view === 'applications' ? (
        <ApplicationsTable
          applications={applications}
          onReview={(a) => setPanel({ mode: 'application', data: a })}
        />
      ) : (
        <TherapistsTable
          therapists={therapists}
          categories={categories}
          categoryName={categoryName}
          onAvailability={handleAvailability}
          onToggleActive={handleToggleActive}
          onUnsuspend={handleUnsuspend}
          onEdit={(t) => setPanel({ mode: 'edit', data: t })}
          onVerify={(t) => setPanel({ mode: 'verify', data: t })}
          onSuspend={(t) => setPanel({ mode: 'suspend', data: t })}
          onDocuments={(t) => setPanel({ mode: 'documents', data: t })}
          onDelete={handleDelete}
          onResetPassword={handleResetPassword}
        />
      )}

      {panel?.mode === 'edit' && (
        <TherapistPanel
          therapist={panel.data}
          categories={categories}
          onClose={() => setPanel(null)}
          onSaved={() => { setPanel(null); load(); }}
        />
      )}
      {panel?.mode === 'verify' && (
        <VerifyPanel
          therapist={panel.data}
          onClose={() => setPanel(null)}
          onSaved={() => { setPanel(null); load(); }}
        />
      )}
      {panel?.mode === 'suspend' && (
        <SuspendPanel
          therapist={panel.data}
          onClose={() => setPanel(null)}
          onSaved={() => { setPanel(null); load(); }}
        />
      )}
      {panel?.mode === 'category' && (
        <CategoryPanel
          category={panel.data}
          onClose={() => setPanel(null)}
          onSaved={() => { setPanel(null); load(); }}
        />
      )}
      {panel?.mode === 'documents' && (
        <DocumentsPanel
          therapist={panel.data}
          onClose={() => setPanel(null)}
        />
      )}
      {panel?.mode === 'application' && (
        <ApplicationPanel
          application={panel.data}
          onClose={() => setPanel(null)}
          onSaved={() => { setPanel(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Therapists table ─────────────────────────────────────────────────────────
function TherapistsTable({ therapists, categories, categoryName, onAvailability, onToggleActive, onUnsuspend, onEdit, onVerify, onSuspend, onDocuments, onDelete, onResetPassword }) {
  if (!therapists.length) {
    return (
      <div className="card">
        <div className="empty-state">
          <Stethoscope size={40} className="empty-state__icon" />
          <p className="empty-state__title">No therapists yet</p>
          <p className="empty-state__sub">Add a therapist to get started.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Therapist</th>
              <th>Verification</th>
              <th>Categories</th>
              <th>Rate (KES)</th>
              <th>Formats</th>
              <th>Availability</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {therapists.map((t) => {
              const av = AVAIL_BADGE[t.availability_status] || AVAIL_BADGE.unavailable;
              const isSuspended = t.suspended;
              const isVerified  = t.is_verified;

              return (
                <tr key={t.user_id_fallback || t.id} style={{ opacity: t.is_active ? 1 : 0.5 }}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {t.photo_url ? (
                        <img src={t.photo_url} alt={t.display_name}
                          style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                      ) : (
                        <div style={{
                          width: 36, height: 36, borderRadius: '50%',
                          background: 'var(--color-surface-secondary)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)', flexShrink: 0,
                        }}>
                          {(t.display_name || t.email || '?').charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div>
                        <div style={{ fontWeight: 500, color: 'var(--color-text-primary)', fontSize: 14 }}>
                          {t.display_name || <span style={{ color: 'var(--color-warning, #f59e0b)', fontStyle: 'italic' }}>No profile — account only</span>}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t.credentials}</div>
                        <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{t.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${isVerified ? 'badge--active' : 'badge--review'}`} style={{ fontSize: 10 }}>
                      {isVerified ? '✓ Verified' : 'Pending'}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {(t.category_ids || []).slice(0, 2).map((id) => (
                        <span key={id} className="badge badge--review" style={{ fontSize: 10 }}>
                          {categoryName(id)}
                        </span>
                      ))}
                      {(t.category_ids || []).length > 2 && (
                        <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
                          +{t.category_ids.length - 2}
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ fontSize: 13, fontWeight: 500 }}>
                    {t.rate_per_session_kes ? `KES ${t.rate_per_session_kes.toLocaleString()}` : '—'}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    {(t.session_formats || []).join(', ') || '—'}
                  </td>
                  <td>
                    {/* Orphaned rows (no profile) have no tp.id — disable availability change */}
                    {isSuspended || t.profile_missing ? (
                      <span className="badge badge--banned" style={{ fontSize: 10 }}>
                        {isSuspended ? 'Suspended' : '—'}
                      </span>
                    ) : (
                      <select
                        style={{ fontSize: 12, padding: '3px 6px', borderRadius: 6,
                          background: av.bg, color: av.text, border: 'none', cursor: 'pointer' }}
                        value={t.availability_status}
                        onChange={(e) => onAvailability(t.id, e.target.value)}
                      >
                        {AVAILABILITY_OPT.map((a) => (
                          <option key={a} value={a}>{AVAIL_BADGE[a].label}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>
                    <button
                      className={`btn btn--sm ${t.is_active ? 'btn--success' : 'btn--ghost'}`}
                      onClick={() => onToggleActive(t.id, t.is_active)}
                      disabled={t.profile_missing}
                      style={{ fontSize: 11, padding: '0 8px', height: 28 }}
                    >
                      {t.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td>
                    {t.profile_missing ? (
                      // Orphaned auth user — no profile row, all profile actions are blocked.
                      // Use the Members tab to deactivate this account.
                      <span style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
                        Use Members tab
                      </span>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'nowrap' }}>
                        <button className="btn btn--ghost btn--sm" onClick={() => onEdit(t)} style={{ fontSize: 11 }}>
                          Edit
                        </button>
                        <button className="btn btn--ghost btn--sm" onClick={() => onDocuments(t)} style={{ fontSize: 11 }} title="Review uploaded documents">
                          Docs
                        </button>
                        {!isVerified && (
                          <button className="btn btn--primary btn--sm" onClick={() => onVerify(t)} style={{ fontSize: 11 }}>
                            Verify
                          </button>
                        )}
                        {isSuspended ? (
                          <button className="btn btn--success btn--sm" onClick={() => onUnsuspend(t.id)} style={{ fontSize: 11 }}>
                            Unsuspend
                          </button>
                        ) : (
                          <button className="btn btn--danger btn--sm" onClick={() => onSuspend(t)} style={{ fontSize: 11 }}>
                            Suspend
                          </button>
                        )}
                        <button className="btn btn--ghost btn--sm" onClick={() => onResetPassword(t)} style={{ fontSize: 11 }} title="Generate a password reset link">
                          Reset PW
                        </button>
                        <button className="btn btn--danger btn--sm" onClick={() => onDelete(t)} style={{ fontSize: 11, opacity: 0.75 }} title="Permanently delete therapist and their login">
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Categories table ─────────────────────────────────────────────────────────
function CategoriesTable({ categories, onEdit }) {
  if (!categories.length) {
    return (
      <div className="card">
        <div className="empty-state">
          <Folder size={40} className="empty-state__icon" />
          <p className="empty-state__title">No categories</p>
          <p className="empty-state__sub">No therapy categories configured yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Name</th>
              <th>Description</th>
              <th>Tags</th>
              <th>Active</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>{c.sort_order}</td>
                <td style={{ fontWeight: 500, fontSize: 14 }}>{c.name}</td>
                <td style={{ fontSize: 12, color: 'var(--color-text-secondary)', maxWidth: 240 }}>
                  {c.description || '—'}
                </td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                    {(c.condition_tags || []).slice(0, 4).map((tag) => (
                      <span key={tag} className="badge badge--review" style={{ fontSize: 10 }}>{tag}</span>
                    ))}
                  </div>
                </td>
                <td>
                  <span className={`badge ${c.is_active ? 'badge--active' : 'badge--banned'}`} style={{ fontSize: 10 }}>
                    {c.is_active ? 'Active' : 'Hidden'}
                  </span>
                </td>
                <td>
                  <button className="btn btn--ghost btn--sm" onClick={() => onEdit(c)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── TherapistPanel (add/edit) ────────────────────────────────────────────────
function TherapistPanel({ therapist, categories, onClose, onSaved }) {
  const isNew = !therapist;

  const [email,        setEmail]        = useState('');
  const [displayName,  setDisplayName]  = useState(therapist?.display_name ?? '');
  const [fullName,     setFullName]     = useState(therapist?.full_name ?? '');
  const [credentials,  setCredentials]  = useState(therapist?.credentials ?? '');
  const [yearsExp,     setYearsExp]     = useState(therapist?.years_experience ?? 0);
  const [languages,    setLanguages]    = useState((therapist?.languages ?? []).join(', '));
  const [sessionFmts,  setSessionFmts]  = useState(therapist?.session_formats ?? []);
  const [categoryIds,  setCategoryIds]  = useState(therapist?.category_ids ?? []);
  const [location,     setLocation]     = useState(therapist?.location ?? '');
  const [statement,    setStatement]    = useState(therapist?.statement ?? '');
  const [plainIntro,   setPlainIntro]   = useState(therapist?.plain_language_intro ?? '');
  const [culturalComps,setCulturalComps]= useState((therapist?.cultural_competencies ?? []).join(', '));
  const [approachPlain,setApproachPlain]= useState(therapist?.approach_plain ?? '');
  const [photoUrl,     setPhotoUrl]     = useState(therapist?.photo_url ?? '');
  const [availability, setAvailability] = useState(therapist?.availability_status ?? 'available');
  const [gender,       setGender]       = useState(therapist?.gender ?? '');
  const [rate,         setRate]         = useState(therapist?.rate_per_session_kes ?? 0);
  const [mpesa,        setMpesa]        = useState(therapist?.mpesa_number ?? '');
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState('');
  const [dirty,        setDirty]        = useState(false);

  function md(setter) { return (val) => { setter(val); setDirty(true); }; }

  function toggleFormat(f) {
    setSessionFmts((prev) => prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]);
    setDirty(true);
  }

  function toggleCategory(id) {
    setCategoryIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
    setDirty(true);
  }

  function handleClose() {
    if (dirty && !window.confirm('You have unsaved changes. Leave without saving?')) return;
    onClose();
  }

  async function handleSave() {
    if (!displayName.trim() || !credentials.trim()) {
      setError('Display name and credentials are required.');
      return;
    }
    if (isNew && (!email.trim() || !fullName.trim())) {
      setError('Email and full name are required for new therapists.');
      return;
    }
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (isNew && !EMAIL_RE.test(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    if (mpesa.trim() && !/^0[17]\d{8}$/.test(mpesa.trim())) {
      setError('M-Pesa number must be 10 digits starting with 07 or 01 (e.g. 0712345678).');
      return;
    }
    setSaving(true);
    setError('');
    const body = {
      display_name:          displayName.trim(),
      full_name:             fullName.trim(),
      credentials:           credentials.trim(),
      years_experience:      parseInt(yearsExp) || 0,
      languages:             languages.trim() ? languages.split(',').map((l) => l.trim()).filter(Boolean) : [],
      session_formats:       sessionFmts,
      category_ids:          categoryIds,
      location:              location.trim() || null,
      statement:             statement.trim() || null,
      plain_language_intro:  plainIntro.trim() || null,
      cultural_competencies: culturalComps.trim() ? culturalComps.split(',').map((c) => c.trim()).filter(Boolean) : [],
      approach_plain:        approachPlain.trim() || null,
      photo_url:             photoUrl.trim() || null,
      availability_status:   availability,
      gender:                gender || null,
      rate_per_session_kes:  parseInt(rate) || 0,
      mpesa_number:          mpesa.trim() || null,
    };
    try {
      if (isNew) {
        await client.post('/api/admin/therapists', { ...body, email: email.trim() });
      } else {
        await client.patch(`/api/admin/therapists/${therapist.id}`, body);
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay" onClick={handleClose} />
      <div className="slide-panel">
        <div className="slide-panel__header">
          <span className="slide-panel__title">{isNew ? 'Add Therapist' : 'Edit Therapist'}</span>
          <button className="btn btn--ghost btn--sm" onClick={handleClose}>✕</button>
        </div>

        <div className="slide-panel__body">
          {isNew && (
            <>
              <div className="form-group">
                <label className="form-label">Email address</label>
                <input type="email" value={email} onChange={(e) => md(setEmail)(e.target.value)} placeholder="therapist@example.com" />
              </div>
              <div className="form-group">
                <label className="form-label">Full legal name</label>
                <input type="text" value={fullName} onChange={(e) => md(setFullName)(e.target.value)} placeholder="Dr. Amina Hassan" />
              </div>
              <div style={{ background: 'var(--color-surface-secondary)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>
                ✉️ An invite email will be sent with a link to set their password. Expires in 72 hours.
              </div>
            </>
          )}

          <div className="form-group">
            <label className="form-label">Display name</label>
            <input type="text" value={displayName} onChange={(e) => md(setDisplayName)(e.target.value)} placeholder="Dr. Amina K." />
          </div>

          {isNew && (
            <div style={{ background: 'var(--color-surface-secondary)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>
              📋 The therapist will complete their bio, approach, languages, and documents themselves after accepting the invite.
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Credentials</label>
            <input type="text" value={credentials} onChange={(e) => md(setCredentials)(e.target.value)} placeholder="MA Clinical Psychology, KPS" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Rate per session (KES)</label>
              <input type="number" value={rate} onChange={(e) => md(setRate)(e.target.value)} min={0} placeholder="3500" />
            </div>
            {!isNew && (
              <div className="form-group">
                <label className="form-label">Gender</label>
                <select value={gender} onChange={(e) => md(setGender)(e.target.value)}>
                  <option value="">Not specified</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="non_binary">Non-binary</option>
                  <option value="prefer_not_to_say">Prefer not to say</option>
                </select>
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">M-Pesa number</label>
              <input type="text" value={mpesa} onChange={(e) => md(setMpesa)(e.target.value)} placeholder="0712345678" />
            </div>
            <div className="form-group">
              <label className="form-label">Availability</label>
              <select value={availability} onChange={(e) => md(setAvailability)(e.target.value)}>
                {AVAILABILITY_OPT.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          </div>

          {!isNew && (
            <div className="form-group">
              <label className="form-label">Photo URL (optional)</label>
              <input type="url" value={photoUrl} onChange={(e) => md(setPhotoUrl)(e.target.value)} placeholder="https://..." />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Session formats</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {SESSION_FORMATS.map((f) => (
                <button key={f} type="button" onClick={() => toggleFormat(f)}
                  className={`btn btn--sm ${sessionFmts.includes(f) ? 'btn--primary' : 'btn--ghost'}`}
                  style={{ height: 30, fontSize: 11 }}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Categories</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {categories.map((c) => (
                <button key={c.id} type="button" onClick={() => toggleCategory(c.id)}
                  className={`btn btn--sm ${categoryIds.includes(c.id) ? 'btn--primary' : 'btn--ghost'}`}
                  style={{ height: 30, fontSize: 11 }}>
                  {c.name}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Languages (comma-separated)</label>
            <input type="text" value={languages} onChange={(e) => md(setLanguages)(e.target.value)} placeholder="English, Swahili, Kikuyu" />
          </div>

          {!isNew && (
            <>
              <div className="form-group">
                <label className="form-label">Location (optional)</label>
                <input type="text" value={location} onChange={(e) => md(setLocation)(e.target.value)} placeholder="Westlands, Nairobi" />
              </div>

              <div className="form-group">
                <label className="form-label">In their own words <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(shown to members)</span></label>
                <textarea value={plainIntro} onChange={(e) => md(setPlainIntro)(e.target.value)} rows={4}
                  placeholder="Hi, I'm Amina. I work with people who feel stuck…" />
              </div>

              <div className="form-group">
                <label className="form-label">Their approach <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(plain language)</span></label>
                <textarea value={approachPlain} onChange={(e) => md(setApproachPlain)(e.target.value)} rows={3}
                  placeholder="I help you understand patterns at your pace…" />
              </div>

              <div className="form-group">
                <label className="form-label">Cultural competencies (comma-separated)</label>
                <input type="text" value={culturalComps} onChange={(e) => md(setCulturalComps)(e.target.value)}
                  placeholder="Kenyan family systems, Faith-integrated, LGBTQ+ affirming" />
              </div>

              <div className="form-group">
                <label className="form-label">Professional statement <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(internal only)</span></label>
                <textarea value={statement} onChange={(e) => md(setStatement)(e.target.value)} rows={2}
                  placeholder="Internal notes, not shown to members" />
              </div>
            </>
          )}

          {error && <p className="error-text">{error}</p>}
        </div>

        <div className="slide-panel__footer">
          <button className="btn btn--ghost" onClick={handleClose}>Cancel</button>
          <button className="btn btn--primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Add Therapist' : 'Save Changes'}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── VerifyPanel helpers ──────────────────────────────────────────────────────
const VERIFY_DOCS = [
  { type: 'kcpa_cert',     label: 'Professional certificate or verification letter' },
  { type: 'academic_cert', label: 'Academic certificate' },
  { type: 'indemnity',     label: 'Professional indemnity proof' },
  { type: 'good_conduct',  label: 'Certificate of Good Conduct' },
  { type: 'agreement',     label: 'Signed therapist agreement' },
];

const CONFIRM_LABEL = 'I have viewed the supporting document and confirmed this credential';

function fmtTs(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('en-KE', {
      timeZone: 'Africa/Nairobi',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return null; }
}

function stepCardStyle(complete) {
  return {
    padding: '12px 14px', borderRadius: 8, marginBottom: 8,
    background: complete ? 'rgba(143,175,154,0.08)' : 'var(--color-surface-secondary)',
    border: `1px solid ${complete ? 'var(--color-calm)' : 'var(--color-border)'}`,
  };
}

// Steps 1–3: text value + explicit confirmation checkbox
function TextStep({ num, label, placeholder, value, setValue, confirmed, setConfirmed, timestamp }) {
  const complete = Boolean(value.trim()) && confirmed;
  return (
    <div style={stepCardStyle(complete)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, marginRight: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-text-primary)', marginBottom: 6 }}>
            {num}. {label}
          </div>
          <label style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Enter as shown on document</label>
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            style={{ width: '100%', marginTop: 4, marginBottom: 8, fontSize: 12 }}
          />
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ cursor: 'pointer', accentColor: 'var(--color-calm)', width: 14, height: 14, marginTop: 1, flexShrink: 0 }}
            />
            {CONFIRM_LABEL}
          </label>
          {complete && fmtTs(timestamp) && (
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6 }}>
              Confirmed {fmtTs(timestamp)}
            </div>
          )}
        </div>
        {complete && <span style={{ color: 'var(--color-calm)', fontSize: 16, flexShrink: 0 }}>✓</span>}
      </div>
    </div>
  );
}

// Steps 4–6: boolean checkbox only
function BoolStep({ num, label, checked, setChecked, children, timestamp }) {
  return (
    <div style={stepCardStyle(checked)}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          style={{ marginTop: 2, cursor: 'pointer', accentColor: 'var(--color-calm)', width: 16, height: 16, flexShrink: 0 }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-text-primary)' }}>
            {num}. {label}
          </div>
          {children}
          {checked && fmtTs(timestamp) && (
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              Confirmed {fmtTs(timestamp)}
            </div>
          )}
        </div>
        {checked && <span style={{ color: 'var(--color-calm)', fontSize: 16, flexShrink: 0 }}>✓</span>}
      </div>
    </div>
  );
}

// ─── VerifyPanel — 6-step checklist ──────────────────────────────────────────
function VerifyPanel({ therapist, onClose, onSaved }) {
  // Steps 1–3: text value + explicit confirmation (decoupled)
  const [kcpaLevel,     setKcpaLevel]     = useState(therapist.kcpa_level ?? '');
  const [kcpaOk,        setKcpaOk]        = useState(Boolean(therapist.kcpa_level));
  const [regNumber,     setRegNumber]     = useState(therapist.registration_number ?? '');
  const [regOk,         setRegOk]         = useState(Boolean(therapist.registration_number));
  // Steps 4–6: boolean
  const [indemnity,     setIndemnity]     = useState(therapist.indemnity_verified ?? false);
  const [goodConduct,   setGoodConduct]   = useState(therapist.good_conduct_verified ?? false);
  const [conductExpiry, setConductExpiry] = useState(therapist.good_conduct_expires_at?.slice(0,10) ?? '');
  const [teletherapy,   setTeletherapy]   = useState(Boolean(therapist.teletherapy_agreement_signed_at));
  // Document viewer
  const [docs,          setDocs]          = useState(null);
  const [docsLoading,   setDocsLoading]   = useState(true);

  const [saving,       setSaving]       = useState(false);
  const [verifying,    setVerifying]    = useState(false);
  const [error,        setError]        = useState('');
  const isVerified = therapist.is_verified;

  useEffect(() => {
    client.get(`/api/admin/therapists/${therapist.id}/documents`)
      .then((r) => setDocs(r.data.documents ?? []))
      .catch(() => setDocs([]))
      .finally(() => setDocsLoading(false));
  }, [therapist.id]);

  const allDone =
    (kcpaLevel.trim() && kcpaOk) &&
    (regNumber.trim() && regOk) &&
    goodConduct && teletherapy;

  async function handleViewDoc(docType) {
    try {
      const r = await client.get(`/api/admin/therapists/${therapist.id}/documents`);
      const doc = (r.data.documents ?? []).find((d) => d.type === docType);
      if (doc?.signed_url) window.open(doc.signed_url, '_blank', 'noopener');
    } catch { /* silent — no stale URLs ever reach here */ }
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await client.patch(`/api/admin/therapists/${therapist.id}/verify`, {
        kcpa_level:                   kcpaLevel.trim() || null,
        registration_number:          regNumber.trim() || null,
        indemnity_verified:           indemnity,
        good_conduct_verified:        goodConduct,
        good_conduct_expires_at:      conductExpiry || null,
        teletherapy_agreement_signed: teletherapy,
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  async function handleForceVerify(grant) {
    if (!grant && !window.confirm(`Revoke verification for ${therapist.display_name}?`)) return;
    setVerifying(true);
    setError('');
    try {
      await client.patch(`/api/admin/therapists/${therapist.id}/verify`, { force_verify: grant });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update verification.');
    } finally {
      setVerifying(false);
    }
  }

  const hasAnyDoc = (docs ?? []).some((d) => VERIFY_DOCS.some((v) => v.type === d.type));

  return (
    <>
      <div className="panel-overlay" onClick={onClose} />
      <div className="slide-panel">
        <div className="slide-panel__header">
          <span className="slide-panel__title">Verify — {therapist.display_name}</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>

        <div className="slide-panel__body">

          {/* ── Uploaded documents ── */}
          <div style={{ marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid var(--color-border)' }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
              Uploaded Documents
            </div>
            {docsLoading ? (
              <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>Loading…</p>
            ) : !hasAnyDoc ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '10px 14px', background: 'var(--color-surface-secondary)', borderRadius: 8 }}>
                No documents uploaded yet
              </div>
            ) : (
              VERIFY_DOCS.map(({ type, label }) => {
                const doc = (docs ?? []).find((d) => d.type === type);
                return (
                  <div key={type} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--color-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: doc ? 'var(--color-calm)' : 'var(--color-warning)' }} />
                      <span style={{ fontSize: 12 }}>{label}</span>
                    </div>
                    {doc && (
                      <button className="btn btn--ghost btn--sm" onClick={() => handleViewDoc(type)} style={{ fontSize: 11 }}>
                        View ↗
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 20, lineHeight: 1.5 }}>
            Complete all 5 steps to verify this therapist. Saving partial progress is allowed — verification
            is granted automatically when all 5 are confirmed.
          </p>

          <TextStep
            num={1} label="Professional registration confirmed"
            placeholder="e.g. KCPA Associate, CPB Member, KPS Fellow"
            value={kcpaLevel}   setValue={setKcpaLevel}
            confirmed={kcpaOk}  setConfirmed={setKcpaOk}
            timestamp={therapist.kcpa_verified_at}
          />

          <TextStep
            num={2} label="Professional registration number verified"
            placeholder="e.g. KCPA/2019/001, CPB/2020/045"
            value={regNumber}  setValue={setRegNumber}
            confirmed={regOk}  setConfirmed={setRegOk}
            timestamp={therapist.registration_number_verified_at}
          />

          <BoolStep
            num={4} label="Professional indemnity insurance verified"
            checked={indemnity} setChecked={setIndemnity}
            timestamp={therapist.indemnity_verified_at}
          >
            <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              Valid, current indemnity insurance policy confirmed —{' '}
              <span style={{ color: 'var(--color-warning, #f59e0b)', fontWeight: 600 }}>follow up within 30 days, not required to verify</span>
            </p>
          </BoolStep>

          <BoolStep
            num={5} label="Certificate of Good Conduct verified"
            checked={goodConduct} setChecked={setGoodConduct}
            timestamp={therapist.good_conduct_verified_at}
          >
            <div style={{ marginTop: 6 }}>
              <label style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Expiry date</label>
              <input
                type="date"
                value={conductExpiry}
                onChange={(e) => setConductExpiry(e.target.value)}
                style={{ width: '100%', marginTop: 4, fontSize: 12 }}
              />
            </div>
          </BoolStep>

          <BoolStep
            num={6} label="Teletherapy agreement signed"
            checked={teletherapy} setChecked={setTeletherapy}
            timestamp={therapist.teletherapy_agreement_signed_at}
          >
            <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              PeerPal teletherapy platform agreement received and filed
            </p>
          </BoolStep>

          {allDone && (
            <div style={{
              background: 'rgba(143,175,154,0.12)', border: '1px solid var(--color-calm)',
              borderRadius: 8, padding: '12px 16px', fontSize: 13,
              color: 'var(--color-calm)', fontWeight: 600, textAlign: 'center', marginTop: 8,
            }}>
              ✓ All steps complete — saving will grant verified status
            </div>
          )}

          {error && <p className="error-text">{error}</p>}
        </div>

        <div className="slide-panel__footer" style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" onClick={handleSave} disabled={saving || verifying}>
              {saving ? 'Saving…' : 'Save Progress'}
            </button>
          </div>
          {isVerified ? (
            <button
              className="btn btn--ghost"
              onClick={() => handleForceVerify(false)}
              disabled={verifying || saving}
              style={{ color: 'var(--color-danger, #e74c3c)', borderColor: 'rgba(231,76,60,0.3)' }}
            >
              {verifying ? 'Revoking…' : 'Revoke Verification'}
            </button>
          ) : (
            <button
              className="btn btn--success"
              onClick={() => handleForceVerify(true)}
              disabled={verifying || saving}
            >
              {verifying ? 'Verifying…' : '✓ Grant Verification'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ─── SuspendPanel ─────────────────────────────────────────────────────────────
function SuspendPanel({ therapist, onClose, onSaved }) {
  const [reason,  setReason]  = useState('');
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');
  const [result,  setResult]  = useState(null);

  async function handleSuspend() {
    if (!reason.trim()) { setError('A reason is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const { data } = await client.patch(`/api/admin/therapists/${therapist.id}/suspend`, { reason: reason.trim() });
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to suspend.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay" onClick={result ? onSaved : onClose} />
      <div className="slide-panel">
        <div className="slide-panel__header">
          <span className="slide-panel__title">Suspend — {therapist.display_name}</span>
          <button className="btn btn--ghost btn--sm" onClick={result ? onSaved : onClose}>✕</button>
        </div>

        <div className="slide-panel__body">
          {result ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
              <p style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>Therapist suspended</p>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                {result.bookings_cancelled} upcoming booking{result.bookings_cancelled !== 1 ? 's' : ''} cancelled
                and credits refunded to affected members.
              </p>
            </div>
          ) : (
            <>
              <div style={{
                background: 'rgba(220,53,69,0.08)', border: '1px solid var(--color-danger)',
                borderRadius: 8, padding: '12px 16px', fontSize: 13,
                color: 'var(--color-danger)', marginBottom: 20, lineHeight: 1.5,
              }}>
                <strong>This will:</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  <li>Set the therapist to suspended + unavailable</li>
                  <li>Cancel all pending and confirmed future bookings</li>
                  <li>Return held credits to affected members</li>
                  <li>Notify each member via in-app notification</li>
                </ul>
              </div>

              <div className="form-group">
                <label className="form-label">Reason for suspension</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={4}
                  placeholder="e.g. Licence expired pending renewal, complaint under review…"
                />
                <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
                  Recorded in the audit log. Not shown to the therapist directly.
                </p>
              </div>

              {error && <p className="error-text">{error}</p>}
            </>
          )}
        </div>

        <div className="slide-panel__footer">
          {result ? (
            <button className="btn btn--primary" onClick={onSaved}>Done</button>
          ) : (
            <>
              <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn--danger" onClick={handleSuspend} disabled={saving}>
                {saving ? 'Suspending…' : 'Confirm Suspend'}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ─── CategoryPanel (add/edit) ─────────────────────────────────────────────────
function CategoryPanel({ category, onClose, onSaved }) {
  const isNew = !category;

  const [name,       setName]       = useState(category?.name ?? '');
  const [desc,       setDesc]       = useState(category?.description ?? '');
  const [icon,       setIcon]       = useState(category?.icon_name ?? '');
  const [tags,       setTags]       = useState((category?.condition_tags ?? []).join(', '));
  const [isActive,   setIsActive]   = useState(category?.is_active ?? true);
  const [sortOrder,  setSortOrder]  = useState(category?.sort_order ?? 0);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');

  async function handleSave() {
    if (!name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError('');
    const body = {
      name: name.trim(),
      description: desc.trim() || null,
      icon_name: icon.trim() || null,
      condition_tags: tags.trim() ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      is_active: isActive,
      sort_order: parseInt(sortOrder) || 0,
    };
    try {
      if (isNew) {
        await client.post('/api/admin/therapist-categories', body);
      } else {
        await client.patch(`/api/admin/therapist-categories/${category.id}`, body);
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="panel-overlay" onClick={onClose} />
      <div className="slide-panel">
        <div className="slide-panel__header">
          <span className="slide-panel__title">{isNew ? 'Add Category' : 'Edit Category'}</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>

        <div className="slide-panel__body">
          <div className="form-group">
            <label className="form-label">Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Anxiety & Stress" />
          </div>

          <div className="form-group">
            <label className="form-label">Description</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2}
              placeholder="Support for anxiety disorders, panic, worry, and stress management" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Icon name (Phosphor)</label>
              <input type="text" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="Brain" />
            </div>
            <div className="form-group">
              <label className="form-label">Sort order</label>
              <input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} min={0} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Condition tags (comma-separated)</label>
            <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="anxiety, panic, stress" />
          </div>

          <div className="form-group">
            <label className="form-label">Visible to members</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button className={`btn btn--sm ${isActive ? 'btn--primary' : 'btn--ghost'}`} onClick={() => setIsActive(true)}>Active</button>
              <button className={`btn btn--sm ${!isActive ? 'btn--danger' : 'btn--ghost'}`} onClick={() => setIsActive(false)}>Hidden</button>
            </div>
          </div>

          {error && <p className="error-text">{error}</p>}
        </div>

        <div className="slide-panel__footer">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Add Category' : 'Save Changes'}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── ApplicationsTable ────────────────────────────────────────────────────────
const APP_STATUS_BADGE = {
  pending:         { cls: 'badge--review',  label: 'Pending' },
  account_created: { cls: 'badge--active',  label: 'Account created' },
  rejected:        { cls: 'badge--banned',  label: 'Rejected' },
};

function ApplicationsTable({ applications, onReview }) {
  if (!applications.length) {
    return (
      <div className="card">
        <div className="empty-state">
          <p className="empty-state__title">No applications yet</p>
          <p className="empty-state__sub">Applications submitted via the /join page will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Applicant</th>
              <th>Phone</th>
              <th>Referred by</th>
              <th>Submitted</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {applications.map((a) => {
              const badge = APP_STATUS_BADGE[a.status] ?? APP_STATUS_BADGE.pending;
              return (
                <tr key={a.id}>
                  <td>
                    <div style={{ fontWeight: 500, fontSize: 14, color: 'var(--color-text-primary)' }}>{a.full_legal_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{a.email}</div>
                  </td>
                  <td style={{ fontSize: 13 }}>{a.phone || '—'}</td>
                  <td style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                    {a.referrer_name ?? <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>Direct</span>}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    {fmtTs(a.created_at)}
                  </td>
                  <td>
                    <span className={`badge ${badge.cls}`} style={{ fontSize: 10 }}>{badge.label}</span>
                  </td>
                  <td>
                    <button className="btn btn--ghost btn--sm" onClick={() => onReview(a)} style={{ fontSize: 11 }}>
                      Review
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── ApplicationPanel ─────────────────────────────────────────────────────────
function ApplicationPanel({ application: app, onClose, onSaved }) {
  const [status,     setStatus]     = useState(app.status);
  const [notes,      setNotes]      = useState(app.admin_notes ?? '');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');

  const changed = status !== app.status || notes !== (app.admin_notes ?? '');

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await client.patch(`/api/admin/referral-applications/${app.id}`, {
        status,
        admin_notes: notes.trim() || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update application.');
    } finally {
      setSaving(false);
    }
  }

  const badge = APP_STATUS_BADGE[app.status] ?? APP_STATUS_BADGE.pending;

  return (
    <>
      <div className="panel-overlay" onClick={onClose} />
      <div className="slide-panel">
        <div className="slide-panel__header">
          <span className="slide-panel__title">Application — {app.full_legal_name}</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>

        <div className="slide-panel__body">
          {/* Details */}
          <div style={{ background: 'var(--color-surface-secondary)', borderRadius: 8, padding: '12px 14px', marginBottom: 20 }}>
            {[
              ['Email',       app.email],
              ['Phone',       app.phone],
              ['Signature',   app.signature_name],
              ['Referred by', app.referrer_name ?? 'Direct application'],
              ['Doc version', app.doc_version],
              ['IP address',  app.ip_address ?? '—'],
              ['Submitted',   fmtTs(app.created_at)],
            ].map(([label, val]) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--color-border)', fontSize: 13 }}>
                <span style={{ color: 'var(--color-text-muted)', fontWeight: 500 }}>{label}</span>
                <span style={{ color: 'var(--color-text-primary)', textAlign: 'right', maxWidth: '60%', wordBreak: 'break-word' }}>{val || '—'}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13 }}>
              <span style={{ color: 'var(--color-text-muted)', fontWeight: 500 }}>Current status</span>
              <span className={`badge ${badge.cls}`} style={{ fontSize: 10 }}>{badge.label}</span>
            </div>
          </div>

          {/* Status update */}
          <div className="form-group">
            <label className="form-label">Update status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="pending">Pending</option>
              <option value="account_created">Account created</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          {status === 'account_created' && (
            <div style={{ background: 'rgba(143,175,154,0.1)', border: '1px solid var(--color-calm)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--color-calm)', marginBottom: 12 }}>
              After saving, create the therapist account via <strong>+ Add Therapist</strong> using this applicant's details.
            </div>
          )}

          {status === 'rejected' && (
            <div style={{ background: 'rgba(220,53,69,0.06)', border: '1px solid var(--color-danger)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--color-danger)', marginBottom: 12 }}>
              Rejection is recorded in the audit log. The applicant is not automatically notified.
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Admin notes <span style={{ fontWeight: 400, color: 'var(--color-text-muted)' }}>(internal only)</span></label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="e.g. Documents verified, invited to onboarding…"
            />
          </div>

          {error && <p className="error-text">{error}</p>}
        </div>

        <div className="slide-panel__footer">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={handleSave} disabled={saving || !changed}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── DocumentsPanel ───────────────────────────────────────────────────────────
const DOC_LABELS = {
  photo:         'Profile photo',
  kcpa_cert:     'Professional certificate or verification letter',
  academic_cert: 'Academic certificate',
  indemnity:     'Professional indemnity proof',
  good_conduct:  'Certificate of Good Conduct',
  agreement:     'Signed therapist agreement',
};

function DocumentsPanel({ therapist, onClose }) {
  const [docs,    setDocs]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const urlCache = useRef({});

  useEffect(() => {
    client.get(`/api/admin/therapists/${therapist.id}/documents`)
      .then((r) => setDocs(r.data.documents))
      .catch(() => setError('Failed to load documents.'))
      .finally(() => setLoading(false));
  }, [therapist.id]);

  async function handleView(doc) {
    const cached = urlCache.current[doc.file_path];
    if (cached && cached.expires_at > Date.now()) {
      window.open(cached.url, '_blank', 'noopener');
      return;
    }
    // Re-fetch a fresh signed URL
    try {
      const r = await client.get(`/api/admin/therapists/${therapist.id}/documents`);
      const fresh = r.data.documents.find((d) => d.file_path === doc.file_path);
      if (fresh?.signed_url) {
        urlCache.current[doc.file_path] = { url: fresh.signed_url, expires_at: Date.now() + 55 * 60 * 1000 };
        window.open(fresh.signed_url, '_blank', 'noopener');
      }
    } catch {
      alert('Could not open document. Please try again.');
    }
  }

  return (
    <>
      <div className="panel-overlay" onClick={onClose} />
      <div className="slide-panel">
        <div className="slide-panel__header">
          <span className="slide-panel__title">Documents — {therapist.display_name}</span>
          <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
        </div>
        <div className="slide-panel__body">
          {loading && <p style={{ color: 'var(--color-text-muted)' }}>Loading…</p>}
          {error  && <p style={{ color: 'var(--color-error)' }}>{error}</p>}
          {docs && !docs.length && (
            <div style={{ background: 'var(--color-surface-secondary)', borderRadius: 8, padding: '14px 16px', fontSize: 13, color: 'var(--color-text-muted)' }}>
              No documents uploaded yet. The therapist must complete their portal onboarding first.
            </div>
          )}
          {docs?.map((doc) => (
            <div key={doc.type} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{DOC_LABELS[doc.type] ?? doc.type}</div>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                  Uploaded {new Date(doc.uploaded_at).toLocaleDateString('en-KE')}
                </div>
              </div>
              <button className="btn btn--primary btn--sm" onClick={() => handleView(doc)} style={{ fontSize: 11 }}>
                View ↗
              </button>
            </div>
          ))}
          <p style={{ marginTop: 20, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            Documents open via a signed URL valid for 1 hour. Each "View" click generates a fresh URL. No public links are created.
          </p>
        </div>
        <div className="slide-panel__footer">
          <button className="btn btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}
