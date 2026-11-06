import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Clock, VideoCamera, Phone, ChatText } from '@phosphor-icons/react';
import client from '../../api/client';

const FORMAT_ICONS  = { video: VideoCamera, voice: Phone, text: ChatText };
const FORMAT_LABELS = { video: 'Video call', voice: 'Voice call', text: 'Text chat' };

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];


export default function TherapistBookingScreen() {
  const { therapistId } = useParams();
  const navigate = useNavigate();

  const [selectedFormat, setSelectedFormat] = useState(null);
  const [selectedDuration, setSelectedDuration] = useState(60);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [notes, setNotes] = useState('');
  const [slotLockId, setSlotLockId] = useState(null);
  const [lockCountdown, setLockCountdown] = useState(null);
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [waitingMpesa, setWaitingMpesa] = useState(false);
  const [error, setError] = useState('');
  const countdownRef = useRef(null);
  const pollRef = useRef(null);
  const queryClient = useQueryClient();

  const { data: therapistData } = useQuery({
    queryKey: ['therapy', 'therapist', therapistId],
    queryFn: () => client.get(`/api/therapy/therapists/${therapistId}`).then(r => r.data),
  });

  const { data: availData } = useQuery({
    queryKey: ['therapy', 'availability', therapistId],
    queryFn: () => client.get(`/api/therapy/therapists/${therapistId}/availability`).then(r => r.data),
    enabled: !!therapistId,
  });

  const therapist = therapistData?.therapist;
  const formats = therapist?.session_formats ?? [];

  // Server-authoritative pricing — never computed client-side
  const { data: quoteData, isLoading: quoteLoading } = useQuery({
    queryKey: ['therapy', 'quote', therapistId, selectedDuration],
    queryFn: () => client.get('/api/therapy/booking/quote', {
      params: { therapist_id: therapistId, duration_minutes: selectedDuration },
    }).then(r => r.data),
    enabled: !!therapistId,
    staleTime: 60_000,
  });
  const clientChargeKes = quoteData?.client_charge_kes ?? null;

  // API returns ISO strings — parse into { iso, localDate, displayTime } objects grouped by local date
  const slotsByDate = {};
  for (const iso of (availData?.slots ?? [])) {
    const d = new Date(iso);
    // Use EAT (Africa/Nairobi, UTC+3) for display
    const localDate = new Date(d.getTime() + 3 * 3600000);
    const dateKey   = localDate.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const hh = String(localDate.getUTCHours()).padStart(2, '0');
    const mm = String(localDate.getUTCMinutes()).padStart(2, '0');
    const displayTime = `${hh}:${mm}`;
    if (!slotsByDate[dateKey]) slotsByDate[dateKey] = [];
    slotsByDate[dateKey].push({ iso, dateKey, displayTime });
  }
  const dates = Object.keys(slotsByDate).sort();

  // Pre-fill phone from profile
  useEffect(() => {
    client.get('/api/profile').then(r => {
      const p = r.data?.user?.phone ?? r.data?.phone ?? '';
      if (p) setPhone(p);
    }).catch(() => {});
  }, []);

  // Derive auto-selected format rather than syncing via effect
  const effectiveFormat = selectedFormat ?? (formats.length === 1 ? formats[0] : null);

  // Countdown timer for slot lock
  useEffect(() => {
    if (lockCountdown == null) return;
    if (lockCountdown <= 0) {
      // Schedule state reset outside the effect body to avoid cascading renders
      const t = setTimeout(() => { setSlotLockId(null); setLockCountdown(null); }, 0);
      return () => clearTimeout(t);
    }
    countdownRef.current = setTimeout(() => setLockCountdown(c => c - 1), 1000);
    return () => clearTimeout(countdownRef.current);
  }, [lockCountdown]);

  // Cleanup on unmount
  useEffect(() => () => {
    clearTimeout(countdownRef.current);
    clearInterval(pollRef.current);
  }, []);

  async function acquireLock() {
    if (!selectedSlot) return;
    setError('');
    try {
      const { data } = await client.post('/api/therapy/slot-lock', {
        therapist_id: therapistId,
        scheduled_at: selectedSlot.iso,
      });
      setSlotLockId(data.lock_id);
      setLockCountdown(300);
      return data.lock_id;
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'SLOT_TAKEN') {
        setError('This slot was just taken. Please choose another time.');
      } else {
        setError('Could not hold this slot. Please try again.');
      }
      return null;
    }
  }

  // Single action: lock slot then immediately confirm booking
  async function handleSchedule() {
    if (!effectiveFormat || !selectedSlot) return;
    setSubmitting(true);
    setError('');
    // If we don't have a lock yet, acquire one first
    let lockId = slotLockId;
    if (!lockId) {
      lockId = await acquireLock();
      if (!lockId) { setSubmitting(false); return; }
    }
    await handleConfirm(lockId);
  }

  async function handleConfirm(lockId) {
    if (!effectiveFormat || !selectedSlot || !lockId) return;
    try {
      const categoryId = (therapist.category_ids ?? [])[0] ?? null;
      if (!categoryId) {
        setError('This therapist has no service categories configured. Please contact support.');
        setSubmitting(false);
        return;
      }

      if (!phone.trim()) {
        setError('Please enter your M-Pesa phone number.');
        setSubmitting(false);
        return;
      }

      const { data } = await client.post('/api/therapy/bookings', {
        therapist_id:               therapistId,
        category_id:                categoryId,
        lock_id:                    lockId,
        session_format:             effectiveFormat,
        scheduled_at:               selectedSlot.iso,
        duration_minutes:           selectedDuration,
        phone,
        notes:                      notes.trim() || null,
        expected_client_charge_kes: clientChargeKes,
      });

      // Paystack (redirect flow): checkout_url present → go there
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
        return;
      }

      // IntaSend (STK flow): show waiting screen, poll for status='pending'
      setWaitingMpesa(true);
      const bookingId = data.booking_id;
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        try {
          const { data: bData } = await client.get(`/api/therapy/bookings/${bookingId}`);
          const b = bData.booking;
          if (b?.status === 'pending') {
            clearInterval(pollRef.current);
            navigate('/therapy/my?payment=success', { replace: true });
            return;
          }
          if (b?.payment_status === 'failed') {
            clearInterval(pollRef.current);
            setWaitingMpesa(false);
            setError('Payment was declined. Please check your M-Pesa balance and try again.');
            setSubmitting(false);
            return;
          }
        } catch { /* non-fatal */ }
        if (attempts >= 36) { // 3 min max
          clearInterval(pollRef.current);
          setWaitingMpesa(false);
          setError('M-Pesa is taking longer than expected. Check "My Therapy" for your booking status.');
          setSubmitting(false);
        }
      }, 5000);
    } catch (err) {
      const code = err.response?.data?.code;
      if (code === 'PRICE_CHANGED') {
        // Invalidate the cached quote so the new price is fetched and shown
        queryClient.invalidateQueries({ queryKey: ['therapy', 'quote', therapistId, selectedDuration] });
        const newCharge = err.response.data.client_charge_kes;
        setError(
          `The session price has changed to KES ${newCharge?.toLocaleString() ?? '—'}. ` +
          `Review the updated price and tap "Schedule Session" to confirm.`
        );
      } else {
        setError(err.response?.data?.error || 'Booking failed. Please try again.');
      }
      setSubmitting(false);
    }
  }

  function cancelWait() {
    clearInterval(pollRef.current);
    setWaitingMpesa(false);
    setSubmitting(false);
    navigate('/therapy/my', { replace: true });
  }

  if (!therapist) {
    return (
      <div className="screen">
        <div style={{ padding: 'var(--space-md)' }}>
          <div className="skeleton" style={{ height: 40, marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 200, marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 160 }} />
        </div>
      </div>
    );
  }

  const canSchedule = !!(effectiveFormat && selectedSlot && phone.trim());

  return (
    <div className="screen" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        height: 'var(--top-bar-height)', padding: '0 var(--space-md)',
        background: 'var(--color-bg-primary)', borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
      }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-primary)', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center' }} aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <span style={{ fontWeight: 700, fontSize: 17 }}>Book — {therapist.display_name}</span>
      </div>

      {waitingMpesa ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, padding: 'var(--space-lg)', textAlign: 'center' }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--color-calm-light, #e8f4f8)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
            <Clock size={32} color="var(--color-calm)" />
          </div>
          <h2 style={{ fontFamily: 'var(--font-editorial)', marginBottom: 8 }}>Check your phone</h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.88rem', lineHeight: 1.6, maxWidth: 280, marginBottom: 24 }}>
            An M-Pesa payment request has been sent. Enter your PIN to complete the booking.
          </p>
          <button onClick={cancelWait} className="btn btn--muted" style={{ minWidth: 180 }}>
            Cancel — check my bookings
          </button>
        </div>
      ) : (
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-md)' }}>
          {/* Format selector */}
          <Section label="Session Format">
            <div style={{ display: 'flex', gap: 10 }}>
              {formats.map(f => {
                const Icon = FORMAT_ICONS[f] ?? VideoCamera;
                if (!FORMAT_LABELS[f]) return null;
                return (
                  <button
                    key={f}
                    onClick={() => setSelectedFormat(f)}
                    style={{
                      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                      padding: '12px 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                      border: effectiveFormat === f ? '2px solid var(--color-calm)' : '1px solid var(--color-border)',
                      background: effectiveFormat === f ? 'var(--color-calm-light, #e8f4f8)' : 'var(--color-surface)',
                      transition: 'all 120ms ease',
                    }}
                  >
                    <Icon size={24} color={effectiveFormat === f ? 'var(--color-calm)' : 'var(--color-text-muted)'} weight="duotone" />
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: effectiveFormat === f ? 'var(--color-calm)' : 'var(--color-text-primary)' }}>
                      {FORMAT_LABELS[f]}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Duration selector */}
          <Section label="Session Duration">
            <div style={{ display: 'flex', gap: 10 }}>
              {[
                { value: 45, label: '45 min', desc: 'Focus session' },
                { value: 60, label: '60 min', desc: 'Full session' },
              ].map(d => (
                <button
                  key={d.value}
                  onClick={() => setSelectedDuration(d.value)}
                  style={{
                    flex: 1, padding: '12px 8px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                    border: selectedDuration === d.value ? '2px solid var(--color-calm)' : '1px solid var(--color-border)',
                    background: selectedDuration === d.value ? 'var(--color-calm-light, #e8f4f8)' : 'var(--color-surface)',
                    transition: 'all 120ms ease',
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: '0.95rem', color: selectedDuration === d.value ? 'var(--color-calm)' : 'var(--color-text-primary)' }}>{d.label}</div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--color-text-muted)', marginTop: 2 }}>{d.desc}</div>
                </button>
              ))}
            </div>
          </Section>

          {/* Date picker */}
          <Section label="Date">
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
              {dates.length === 0 && <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>No available dates</p>}
              {dates.map(d => {
                const dateObj = new Date(d + 'T12:00:00');
                return (
                  <button
                    key={d}
                    onClick={() => { setSelectedDate(d); setSelectedSlot(null); setSlotLockId(null); setLockCountdown(null); }}
                    style={{
                      flexShrink: 0, padding: '8px 14px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                      border: selectedDate === d ? '2px solid var(--color-calm)' : '1px solid var(--color-border)',
                      background: selectedDate === d ? 'var(--color-calm)' : 'var(--color-surface)',
                      color: selectedDate === d ? '#fff' : 'var(--color-text-primary)',
                      transition: 'all 120ms ease', fontSize: '0.82rem', fontWeight: 500,
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>{dateObj.getDate()}</div>
                    <div style={{ fontSize: '0.72rem' }}>{MONTH_NAMES[dateObj.getMonth()]}</div>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Time slots */}
          {selectedDate && (
            <Section label="Time">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {(slotsByDate[selectedDate] ?? []).map(slot => (
                  <button
                    key={slot.iso}
                    onClick={() => { setSelectedSlot(slot); setSlotLockId(null); setLockCountdown(null); setError(''); }}
                    style={{
                      padding: '8px 14px', borderRadius: 20, cursor: 'pointer', fontSize: '0.84rem', fontWeight: 500,
                      border: selectedSlot?.iso === slot.iso ? '2px solid var(--color-calm)' : '1px solid var(--color-border)',
                      background: selectedSlot?.iso === slot.iso ? 'var(--color-calm)' : 'var(--color-surface)',
                      color: selectedSlot?.iso === slot.iso ? '#fff' : 'var(--color-text-primary)',
                      transition: 'all 120ms ease',
                    }}
                  >
                    {slot.displayTime}
                  </button>
                ))}
              </div>
            </Section>
          )}

          {/* Notes */}
          <Section label="Notes for therapist (optional)">
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value.slice(0, 200))}
              placeholder="Anything you'd like your therapist to know beforehand…"
              rows={3}
              style={{
                width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)',
                padding: '10px 12px', fontSize: '0.88rem', resize: 'vertical', fontFamily: 'inherit',
                background: 'var(--color-surface)', color: 'var(--color-text-primary)', boxSizing: 'border-box',
              }}
            />
            <div style={{ textAlign: 'right', fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
              {notes.length}/200
            </div>
          </Section>

          {/* M-Pesa number */}
          <Section label="M-Pesa number">
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="e.g. 0712 345 678"
              style={{
                width: '100%', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)',
                padding: '10px 12px', fontSize: '0.88rem', fontFamily: 'inherit',
                background: 'var(--color-surface)', color: 'var(--color-text-primary)', boxSizing: 'border-box',
              }}
            />
            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
              Payment request will be sent to this number.
            </p>
          </Section>

          {/* Cost summary — server-authoritative price only */}
          {effectiveFormat && selectedDuration && (
            <div style={{ background: 'var(--color-surface-card)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-md)', marginBottom: 'var(--space-md)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.88rem', color: 'var(--color-text-secondary)' }}>Session fee</span>
                <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>
                  {quoteLoading ? '…' : clientChargeKes != null ? `KES ${clientChargeKes.toLocaleString()}` : '—'}
                </span>
              </div>
              <p style={{ fontSize: '0.76rem', color: 'var(--color-text-muted)', marginTop: 6, marginBottom: 0 }}>+ 1 credit deducted from your balance on booking</p>
            </div>
          )}

          {/* Slot-lock countdown */}
          {slotLockId && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 12, fontSize: '0.84rem', color: 'var(--color-text-muted)' }}>
              <Clock size={16} />
              Slot held for {Math.floor(lockCountdown / 60)}:{String(lockCountdown % 60).padStart(2, '0')}
            </div>
          )}

          {error && <p style={{ color: 'var(--color-error, #c0392b)', fontSize: '0.84rem', marginBottom: 12, textAlign: 'center' }}>{error}</p>}
        </div>
      )}

      {/* ── Schedule footer — hidden while waiting for M-Pesa ── */}
      {!waitingMpesa && (
        <div style={{
          flexShrink: 0,
          padding: '12px 20px',
          paddingBottom: 'calc(28px + env(safe-area-inset-bottom))',
          background: 'var(--color-bg-primary)',
          borderTop: '1px solid var(--color-border)',
        }}>
          {effectiveFormat && selectedDuration && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: '0.88rem', color: 'var(--color-text-muted)' }}>
                {selectedSlot && clientChargeKes != null ? `KES ${clientChargeKes.toLocaleString()}` : 'Select a time slot'}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>1 credit on booking</span>
            </div>
          )}
          <button
            className="btn btn--primary"
            style={{ width: '100%', fontSize: '1rem', padding: '14px', opacity: canSchedule ? 1 : 0.45 }}
            onClick={canSchedule ? handleSchedule : undefined}
            disabled={submitting || !canSchedule}
          >
            {submitting ? 'Sending payment request…' : 'Schedule Session'}
          </button>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 'var(--space-md)' }}>
      <h4 style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10 }}>{label}</h4>
      {children}
    </div>
  );
}

