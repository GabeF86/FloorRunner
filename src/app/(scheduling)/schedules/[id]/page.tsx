'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';

/* ── Interfaces ──────────────────────────────────────────────────────────── */

interface SiteInfo {
  name: string;
  short_name: string | null;
  timezone: string | null;
}

interface Schedule {
  id: string;
  schedule_name: string;
  schedule_type: string;
  provider_group: string;
  date_start: string;
  date_end: string;
  status: string;
  sites: SiteInfo;
}

interface Version {
  id: string;
  version_number: number;
  version_status: string;
}

interface ShiftTypeInfo {
  id: string;
  code: string;
  name: string;
  color_hex: string | null;
  category: string;
  call_type: string | null;
  display_order: number | null;
  provider_group: string;
}

interface ProviderInfo {
  id: string;
  short_display_name: string;
  initials: string;
  provider_type: string;
}

interface AssignmentInfo {
  id: string;
  provider_id: string | null;
  assignment_status: string;
  is_open_call: boolean;
  manually_overridden: boolean;
  providers: ProviderInfo | null;
}

interface Slot {
  id: string;
  slot_date: string;
  shift_type_id: string;
  slot_index: number;
  locked: boolean;
  derived_day_type: string;
  shift_types: ShiftTypeInfo;
  assignments: AssignmentInfo[];
}

interface Provider {
  id: string;
  first_name: string;
  last_name: string;
  short_display_name: string;
  initials: string;
  provider_type: string;
  status: string;
}

interface Holiday {
  holiday_date: string;
  holiday_name: string;
  holiday_type: string;
  is_major_holiday: boolean;
}

interface GridData {
  schedule: Schedule;
  version: Version;
  slots: Slot[];
  providers: Provider[];
  holidays: Holiday[];
}

interface ActiveCell {
  slotId: string;
  assignmentId: string | null;
  x: number;
  y: number;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  draft:     { color: '#fbbf24', bg: 'rgba(251,191,36,0.15)' },
  published: { color: '#34d399', bg: 'rgba(52,211,153,0.15)' },
  archived:  { color: '#64748b', bg: 'rgba(100,116,139,0.15)' },
  locked:    { color: '#f87171', bg: 'rgba(248,113,113,0.15)' },
};

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00');
}

