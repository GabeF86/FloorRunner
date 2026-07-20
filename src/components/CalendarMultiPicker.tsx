'use client';

// CalendarMultiPicker — shared month-grid multi-date selector used by every
// availability add-box "Calendar" tab (PTO, Days Off, Other Leave, No-Call,
// PTO Sell-Back). ONE implementation on purpose: drag-across-days selection,
// single-day toggle clicks, month navigation, optional min/max clamping
// (no-call windows). The caller owns the selected set (sorted ISO dates) and
// collapses it into minimal ranges on submit (src/lib/dateRanges.ts).
//
// Interaction model:
//   - mousedown on a day anchors a drag; the mode is 'add' if the anchor day
//     was unselected, 'remove' if it was selected. Dragging previews the
//     linear anchor→hover span; mouseup commits it. A plain click is just a
//     one-day drag → single-day toggle.
//   - Keyboard: days are buttons (Enter/Space toggles, aria-pressed reflects
//     selection); arrow keys move focus within the month, PageUp/PageDown
//     change month.
// Weeks render Sun..Sat to match the rest of the app (DAYS_SHORT convention).

import { useEffect, useMemo, useRef, useState } from 'react';

const DAY_HEADERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoDate(year: number, month0: number, day: number): string {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

export interface CalendarMultiPickerProps {
  /** Currently selected ISO dates (order irrelevant; duplicates ignored). */
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** Inclusive selectable bounds (ISO). Days outside are disabled. */
  minDate?: string;
  maxDate?: string;
  /** Accent color for selected days (category color). */
  accent?: string;
}

export function CalendarMultiPicker({
  selected, onChange, minDate, maxDate, accent = '#0ea5e9',
}: CalendarMultiPickerProps) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Initial month: today, clamped into [minDate, maxDate] so a windowed
  // picker (no-call) opens showing selectable days.
  const [view, setView] = useState<{ year: number; month0: number }>(() => {
    const now = new Date();
    let y = now.getFullYear();
    let m = now.getMonth();
    const cur = isoDate(y, m, 1);
    if (minDate && cur < minDate.slice(0, 8) + '01') {
      y = parseInt(minDate.slice(0, 4), 10);
      m = parseInt(minDate.slice(5, 7), 10) - 1;
    } else if (maxDate && cur > maxDate.slice(0, 8) + '01') {
      y = parseInt(maxDate.slice(0, 4), 10);
      m = parseInt(maxDate.slice(5, 7), 10) - 1;
    }
    return { year: y, month0: m };
  });

  // Drag state. Anchor + hover give the linear preview span; mode decides
  // whether mouseup adds or removes it.
  const [drag, setDrag] = useState<{ anchor: string; hover: string; mode: 'add' | 'remove' } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Commit on mouseup anywhere (the pointer often leaves the grid mid-drag).
  useEffect(() => {
    const commit = () => {
      const d = dragRef.current;
      if (!d) return;
      const [lo, hi] = d.anchor <= d.hover ? [d.anchor, d.hover] : [d.hover, d.anchor];
      const next = new Set(selectedRef.current);
      // Only days actually rendered enabled can be committed — recompute the
      // clamp here so a drag over disabled edge days can't sneak them in.
      for (let cur = lo; cur <= hi; cur = nextDay(cur)) {
        if (minDate && cur < minDate) continue;
        if (maxDate && cur > maxDate) continue;
        if (d.mode === 'add') next.add(cur); else next.delete(cur);
      }
      setDrag(null);
      onChangeRef.current([...next].sort());
    };
    window.addEventListener('mouseup', commit);
    return () => window.removeEventListener('mouseup', commit);
  }, [minDate, maxDate]);

  const { year, month0 } = view;
  const firstDow = new Date(year, month0, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();

  const prevMonth = () => setView(v => v.month0 === 0
    ? { year: v.year - 1, month0: 11 }
    : { year: v.year, month0: v.month0 - 1 });
  const nextMonth = () => setView(v => v.month0 === 11
    ? { year: v.year + 1, month0: 0 }
    : { year: v.year, month0: v.month0 + 1 });

  const inDragPreview = (ds: string): boolean => {
    if (!drag) return false;
    const [lo, hi] = drag.anchor <= drag.hover ? [drag.anchor, drag.hover] : [drag.hover, drag.anchor];
    return ds >= lo && ds <= hi;
  };

  // Roving-focus keyboard navigation over the day buttons.
  const gridRef = useRef<HTMLDivElement>(null);
  const focusDay = (day: number) => {
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`button[data-day="${day}"]`);
    el?.focus();
  };
  const handleKeyDown = (e: React.KeyboardEvent, day: number) => {
    let target: number | null = null;
    if (e.key === 'ArrowLeft') target = day - 1;
    else if (e.key === 'ArrowRight') target = day + 1;
    else if (e.key === 'ArrowUp') target = day - 7;
    else if (e.key === 'ArrowDown') target = day + 7;
    else if (e.key === 'PageUp') { e.preventDefault(); prevMonth(); return; }
    else if (e.key === 'PageDown') { e.preventDefault(); nextMonth(); return; }
    else return;
    e.preventDefault();
    if (target >= 1 && target <= daysInMonth) focusDay(target);
  };

  const toggleDay = (ds: string) => {
    const next = new Set(selectedRef.current);
    if (next.has(ds)) next.delete(ds); else next.add(ds);
    onChangeRef.current([...next].sort());
  };

  const cells: React.ReactNode[] = [];
  for (let i = 0; i < firstDow; i++) {
    cells.push(<div key={`pad-${i}`} />);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = isoDate(year, month0, day);
    const disabled = (minDate !== undefined && ds < minDate) || (maxDate !== undefined && ds > maxDate);
    const isSelected = selectedSet.has(ds);
    const preview = !disabled && inDragPreview(ds);
    // Preview shows the POST-commit state: add-mode paints, remove-mode clears.
    const showSelected = preview ? drag!.mode === 'add' : isSelected;
    const dow = (firstDow + day - 1) % 7;
    const isWeekend = dow === 0 || dow === 6;
    cells.push(
      <button
        key={ds}
        type="button"
        data-day={day}
        disabled={disabled}
        aria-pressed={isSelected}
        aria-label={`${MONTH_NAMES[month0]} ${day}, ${year}${isSelected ? ' (selected)' : ''}`}
        onMouseDown={(e) => {
          if (disabled) return;
          e.preventDefault(); // avoid text-selection while dragging
          setDrag({ anchor: ds, hover: ds, mode: isSelected ? 'remove' : 'add' });
        }}
        onMouseEnter={() => {
          if (disabled) return;
          setDrag(d => (d ? { ...d, hover: ds } : d));
        }}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleDay(ds); return; }
          handleKeyDown(e, day);
        }}
        style={{
          height: 28, borderRadius: 6, fontSize: 11, fontWeight: showSelected ? 800 : 500,
          border: `1px solid ${showSelected ? accent : 'transparent'}`,
          background: showSelected
            ? `${accent}26`
            : preview
              ? 'transparent'
              : isWeekend ? 'var(--bg-deep)' : 'transparent',
          color: disabled ? 'var(--text-dim)' : showSelected ? accent : 'var(--text-muted)',
          opacity: disabled ? 0.35 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
          userSelect: 'none',
          padding: 0,
        }}
      >
        {day}
      </button>,
    );
  }

  return (
    <div style={{ maxWidth: 300 }}>
      {/* Month header + nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <button type="button" onClick={prevMonth} aria-label="Previous month" style={navBtnStyle}>‹</button>
        <div style={{
          fontSize: 12, fontWeight: 700, color: 'var(--text)',
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}>
          {MONTH_NAMES[month0]} {year}
        </div>
        <button type="button" onClick={nextMonth} aria-label="Next month" style={navBtnStyle}>›</button>
      </div>
      {/* Day-of-week headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 2 }}>
        {DAY_HEADERS.map(h => (
          <div key={h} style={{
            textAlign: 'center', fontSize: 9, fontWeight: 700, color: 'var(--text-dim)',
            textTransform: 'uppercase', letterSpacing: 0.5, padding: '2px 0',
          }}>
            {h}
          </div>
        ))}
      </div>
      {/* Day grid */}
      <div
        ref={gridRef}
        role="group"
        aria-label="Select days"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}
      >
        {cells}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
        Click a day to toggle it, or drag across days to select a span.
      </div>
    </div>
  );
}

// Next ISO day without importing engine date math into the component bundle —
// local, DST-safe (UTC), and only used for short preview spans.
function nextDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const navBtnStyle: React.CSSProperties = {
  width: 24, height: 24, borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-surface)', color: 'var(--text-muted)', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
  padding: 0,
};
