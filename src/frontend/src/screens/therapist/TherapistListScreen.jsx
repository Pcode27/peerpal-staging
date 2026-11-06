import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Star, SlidersHorizontal, User, ArrowLeft, X } from '@phosphor-icons/react';
import client from '../../api/client';

const FORMAT_LABELS = { video: 'Video', voice: 'Voice', text: 'Text' };
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GENDER_LABELS = { male: 'Male', female: 'Female', non_binary: 'Non-binary' };

function StarRating({ value, size = 14 }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(n => (
        <Star key={n} size={size} weight={n <= Math.round(value) ? 'fill' : 'regular'} color={n <= Math.round(value) ? '#F5A623' : 'var(--color-border)'} />
      ))}
    </span>
  );
}

function TherapistCardSkeleton() {
  return (
    <div className="skeleton" style={{ height: 160, borderRadius: 'var(--radius-lg)', marginBottom: 12 }} />
  );
}

function TherapistCard({ therapist, onViewProfile, index }) {
  const formats = therapist.session_formats ?? [];
  return (
    <div
      style={{
        background: 'var(--color-surface-card)', border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)', padding: 'var(--space-md)',
        animation: `cardFadeIn 300ms ease ${index * 60}ms both`,
      }}
    >
      <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
        {therapist.photo_url ? (
          <img src={therapist.photo_url} alt={therapist.display_name} style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <div style={{ width: 60, height: 60, borderRadius: '50%', background: 'var(--color-calm-light, #e8f4f8)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <User size={30} color="var(--color-calm)" />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--color-text-primary)', marginBottom: 1 }}>
            {therapist.display_name}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-muted)', marginBottom: 3 }}>
            {therapist.credentials}
          </div>
          {/* Age · Gender */}
          {(therapist.age || therapist.gender) && (
            <div style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)', marginBottom: 4 }}>
              {[
                therapist.age ? `${therapist.age} yrs` : null,
                therapist.gender ? (GENDER_LABELS[therapist.gender] ?? therapist.gender) : null,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
          {therapist.total_ratings_count >= 5 && therapist.average_rating != null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <StarRating value={therapist.average_rating} />
              <span style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)' }}>
                {Number(therapist.average_rating).toFixed(1)} ({therapist.total_ratings_count} ratings)
              </span>
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--color-calm)' }}>
            KES {therapist.rate_per_session_kes?.toLocaleString()}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>/ session</div>
        </div>
      </div>

      {/* Languages + formats */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {(therapist.languages ?? []).map(lang => (
          <span key={lang} style={{ fontSize: '0.72rem', background: 'var(--color-calm-light, #e8f4f8)', color: 'var(--color-calm)', padding: '2px 8px', borderRadius: 20 }}>{lang}</span>
        ))}
        {formats.map(f => (
          <span key={f} style={{ fontSize: '0.72rem', background: 'var(--color-surface)', color: 'var(--color-text-secondary)', padding: '2px 8px', borderRadius: 20, border: '1px solid var(--color-border)' }}>{FORMAT_LABELS[f] ?? f}</span>
        ))}
      </div>

      <button
        className="btn btn--primary"
        style={{ width: '100%', fontSize: '0.88rem', padding: '10px' }}
        onClick={() => onViewProfile(therapist.id)}
      >
        View Profile
      </button>
    </div>
  );
}

function FilterSheet({ filters, setFilters, rateRange, onClose }) {
  const [local, setLocal] = useState(filters);

  function toggleArray(field, val) {
    setLocal(prev => {
      const arr = prev[field] ?? [];
      return { ...prev, [field]: arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val] };
    });
  }

  function apply() {
    setFilters(local);
    onClose();
  }

  function clear() {
    const empty = { languages: [], genders: [], formats: [], days: [], maxRate: rateRange.max };
    setLocal(empty);
    setFilters(empty);
    onClose();
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%', maxWidth: 480,
          background: 'var(--color-bg-primary)',
          borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
          maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          animation: 'sheetSlideUp 280ms ease',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10, flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--color-border)' }} />
        </div>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px 0', flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Filter</h3>
          <button onClick={clear} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--color-calm)', fontWeight: 600 }}>Clear all</button>
        </div>

        {/* Scrollable content */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px 8px' }}>
          <FilterSection label="Session format">
            {['video', 'voice', 'text'].map(f => (
              <Chip key={f} label={FORMAT_LABELS[f]} active={(local.formats ?? []).includes(f)} onToggle={() => toggleArray('formats', f)} />
            ))}
          </FilterSection>

          <FilterSection label="Available day">
            {DAY_LABELS.map((d, i) => (
              <Chip key={i} label={d} active={(local.days ?? []).includes(i)} onToggle={() => toggleArray('days', i)} />
            ))}
          </FilterSection>

          <FilterSection label="Gender">
            {['male', 'female', 'non_binary'].map(g => (
              <Chip key={g} label={g === 'non_binary' ? 'Non-binary' : g.charAt(0).toUpperCase() + g.slice(1)} active={(local.genders ?? []).includes(g)} onToggle={() => toggleArray('genders', g)} />
            ))}
          </FilterSection>

          {rateRange.max > rateRange.min && (
            <div style={{ marginBottom: 'var(--space-md)' }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10 }}>
                Max rate: KES {(local.maxRate ?? rateRange.max).toLocaleString()}
              </div>
              <input
                type="range"
                min={rateRange.min}
                max={rateRange.max}
                step={500}
                value={local.maxRate ?? rateRange.max}
                onChange={e => setLocal(prev => ({ ...prev, maxRate: Number(e.target.value) }))}
                style={{ width: '100%', accentColor: 'var(--color-calm)' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.76rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
                <span>KES {rateRange.min.toLocaleString()}</span>
                <span>KES {rateRange.max.toLocaleString()}</span>
              </div>
            </div>
          )}
        </div>

        {/* Pinned CTA */}
        <div style={{ padding: '12px 20px 32px', borderTop: '1px solid var(--color-border)', flexShrink: 0 }}>
          <button className="btn btn--primary" style={{ width: '100%' }} onClick={apply}>Apply Filters</button>
        </div>
      </div>
    </div>
  );
}

function FilterSection({ label, children }) {
  return (
    <div style={{ marginBottom: 'var(--space-md)' }}>
      <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{children}</div>
    </div>
  );
}

function Chip({ label, active, onToggle }) {
  return (
    <button
      onClick={onToggle}
      style={{
        padding: '6px 14px', borderRadius: 20, fontSize: '0.82rem', fontWeight: 500, cursor: 'pointer',
        border: active ? 'none' : '1px solid var(--color-border)',
        background: active ? 'var(--color-calm)' : 'var(--color-surface)',
        color: active ? '#fff' : 'var(--color-text-primary)',
        transition: 'all 120ms ease',
      }}
    >
      {label}
    </button>
  );
}

export default function TherapistListScreen() {
  const { id: categoryId } = useParams();
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [allTherapists, setAllTherapists] = useState([]);
  const [filters, setFilters] = useState({ languages: [], genders: [], formats: [], days: [], maxRate: null });
  const [showFilter, setShowFilter] = useState(false);
  const rateRangeRef = useRef({ min: 0, max: 10000 });
  const prevKeyRef = useRef('');

  // Build query params
  const params = new URLSearchParams({ category_id: categoryId, page, limit: 20 });
  if (filters.formats?.length) params.set('session_format', filters.formats.join(','));
  if (filters.genders?.length) params.set('gender', filters.genders.join(','));
  if (filters.languages?.length) params.set('language', filters.languages.join(','));
  if (filters.days?.length) params.set('day_of_week', filters.days.join(','));
  if (filters.maxRate) params.set('max_rate', filters.maxRate);
  const queryKey = params.toString();

  const { data, isLoading } = useQuery({
    queryKey: ['therapy', 'therapists', queryKey],
    queryFn: () => client.get(`/api/therapy/therapists?${params.toString()}`).then(r => r.data),
  });

  // Derive hasMore and rateRange from latest data — no setState needed
  const hasMore = data ? (data.page ?? 1) < (data.total_pages ?? 1) : false;
  if (data?.rate_min != null) rateRangeRef.current = { min: data.rate_min, max: data.rate_max };
  const rateRange = rateRangeRef.current;

  useEffect(() => {
    if (!data) return;
    const list = data.therapists ?? [];
    if (queryKey !== prevKeyRef.current) {
      setAllTherapists(list);
    } else {
      setAllTherapists(prev => [...prev, ...list]);
    }
    prevKeyRef.current = queryKey;
  }, [data, queryKey]);

  const filterActive = filters.formats?.length || filters.genders?.length || filters.languages?.length || filters.days?.length || filters.maxRate;

  function handleSetFilters(f) {
    setFilters(f);
    setPage(1);
    prevKeyRef.current = '';
    setAllTherapists([]);
  }

  return (
    <div className="screen" style={{ overflowY: 'auto' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        height: 'var(--top-bar-height)', padding: '0 var(--space-md)',
        background: 'var(--color-bg-primary)', borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
      }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--color-text-primary)', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <span style={{ fontWeight: 700, fontSize: 17, flex: 1 }}>
          {data?.category_name ?? 'Therapists'}
        </span>
        <button
          onClick={() => setShowFilter(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: filterActive ? 'var(--color-calm)' : 'var(--color-surface)',
            color: filterActive ? '#fff' : 'var(--color-text-primary)',
            border: `1px solid ${filterActive ? 'var(--color-calm)' : 'var(--color-border)'}`,
            borderRadius: 20, padding: '6px 14px', cursor: 'pointer', fontSize: '0.84rem', fontWeight: 600,
          }}
        >
          <SlidersHorizontal size={16} />
          Filter{filterActive ? ' ·' : ''}
        </button>
      </div>

      <div style={{ padding: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {isLoading && allTherapists.length === 0 && (
          <>
            <TherapistCardSkeleton />
            <TherapistCardSkeleton />
            <TherapistCardSkeleton />
          </>
        )}

        {!isLoading && allTherapists.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--color-text-muted)' }}>
            <p style={{ fontWeight: 600 }}>No therapists found</p>
            <p style={{ fontSize: '0.84rem', marginTop: 4 }}>Try adjusting your filters.</p>
          </div>
        )}

        {allTherapists.map((t, i) => (
          <TherapistCard key={t.id} therapist={t} index={i} onViewProfile={id => navigate(`/therapists/profile/${id}`)} />
        ))}

        {hasMore && (
          <button
            className="btn btn--muted"
            style={{ width: '100%' }}
            onClick={() => setPage(p => p + 1)}
            disabled={isLoading}
          >
            {isLoading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>

      {showFilter && (
        <FilterSheet filters={filters} setFilters={handleSetFilters} rateRange={rateRange} onClose={() => setShowFilter(false)} />
      )}

      <style>{`
        @keyframes cardFadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes sheetSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
      `}</style>
    </div>
  );
}
