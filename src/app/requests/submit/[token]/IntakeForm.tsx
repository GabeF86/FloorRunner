'use client';

// Client form for the public request-intake page. Three entry categories:
//   PTO ranges       → land in the Requests approval queue (pending)
//   Days-off ranges  → approval queue (pending, availability_change)
//   No-call dates    → recorded directly; the scheduling engine arbitrates
// Client-side checks mirror the server's (which is authoritative).
import { useState } from 'react';

interface RosterProvider {
  id: string;
  first_name: string;
  last_name: string;
}

interface Range { start: string; end: string }

export default function IntakeForm({ token, siteName, blockStart, blockEnd, maxNoCall, roster }: {
  token: string;
  siteName: string;
  blockStart: string;
  blockEnd: string;
  maxNoCall: number;
  roster: RosterProvider[];
}) {
  const [providerId, setProviderId] = useState('');
  const [pto, setPto] = useState<Range[]>([]);
  const [daysOff, setDaysOff] = useState<Range[]>([]);
  const [noCallDates, setNoCallDates] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ pto: number; days_off: number; no_call: number } | null>(null);

  const fmt = (d: string) =>
    new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const hasEntries = pto.length > 0 || daysOff.length > 0 || noCallDates.length > 0;
  const canSubmit = !!providerId && hasEntries && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/requests/submit/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: providerId,
          pto: pto.map(r => ({ start_date: r.start, end_date: r.end })),
          days_off: daysOff.map(r => ({ start_date: r.start, end_date: r.end })),
          no_call_dates: noCallDates,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Submission failed (${res.status})`);
        return;
      }
      setDone(data.created);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error — please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 8px' }}>
        <div style={{ fontSize: 34, marginBottom: 12 }}>✅</div>
        <h1 style={{ fontSize: 19, fontWeight: 800, color: 'var(--text)', marginBottom: 8 }}>
          Requests submitted
        </h1>
        <p style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
          {done.pto > 0 && <>PTO requests: <b>{done.pto}</b> (pending scheduler approval)<br /></>}
          {done.days_off > 0 && <>Days-off requests: <b>{done.days_off}</b> (pending scheduler approval)<br /></>}
          {done.no_call > 0 && <>No-call dates: <b>{done.no_call}</b> (recorded — the schedule generator will avoid these when it can)<br /></>}
        </p>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 10 }}>
          Need to add more? Just reopen this link while the window is open.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: 19, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>
        Schedule requests — {siteName}
      </h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18, lineHeight: 1.6 }}>
        For the block <b>{fmt(blockStart)} – {fmt(blockEnd)}</b>. PTO and days-off
        requests go to the scheduler for approval; no-call dates (up to {maxNoCall})
        are handled by the scheduling engine itself.
      </p>

      {error && (
        <div style={{
          color: 'var(--danger, #dc2626)', fontSize: 12.5, marginBottom: 14,
          padding: '8px 12px', background: 'rgba(220,38,38,0.07)',
          border: '1px solid rgba(220,38,38,0.25)', borderRadius: 8,
        }}>{error}</div>
      )}

      <label style={labelStyle}>Your name</label>
      <select value={providerId} onChange={e => setProviderId(e.target.value)} style={{ ...inputStyle, marginBottom: 20 }}>
        <option value="">Select your name…</option>
        {roster.map(p => (
          <option key={p.id} value={p.id}>{p.last_name}, {p.first_name}</option>
        ))}
      </select>

      <RangeSection
        title="PTO"
        hint="Vacation / paid time off. Goes to the scheduler for approval."
        ranges={pto}
        onChange={setPto}
      />
      <RangeSection
        title="Days Off"
        hint="Recurring or personal non-working days (not counted as PTO). Goes to the scheduler for approval."
        ranges={daysOff}
        onChange={setDaysOff}
      />

      {/* No-call dates */}
      <div style={{ marginBottom: 22 }}>
        <div style={sectionHeadStyle}>No-Call Requests</div>
        <div style={hintStyle}>
          Days you&apos;d prefer not to take call (you may still work). Up to {maxNoCall} dates,
          inside the block. The schedule generator avoids these when it can.
        </div>
        {noCallDates.map((d, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input
              type="date"
              value={d}
              min={blockStart}
              max={blockEnd}
              onChange={e => setNoCallDates(prev => prev.map((x, j) => j === i ? e.target.value : x))}
              style={{ ...inputStyle, flex: 1 }}
            />
            <RemoveButton onClick={() => setNoCallDates(prev => prev.filter((_, j) => j !== i))} />
          </div>
        ))}
        {noCallDates.length < maxNoCall && (
          <AddButton label={`+ Add no-call date (${noCallDates.length}/${maxNoCall})`}
            onClick={() => setNoCallDates(prev => [...prev, ''])} />
        )}
      </div>

      <button
        onClick={submit}
        disabled={!canSubmit}
        style={{
          width: '100%', padding: '12px 16px', borderRadius: 10, border: 'none',
          fontSize: 14, fontWeight: 800, cursor: canSubmit ? 'pointer' : 'not-allowed',
          background: canSubmit ? 'linear-gradient(135deg,#0ea5e9,#6366f1)' : 'var(--tint-surface-strong)',
          color: canSubmit ? '#fff' : 'var(--text-disabled)',
        }}
      >
        {busy ? 'Submitting…' : 'Submit Requests'}
      </button>
      <p style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 10, textAlign: 'center' }}>
        You can come back and submit more while the window is open.
      </p>
    </div>
  );
}

function RangeSection({ title, hint, ranges, onChange }: {
  title: string;
  hint: string;
  ranges: Range[];
  onChange: (next: Range[]) => void;
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={sectionHeadStyle}>{title}</div>
      <div style={hintStyle}>{hint}</div>
      {ranges.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <input
            type="date"
            value={r.start}
            onChange={e => onChange(ranges.map((x, j) => j === i
              ? { start: e.target.value, end: x.end && x.end >= e.target.value ? x.end : e.target.value }
              : x))}
            style={{ ...inputStyle, flex: 1 }}
          />
          <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>to</span>
          <input
            type="date"
            value={r.end}
            min={r.start}
            onChange={e => onChange(ranges.map((x, j) => j === i ? { ...x, end: e.target.value } : x))}
            style={{ ...inputStyle, flex: 1 }}
          />
          <RemoveButton onClick={() => onChange(ranges.filter((_, j) => j !== i))} />
        </div>
      ))}
      <AddButton label={`+ Add ${title.toLowerCase()} range`} onClick={() => onChange([...ranges, { start: '', end: '' }])} />
    </div>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{
      padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
      fontSize: 12, fontWeight: 700, background: 'var(--bg-deep)',
      color: 'var(--blue)', border: '1px dashed var(--border)',
    }}>
      {label}
    </button>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Remove" style={{
      width: 30, height: 34, borderRadius: 8, cursor: 'pointer', flexShrink: 0,
      background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)',
      fontSize: 14, lineHeight: 1,
    }}>
      ×
    </button>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--text-muted)', display: 'block',
  marginBottom: 5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
};
const sectionHeadStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 800, color: 'var(--text)', letterSpacing: 0.4,
  textTransform: 'uppercase', marginBottom: 3,
  borderBottom: '1px solid var(--border)', paddingBottom: 5,
};
const hintStyle: React.CSSProperties = {
  fontSize: 11.5, color: 'var(--text-dim)', margin: '6px 0 10px', lineHeight: 1.5,
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--bg-deep)',
  color: 'var(--text)', fontSize: 13, outline: 'none',
};