function formatMMDD(s: string): string {
  const d = parseDate(s);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateRange(start: string, end: string): string {
  const s = parseDate(start);
  const e = parseDate(end);
  const mo = (d: Date) => d.toLocaleString('en-US', { month: 'short' });
  return `${mo(s)} ${s.getDate()} - ${mo(e)} ${e.getDate()}, ${e.getFullYear()}`;
}

function getDayOfWeek(s: string): number {
  return parseDate(s).getDay();
}

function allDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = parseDate(start);
  const last = parseDate(end);
  while (cur <= last) {
    dates.push(toDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function getWeekStart(dates: string[], offset: number): number {
  // Find the first Sunday on or before the start, then offset by weeks
  const first = parseDate(dates[0]);
  const dayOfWeek = first.getDay();
  const startIdx = -dayOfWeek + offset * 7;
  return Math.max(0, startIdx);
}

function colorWithAlpha(hex: string | null, alpha: number): string {
  if (!hex) return `rgba(100,116,139,${alpha})`;
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ── Main Page ───────────────────────────────────────────────────────────── */

export default function ScheduleGridPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [grid, setGrid] = useState<GridData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'week' | 'month'>('month');
  const [weekOffset, setWeekOffset] = useState(0);
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  /* ── Data Fetching ──────────────────────────────────────────────────────── */

  const loadGrid = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/scheduling/schedules/${id}/grid`);
      if (!res.ok) throw new Error(`Failed to load schedule (${res.status})`);
      const data: GridData = await res.json();
      setGrid(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadGrid(); }, [loadGrid]);

  /* ── Close picker on outside click / Escape ─────────────────────────────── */

  useEffect(() => {
    if (!activeCell) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setActiveCell(null); setPickerSearch(''); }
    };
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setActiveCell(null);
        setPickerSearch('');
      }
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick, true);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick, true);
    };
  }, [activeCell]);

  useEffect(() => {
    if (activeCell && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [activeCell]);

  /* ── Clear action error after 3s ────────────────────────────────────────── */

  useEffect(() => {
    if (!actionError) return;
    const t = setTimeout(() => setActionError(null), 3000);
    return () => clearTimeout(t);
  }, [actionError]);

  /* ── Derived Data ───────────────────────────────────────────────────────── */

  const { shiftTypes, allDates, slotMap, holidayMap, assignedOnDate } = useMemo(() => {
    if (!grid) return { shiftTypes: [], allDates: [], slotMap: {} as Record<string, Record<string, Slot>>, holidayMap: {} as Record<string, Holiday>, assignedOnDate: {} as Record<string, Set<string>> };

    // Unique shift types sorted by display_order
    const stMap = new Map<string, ShiftTypeInfo>();
    for (const slot of grid.slots) {
      if (!stMap.has(slot.shift_type_id)) stMap.set(slot.shift_type_id, slot.shift_types);
    }
    const shiftTypes = Array.from(stMap.values()).sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999));

    // All dates in range
    const allDates = allDatesInRange(grid.schedule.date_start, grid.schedule.date_end);

    // Slot lookup: slotMap[shiftTypeId][date] → Slot
    const slotMap: Record<string, Record<string, Slot>> = {};
    for (const slot of grid.slots) {
      if (!slotMap[slot.shift_type_id]) slotMap[slot.shift_type_id] = {};
      slotMap[slot.shift_type_id][slot.slot_date] = slot;
    }

    // Holiday lookup
    const holidayMap: Record<string, Holiday> = {};
    for (const h of grid.holidays) {
      holidayMap[h.holiday_date] = h;
    }

    // Assigned on date lookup
    const assignedOnDate: Record<string, Set<string>> = {};
    for (const slot of grid.slots) {
      if (!assignedOnDate[slot.slot_date]) assignedOnDate[slot.slot_date] = new Set();
      for (const a of slot.assignments) {
        if (a.provider_id) assignedOnDate[slot.slot_date].add(a.provider_id);
      }
    }

    return { shiftTypes, allDates, slotMap, holidayMap, assignedOnDate };
  }, [grid]);

  /* ── Visible dates based on view mode ───────────────────────────────────── */

  const visibleDates = useMemo(() => {
    if (viewMode === 'month') return allDates;
    if (allDates.length === 0) return [];
    const startIdx = getWeekStart(allDates, weekOffset);
    return allDates.slice(startIdx, startIdx + 7);
  }, [viewMode, weekOffset, allDates]);

  const todayStr = toDateStr(new Date());

  /* ── Assignment Actions ─────────────────────────────────────────────────── */

  const assignProvider = async (slotId: string, providerId: string) => {
    if (!grid) return;
    // Optimistic update
    const prevSlots = [...grid.slots];
    setGrid({
      ...grid,
      slots: grid.slots.map(s => {
        if (s.id !== slotId) return s;
        const provider = grid.providers.find(p => p.id === providerId);
        const newAssignment: AssignmentInfo = {
          id: 'temp-' + Date.now(),
          provider_id: providerId,
          assignment_status: 'assigned',
          is_open_call: false,
          manually_overridden: true,
          providers: provider ? { id: provider.id, short_display_name: provider.short_display_name, initials: provider.initials, provider_type: provider.provider_type } : null,
        };
        return { ...s, assignments: [newAssignment] };
      }),
    });
    setActiveCell(null);
    setPickerSearch('');

    try {
      const res = await fetch('/api/scheduling/schedule-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule_slot_id: slotId, provider_id: providerId }),
      });
      if (!res.ok) throw new Error('Failed to assign');
      // Reload to get real IDs
      await loadGrid();
    } catch {
      setGrid({ ...grid, slots: prevSlots });
      setActionError('Failed to assign provider');
    }
  };

  const removeAssignment = async (assignmentId: string) => {
    if (!grid) return;
    const prevSlots = [...grid.slots];
    setGrid({
      ...grid,
      slots: grid.slots.map(s => ({
        ...s,
        assignments: s.assignments.filter(a => a.id !== assignmentId),
      })),
    });
    setActiveCell(null);

    try {
      const res = await fetch(`/api/scheduling/schedule-assignments?id=${assignmentId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove');
      await loadGrid();
    } catch {
      setGrid({ ...grid, slots: prevSlots });
      setActionError('Failed to remove assignment');
    }
  };

  const toggleLock = async (slotId: string, currentLocked: boolean) => {
    if (!grid) return;
    setGrid({
      ...grid,
      slots: grid.slots.map(s => s.id === slotId ? { ...s, locked: !currentLocked } : s),
    });
    setActiveCell(null);
    // TODO: PATCH slot lock status when API endpoint is available
  };

  const publishSchedule = async () => {
    if (!grid) return;
    try {
      const res = await fetch(`/api/scheduling/schedules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'published' }),
      });
      if (!res.ok) throw new Error('Failed to publish');
      await loadGrid();
    } catch {
      setActionError('Failed to publish schedule');
    }
  };

  /* ── Render: Loading / Error ────────────────────────────────────────────── */

  if (loading && !grid) {
    return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading schedule...</div>;
  }
  if (error) {
    return <div style={{ padding: 40, color: '#f87171' }}>{error}</div>;
  }
  if (!grid) return null;

  const { schedule, version } = grid;
  const sc = STATUS_COLORS[schedule.status] || STATUS_COLORS.draft;
  const colCount = visibleDates.length;

  /* ── Find the active slot for the picker ────────────────────────────────── */

  const activeSlot = activeCell ? grid.slots.find(s => s.id === activeCell.slotId) : null;
  const activeAssignment = activeCell?.assignmentId ? activeSlot?.assignments.find(a => a.id === activeCell.assignmentId) : null;
  const isAssignedCell = !!activeAssignment?.provider_id;

  /* ── Provider list for picker ───────────────────────────────────────────── */

  const filteredProviders = useMemo(() => {
    if (!grid || !activeSlot) return [];
    const search = pickerSearch.toLowerCase();
    return grid.providers
      .filter(p => p.status === 'active')
      .filter(p => {
        if (!search) return true;
        return p.short_display_name.toLowerCase().includes(search)
          || p.first_name.toLowerCase().includes(search)
          || p.last_name.toLowerCase().includes(search)
          || p.initials.toLowerCase().includes(search);
      })
      .sort((a, b) => a.short_display_name.localeCompare(b.short_display_name));
  }, [grid, activeSlot, pickerSearch]);

  const activeSlotDate = activeSlot?.slot_date ?? '';
  const assignedOnActiveDate = assignedOnDate[activeSlotDate] ?? new Set<string>();

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div style={{ padding: '24px 32px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Breadcrumb */}
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
        <Link href="/schedules" style={{ color: '#0ea5e9', textDecoration: 'none' }}>Schedules</Link>
        <span style={{ margin: '0 6px' }}>/</span>
        <span style={{ color: 'var(--text-muted)' }}>{schedule.schedule_name}</span>
      </div>

      {/* Top Bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', margin: 0 }}>{schedule.schedule_name}</h1>

        {/* Status badge */}
        <span style={{
          fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
          padding: '3px 10px', borderRadius: 999,
          color: sc.color, background: sc.bg,
        }}>
          {schedule.status}
        </span>

        {/* Version badge */}
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          v{version.version_number} ({version.version_status})
        </span>

        {/* Date range */}
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {formatDateRange(schedule.date_start, schedule.date_end)}
        </span>

        <div style={{ flex: 1 }} />

        {/* View toggle */}
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
          {(['week', 'month'] as const).map(m => (
            <button
              key={m}
              onClick={() => { setViewMode(m); setWeekOffset(0); }}
              style={{
                padding: '5px 14px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: viewMode === m ? 'rgba(14,165,233,0.2)' : 'var(--bg-surface)',
                color: viewMode === m ? '#0ea5e9' : 'var(--text-muted)',
              }}
            >
              {m === 'week' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>

        {/* Week navigation */}
        {viewMode === 'week' && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={() => setWeekOffset(o => Math.max(0, o - 1))}
              style={{
                width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--bg-surface)', color: 'var(--text-muted)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
              }}
            >
              &#8592;
            </button>
            <button
              onClick={() => {
                const maxWeeks = Math.ceil(allDates.length / 7);
                setWeekOffset(o => Math.min(maxWeeks - 1, o + 1));
              }}
              style={{
                width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--bg-surface)', color: 'var(--text-muted)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
              }}
            >
              &#8594;
            </button>
          </div>
        )}

        {/* Publish button */}
        {schedule.status === 'draft' && (
          <button
            onClick={publishSchedule}
            style={{
              padding: '6px 18px', fontSize: 13, fontWeight: 700, border: 'none', borderRadius: 6,
              background: 'linear-gradient(135deg, #0ea5e9, #6366f1)', color: '#fff', cursor: 'pointer',
            }}
          >
            Publish
          </button>
        )}
      </div>

      {/* Action error toast */}
      {actionError && (
        <div style={{
          position: 'fixed', top: 20, right: 20, padding: '10px 20px', borderRadius: 8,
          background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.3)',
          color: '#f87171', fontSize: 13, fontWeight: 600, zIndex: 600,
        }}>
          {actionError}
        </div>
      )}

      {/* Grid Container */}
      <div style={{ flex: 1, overflow: 'auto', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-deep)' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: `160px repeat(${colCount}, minmax(100px, 1fr))`,
          minWidth: colCount > 7 ? `${160 + colCount * 100}px` : undefined,
        }}>

          {/* ── Row 0: Day-of-week header ─────────────────────────────────── */}

          {/* Corner cell */}
          <div style={{
            position: 'sticky', top: 0, left: 0, zIndex: 4,
            background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)',
            borderRight: '1px solid var(--border)', padding: '8px 12px',
          }} />

          {/* Day-of-week labels */}
          {visibleDates.map((date, i) => {
            const dow = getDayOfWeek(date);
            const isWeekend = dow === 0 || dow === 6;
            const isHoliday = !!holidayMap[date];
            const isToday = date === todayStr;
            const isSatBorder = dow === 6 && i > 0;
            return (
              <div key={`dow-${date}`} style={{
                position: 'sticky', top: 0, zIndex: 3,
                background: isHoliday ? 'rgba(251,191,36,0.06)' : isWeekend ? 'rgba(99,102,241,0.04)' : 'var(--bg-surface)',
                borderBottom: '1px solid var(--border)',
                borderRight: '1px solid var(--border)',
                borderLeft: isToday ? '2px solid rgba(14,165,233,0.4)' : isSatBorder ? '2px solid rgba(30,58,95,0.6)' : 'none',
                padding: '6px 8px', textAlign: 'center',
                fontSize: 11, fontWeight: 700, color: isWeekend ? '#6366f1' : 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                {DAYS_SHORT[dow]}
              </div>
            );
          })}

          {/* ── Row 1: Date header ────────────────────────────────────────── */}

          {/* Corner cell "Shifts" */}
          <div style={{
            position: 'sticky', top: 36, left: 0, zIndex: 4,
            background: 'var(--bg-surface)', borderBottom: '2px solid var(--border)',
            borderRight: '1px solid var(--border)', padding: '6px 12px',
            fontSize: 12, fontWeight: 700, color: 'var(--text-muted)',
          }}>
            Shifts
          </div>

          {/* Date labels */}
          {visibleDates.map((date, i) => {
            const dow = getDayOfWeek(date);
            const isWeekend = dow === 0 || dow === 6;
            const holiday = holidayMap[date];
            const isToday = date === todayStr;
            const isSatBorder = dow === 6 && i > 0;
            return (
              <div key={`date-${date}`} title={holiday ? holiday.holiday_name : undefined} style={{
                position: 'sticky', top: 36, zIndex: 3,
                background: holiday ? 'rgba(251,191,36,0.06)' : isWeekend ? 'rgba(99,102,241,0.04)' : 'var(--bg-surface)',
                borderBottom: '2px solid var(--border)',
                borderRight: '1px solid var(--border)',
                borderLeft: isToday ? '2px solid rgba(14,165,233,0.4)' : isSatBorder ? '2px solid rgba(30,58,95,0.6)' : 'none',
                padding: '6px 8px', textAlign: 'center',
                fontSize: 12, fontWeight: 600, color: isToday ? '#0ea5e9' : 'var(--text)',
              }}>
                {formatMMDD(date)}
                {holiday && (
                  <div style={{ fontSize: 9, color: '#fbbf24', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {holiday.holiday_name}
                  </div>
                )}
              </div>
            );
          })}

          {/* ── Data Rows: one per shift type ─────────────────────────────── */}

          {shiftTypes.map(st => (
            <>
              {/* Shift label cell */}
              <div key={`label-${st.id}`} style={{
                position: 'sticky', left: 0, zIndex: 2,
                background: 'var(--bg-surface)',
                borderLeft: `4px solid ${st.color_hex || '#64748b'}`,
                borderBottom: '1px solid rgba(30,58,95,0.4)',
                borderRight: '1px solid var(--border)',
                padding: '8px 10px', display: 'flex', flexDirection: 'column', justifyContent: 'center',
                minHeight: 44,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>{st.code}</div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{st.name}</div>
              </div>

              {/* Assignment cells */}
              {visibleDates.map((date, i) => {
                const slot = slotMap[st.id]?.[date];
                const assignment = slot?.assignments?.[0] ?? null;
                const provider = assignment?.providers ?? null;
                const isAssigned = !!provider;
                const isOpenCall = assignment?.is_open_call ?? false;
                const isLocked = slot?.locked ?? false;
                const dow = getDayOfWeek(date);
                const isWeekend = dow === 0 || dow === 6;
                const isHoliday = !!holidayMap[date];
                const isToday = date === todayStr;
                const isSatBorder = dow === 6 && i > 0;

                const cellBg = isHoliday ? 'rgba(251,191,36,0.06)' : isWeekend ? 'rgba(99,102,241,0.04)' : 'transparent';

                return (
                  <div
                    key={`cell-${st.id}-${date}`}
                    onClick={(e) => {
                      if (!slot) return;
                      setActiveCell({
                        slotId: slot.id,
                        assignmentId: assignment?.id ?? null,
                        x: e.clientX,
                        y: e.clientY,
                      });
                      setPickerSearch('');
                    }}
                    style={{
                      background: cellBg,
                      borderBottom: '1px solid rgba(30,58,95,0.4)',
                      borderRight: '1px solid var(--border)',
                      borderLeft: isToday ? '2px solid rgba(14,165,233,0.4)' : isSatBorder ? '2px solid rgba(30,58,95,0.6)' : 'none',
                      padding: '4px 6px',
                      minHeight: 44,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: slot ? 'pointer' : 'default',
                      position: 'relative',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={(e) => {
                      if (slot) (e.currentTarget as HTMLDivElement).style.background = isHoliday ? 'rgba(251,191,36,0.12)' : isWeekend ? 'rgba(99,102,241,0.10)' : 'rgba(14,165,233,0.06)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = cellBg;
                    }}
                  >
                    {!slot ? null : isAssigned ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                        <span style={{
                          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                          background: colorWithAlpha(st.color_hex, 0.15),
                          color: st.color_hex || 'var(--text)',
                        }}>
                          {provider!.short_display_name}
                        </span>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3,
                          background: 'rgba(100,116,139,0.2)', color: 'var(--text-dim)',
                          textTransform: 'uppercase',
                        }}>
                          {provider!.provider_type}
                        </span>
                      </div>
                    ) : isOpenCall ? (
                      <span style={{
                        fontSize: 11, fontWeight: 600, color: '#f87171',
                        background: 'rgba(248,113,113,0.1)', padding: '2px 8px', borderRadius: 4,
                      }}>
                        OPEN
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>OPEN</span>
                    )}

                    {/* Lock icon */}
                    {isLocked && (
                      <span style={{
                        position: 'absolute', top: 2, right: 4, fontSize: 10, lineHeight: 1,
                      }}>
                        &#x1F512;
                      </span>
                    )}
                  </div>
                );
              })}
            </>
          ))}
        </div>
      </div>

      {/* ── Provider Picker / Action Popover ──────────────────────────────── */}

      {activeCell && (
        <div
          ref={pickerRef}
          style={{
            position: 'fixed',
            left: Math.min(activeCell.x, window.innerWidth - 280),
            top: Math.min(activeCell.y, window.innerHeight - 360),
            width: 260,
            maxHeight: 340,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            zIndex: 500,
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {isAssignedCell ? (
            /* ── Assigned cell: action popover ──────────────────────────────── */
            <div style={{ padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
                {activeAssignment?.providers?.short_display_name ?? 'Unknown'}
              </div>
              <div style={{
                fontSize: 10, fontWeight: 600, color: 'var(--text-dim)',
                textTransform: 'uppercase', marginBottom: 12,
              }}>
                {activeAssignment?.providers?.provider_type}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button
                  onClick={() => activeAssignment && removeAssignment(activeAssignment.id)}
                  style={{
                    padding: '6px 12px', fontSize: 12, fontWeight: 600, border: '1px solid rgba(248,113,113,0.3)',
                    borderRadius: 6, background: 'rgba(248,113,113,0.1)', color: '#f87171', cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  Remove Assignment
                </button>
                <button
                  onClick={() => {
                    if (activeSlot) toggleLock(activeSlot.id, activeSlot.locked);
                  }}
                  style={{
                    padding: '6px 12px', fontSize: 12, fontWeight: 600, border: '1px solid var(--border)',
                    borderRadius: 6, background: 'var(--bg-deep)', color: 'var(--text-muted)', cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {activeSlot?.locked ? 'Unlock Slot' : 'Lock Slot'}
                </button>
              </div>
            </div>
          ) : (
            /* ── Unassigned cell: provider picker ───────────────────────────── */
            <>
              <div style={{ padding: '10px 10px 6px 10px' }}>
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search providers..."
                  value={pickerSearch}
                  onChange={e => setPickerSearch(e.target.value)}
                  style={{
                    width: '100%', padding: '6px 10px', fontSize: 12, borderRadius: 6,
                    border: '1px solid var(--border)', background: 'var(--bg-deep)',
                    color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
                {filteredProviders.length === 0 && (
                  <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-dim)' }}>
                    No providers found
                  </div>
                )}
                {filteredProviders.map(p => {
                  const alreadyAssigned = assignedOnActiveDate.has(p.id);
                  return (
                    <div
                      key={p.id}
                      onClick={() => activeSlot && assignProvider(activeSlot.id, p.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '7px 14px', cursor: 'pointer',
                        opacity: alreadyAssigned ? 0.5 : 1,
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(14,165,233,0.08)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* Initials avatar */}
                      <div style={{
                        width: 24, height: 24, borderRadius: '50%', fontSize: 10, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(14,165,233,0.15)', color: '#0ea5e9',
                        flexShrink: 0,
                      }}>
                        {p.initials}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.short_display_name}
                          {alreadyAssigned && <span style={{ fontWeight: 400, color: 'var(--text-dim)', marginLeft: 4 }}>(assigned)</span>}
                        </div>
                      </div>
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                        background: 'rgba(100,116,139,0.2)', color: 'var(--text-dim)',
                        textTransform: 'uppercase', flexShrink: 0,
                      }}>
                        {p.provider_type}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
