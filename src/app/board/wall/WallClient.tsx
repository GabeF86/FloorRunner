'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Site, StaffMember, Assignment, MDDesignation, ShiftHours, Break, ReliefEntry,
  DailyDesignation, DailyShift, HOSPITALS, Hospital,
  getMinutesToRelief, getAlertLevel,
} from '@/types';
import RowsView from '../RowsView';
import { useBoardRealtime } from '../useBoardRealtime';

interface Props {
  initialSites:       Site[];
  initialStaff:       StaffMember[];
  initialAssignments: Assignment[];
  today:              string;
  hospitalParam:      string;
}

// Wall display mode (spec §9): chrome-less, full-screen Rows view meant for a
// hallway/lounge TV. No sidebar, no assistant, no modals, no edit affordances —
// just live data driven by the SAME realtime subscription as the board
// (useBoardRealtime). The server fetch (wall/page.tsx) provides sites/staff/
// today's assignments; the per-day designations + shift overrides (needed only
// to color relief-alert chips) are loaded client-side on mount, then kept live
// by the shared hook.
export default function WallClient({ initialSites, initialStaff, initialAssignments, today, hospitalParam }: Props) {
  const [sites,          setSites]          = useState<Site[]>(initialSites);
  const [staff,          setStaff]          = useState<StaffMember[]>(initialStaff);
  const [assignments,    setAssignments]    = useState<Assignment[]>(initialAssignments);
  const [designations,   setDesignations]   = useState<Record<string, MDDesignation>>({});
  const [dailyShifts,    setDailyShifts]    = useState<Record<string, ShiftHours>>({});
  // Written by the realtime hook; not rendered on the wall, but the hook's
  // setter contract needs them.
  const [, setBreaks]         = useState<Break[]>([]);
  const [, setReliefLog]      = useState<ReliefEntry[]>([]);
  const [, setActiveStaffIds] = useState<Set<string>>(new Set());

  // Load the per-day designation + shift overrides the server fetch omits.
  useEffect(() => {
    (async () => {
      try {
        const [dR, sR] = await Promise.all([
          fetch('/api/designations?date=' + today),
          fetch('/api/daily-shifts?date=' + today),
        ]);
        const [dD, sD] = await Promise.all([dR.json(), sR.json()]);
        const dm: Record<string, MDDesignation> = {};
        (dD as DailyDesignation[]).forEach((d) => { dm[d.staff_id] = d.designation; });
        setDesignations(dm);
        const sm: Record<string, ShiftHours> = {};
        (sD as DailyShift[]).forEach((s) => { sm[s.staff_id] = s.hours; });
        setDailyShifts(sm);
      } catch { /* wall is read-only; a failed refresh just leaves stale data */ }
    })();
  }, [today]);

  // Realtime — always "today" on the wall, so isToday is fixed true.
  useBoardRealtime(today, true, {
    setSites, setStaff, setAssignments, setActiveStaffIds,
    setDesignations, setDailyShifts, setBreaks, setReliefLog,
  });

  // Resolve ?hospital= against the sites.hospital NAME (BoardClient's identifier):
  // case-insensitive exact match, else a UNIQUE prefix ("Paoli" → "Paoli
  // Hospital"). No/ambiguous/unknown value → all hospitals.
  const resolvedHospital: Hospital | '' = useMemo(() => {
    const q = hospitalParam.trim().toLowerCase();
    if (!q) return '';
    const exact = HOSPITALS.find((h) => h.toLowerCase() === q);
    if (exact) return exact;
    const prefix = HOSPITALS.filter((h) => h.toLowerCase().startsWith(q));
    return prefix.length === 1 ? prefix[0] : '';
  }, [hospitalParam]);

  const filteredSites = resolvedHospital
    ? sites.filter((s) => s.is_float || s.hospital === resolvedHospital)
    : sites;

  const floatSite        = sites.find((s) => s.is_float);
  const floatAssignments = floatSite ? assignments.filter((a) => a.room_id === floatSite.id) : [];

  const roomAssignments: Record<string, Assignment[]> = {};
  assignments.forEach((a) => {
    if (!roomAssignments[a.room_id]) roomAssignments[a.room_id] = [];
    roomAssignments[a.room_id].push(a);
  });

  // Relief-alert levels — identical logic to BoardClient.
  const alertLevels: Record<string, 'none' | 'warning' | 'critical'> = {};
  staff.forEach((p) => {
    if (p.role === 'physician') {
      const desg = designations[p.id];
      alertLevels[p.id] = (!desg || desg === 'C1' || (desg !== '8hr' && desg !== '10hr')) ? 'none' : getAlertLevel(getMinutesToRelief(desg as ShiftHours));
    } else if (['crna', 'srna', 'resident'].includes(p.role)) {
      alertLevels[p.id] = getAlertLevel(getMinutesToRelief(dailyShifts[p.id] || p.hours));
    } else {
      alertLevels[p.id] = 'none';
    }
  });

  const roomCount = filteredSites.filter((s) => !s.is_float).reduce((n, s) => n + s.rooms.length, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg-base)', color: 'var(--text)' }}>
      {/* Slim top line — hospital label + room count + live clock. No nav. */}
      <header style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '8px 18px', background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)' }}>
        <span style={{ fontSize: 16, fontWeight: 750, color: 'var(--text-strong)', letterSpacing: -0.3 }}>
          {resolvedHospital || 'All Sites'}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
          {roomCount} rooms
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, color: 'var(--ok)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block', animation: 'relief-flash 1.5s ease-in-out infinite' }} />
            LIVE
          </span>
          <WallClock />
        </div>
      </header>

      <main style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
        <RowsView
          readOnly
          filteredSites={filteredSites}
          floatAssignments={floatAssignments}
          roomAssignments={roomAssignments}
          dragOver={null}
          dragging={null}
          alertLevels={alertLevels}
          dailyShifts={dailyShifts}
          // No per-site height caps on the wall — let every site's columns
          // flow to their natural height so nothing is hidden behind a scroll.
          siteHeights={{}}
        />
      </main>
    </div>
  );
}

// Clock ticking every 30s (spec §9). Starts empty and sets on mount to avoid an
// SSR/CSR hydration mismatch (mirrors BoardClient's LiveClock pattern).
function WallClock() {
  const [label, setLabel] = useState('');
  useEffect(() => {
    const fmt = () => new Date().toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    setLabel(fmt());
    const t = setInterval(() => setLabel(fmt()), 30000);
    return () => clearInterval(t);
  }, []);
  return <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--blue)', fontFamily: 'var(--font-mono), ui-monospace, monospace', letterSpacing: 0.4 }}>{label}</span>;
}
