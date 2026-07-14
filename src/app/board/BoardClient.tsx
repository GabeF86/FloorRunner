'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import {
  Site, StaffMember, Assignment, Role, ShiftHours, DraggedPerson,
  DailyDesignation, DailyShift, Break, ReliefEntry, MDDesignation,
  BreakType, getMinutesToRelief, getAlertLevel,
  addDays, formatDateLabel, HOSPITALS, Hospital,
} from '@/types';
import { computeSupervisionLoads } from '@/lib/boardLogic';
import { BT } from './boardTheme';
import { useBoardRealtime } from './useBoardRealtime';
import BoardAssistantPanel from './BoardAssistantPanel';
import Sidebar from './Sidebar';
import SiteCard from './SiteCard';
import { StatsInline, SupervisionBanner } from './StatsBar';
import FloatBar from './FloatBar';
import OutListPanel from './OutListPanel';
import RelievedBox from './RelievedBox';
import PrintView from './PrintView';
import NetworkView from './NetworkView';
import RowsView from './RowsView';
import { AddSiteModal, AddStaffModal, AddRoomModal } from './Modals';

interface Props {
  initialSites:       Site[];
  initialStaff:       StaffMember[];
  initialAssignments: Assignment[];
  today:              string;
}

const HOSPITAL_BASELINES: Record<string, { name: string; color: string; icon: string; rooms: string[] }[]> = {
  'Paoli Hospital': [
    { name: 'Main OR', color: '#0ea5e9', icon: '🏥', rooms: Array.from({ length: 15 }, (_, i) => `OR ${i + 1}`) },
    { name: 'Endoscopy', color: '#10b981', icon: '🔬', rooms: ['Endo 1', 'Endo 2'] },
    { name: 'Neuro', color: '#a78bfa', icon: '🧠', rooms: ['Neuro 1'] },
    { name: 'EP Lab', color: '#f59e0b', icon: '⚡', rooms: ['EP 1'] },
    { name: 'OB', color: '#f472b6', icon: '👶', rooms: ['OB 1'] },
  ],
};

export default function BoardClient({ initialSites, initialStaff, initialAssignments, today }: Props) {
  const [sites,         setSites]         = useState<Site[]>(initialSites);
  const [staff,         setStaff]         = useState<StaffMember[]>(initialStaff);
  const [assignments,   setAssignments]   = useState<Assignment[]>(initialAssignments);
  const [designations,  setDesignations]  = useState<Record<string, MDDesignation>>({});
  const [dailyShifts,   setDailyShifts]   = useState<Record<string, ShiftHours>>({});
  const [breaks,        setBreaks]        = useState<Break[]>([]);
  const [reliefLog,     setReliefLog]     = useState<ReliefEntry[]>([]);
  const [activeStaffIds,setActiveStaffIds]= useState<Set<string>>(new Set());
  const [dragging,      setDragging]      = useState<DraggedPerson | null>(null);
  const [dragOver,      setDragOver]      = useState<string | null>(null);
  const [saving,        setSaving]        = useState(false);
  const [showAddSite,   setShowAddSite]   = useState(false);
  const [showAddStaff,  setShowAddStaff]  = useState(false);
  const [showAddRoom,   setShowAddRoom]   = useState<string | null>(null);
  const [showPrint,     setShowPrint]     = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [siteHeights,   setSiteHeights]   = useState<Record<string, number>>({});
  const [hospital, setHospital] = useState<Hospital | ''>('');
  const [sidebarWidth, setSidebarWidth] = useState<number>(290);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'rows' | 'network'>('grid');

  // Hydrate from localStorage after mount to avoid SSR mismatch
  useEffect(() => {
    try { const v = localStorage.getItem('siteHeights'); if (v) setSiteHeights(JSON.parse(v)); } catch {}
    try { const v = localStorage.getItem('hospital'); if (v) setHospital(v as Hospital); } catch {}
    try { const v = localStorage.getItem('sidebarWidth'); if (v) setSidebarWidth(parseInt(v)); } catch {}
    try { const v = localStorage.getItem('sidebarCollapsed'); if (v) setSidebarCollapsed(v === 'true'); } catch {}
    try {
      const m = localStorage.getItem('boardViewMode');
      if (m === 'grid' || m === 'rows' || m === 'network') setViewMode(m);
    } catch {}
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('sidebarCollapsed', String(next)); } catch {}
      return next;
    });
  }, []);

  // ⌘B / Ctrl+B toggles the sidebar rail — guard against stealing the
  // shortcut while the user is typing in an input/textarea (or contentEditable).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'b') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      e.preventDefault();
      toggleSidebarCollapsed();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleSidebarCollapsed]);

  const setViewModePersistent = useCallback((m: 'grid' | 'rows' | 'network') => {
    setViewMode(m);
    try { localStorage.setItem('boardViewMode', m); } catch {}
  }, []);

  const sidebarResizing = useRef(false);

  const [viewDate, setViewDate] = useState(today);
  const isToday    = viewDate === today;
  const isPlanMode = !isToday;

  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // ── Load daily data ───────────────────────────────────────────────────────
  async function loadDailyData(date: string) {
    const [dR, sR, bR, rR, aR, acR] = await Promise.all([
      fetch('/api/designations?date='   + date),
      fetch('/api/daily-shifts?date='   + date),
      fetch('/api/breaks?date='         + date),
      fetch('/api/relief?date='         + date),
      fetch('/api/assignments?date='    + date),
      fetch('/api/daily-active?date='   + date),
    ]);
    const [dD, sD, bD, rD, aD, acD] = await Promise.all([
      dR.json(), sR.json(), bR.json(), rR.json(), aR.json(), acR.json()
    ]);
    const dm: Record<string, MDDesignation> = {};
    (dD as DailyDesignation[]).forEach((d) => { dm[d.staff_id] = d.designation; });
    setDesignations(dm);
    const sm: Record<string, ShiftHours> = {};
    (sD as DailyShift[]).forEach((s) => { sm[s.staff_id] = s.hours; });
    setDailyShifts(sm);
    setBreaks(bD as Break[]);
    setReliefLog(rD as ReliefEntry[]);
    setAssignments(aD as Assignment[]);
    setActiveStaffIds(new Set((acD as { staff_id: string }[]).map((r) => r.staff_id)));
  }

  useEffect(() => { loadDailyData(viewDate); }, [viewDate]);

  // ── Load staff client-side (re-fetch when hospital changes) ───────────────
  useEffect(() => {
    supabase.from('staff').select('*').order('role').order('name').then(({ data }) => {
      if (data) setStaff(data as StaffMember[]);
    });
  }, [hospital]);

  // ── Real-time (shared with the wall display via useBoardRealtime) ─────────
  useBoardRealtime(today, isToday, {
    setSites, setStaff, setAssignments, setActiveStaffIds,
    setDesignations, setDailyShifts, setBreaks, setReliefLog,
  });

  // ── Active staff toggle ───────────────────────────────────────────────────
  const toggleActive = useCallback(async (staffId: string, active: boolean) => {
    setActiveStaffIds((prev) => {
      const next = new Set(prev);
      if (active) next.add(staffId); else next.delete(staffId);
      return next;
    });
    if (active) {
      await fetch('/api/daily-active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staff_id: staffId, board_date: viewDate }) });
    } else {
      await fetch('/api/daily-active?staff_id=' + staffId + '&date=' + viewDate, { method: 'DELETE' });
      // Also unassign them from any rooms
      const existing = assignments.filter((a) => a.staff_id === staffId);
      if (existing.length) {
        setAssignments((prev) => prev.filter((a) => a.staff_id !== staffId));
        await Promise.all(existing.map((a) => fetch('/api/assignments?id=' + a.id, { method: 'DELETE' })));
      }
    }
  }, [viewDate, assignments]);

  // ── Float site ────────────────────────────────────────────────────────────
  const floatSite         = sites.find((s) => s.is_float);
  const floatAssignments  = floatSite ? assignments.filter((a) => a.room_id === floatSite.id) : [];
  const floatStaffIds     = new Set(floatAssignments.map((a) => a.staff_id));

  // ── Room reorder ──────────────────────────────────────────────────────────
  const handleReorderRoom = useCallback((siteId: string, roomId: string, targetRoomId: string) => {
    setSites((prev) => prev.map((s) => {
      if (s.id !== siteId) return s;
      const rooms  = [...s.rooms];
      const fromIdx = rooms.findIndex((r) => r.id === roomId);
      const toIdx   = rooms.findIndex((r) => r.id === targetRoomId);
      if (fromIdx === -1 || toIdx === -1) return s;
      const [moved] = rooms.splice(fromIdx, 1);
      rooms.splice(toIdx, 0, moved);
      return { ...s, rooms };
    }));
    // Persist sort order
    setSites((prev) => {
      const site = prev.find((s) => s.id === siteId);
      if (!site) return prev;
      site.rooms.forEach((r, i) => {
        fetch('/api/rooms', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.id, sort_order: i }) });
      });
      return prev;
    });
  }, []);

  // ── Site reorder ──────────────────────────────────────────────────────────
  const draggingSiteId = useRef<string | null>(null);
  const handleReorderSite = useCallback((siteId: string, targetSiteId: string) => {
    setSites((prev) => {
      const arr     = [...prev];
      const fromIdx = arr.findIndex((s) => s.id === siteId);
      const toIdx   = arr.findIndex((s) => s.id === targetSiteId);
      if (fromIdx === -1 || toIdx === -1) return arr;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      arr.forEach((s, i) => {
        fetch('/api/sites', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id, position: i }) });
      });
      return arr;
    });
  }, []);

  // ── Drag staff ────────────────────────────────────────────────────────────
  const handleDragStart = useCallback((person: DraggedPerson) => setDragging(person), []);

  const handleDrop = useCallback(async (roomId: string) => {
    if (!dragging) return;
    setSaving(true);
    const isPhysician = dragging.role === 'physician';
    setAssignments((prev) => {
      const filtered    = isPhysician ? prev : prev.filter((a) => a.staff_id !== dragging.id);
      const alreadyThere = filtered.some((a) => a.staff_id === dragging.id && a.room_id === roomId);
      if (alreadyThere) return filtered;
      return [...filtered, { id: 'opt-' + Date.now(), room_id: roomId, staff_id: dragging.id, board_date: viewDate, staff: dragging } as Assignment];
    });
    await fetch('/api/assignments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: roomId, staff_id: dragging.id, board_date: viewDate, role: dragging.role }),
    });
    setDragging(null); setDragOver(null); setSaving(false);
  }, [dragging, viewDate]);

  const handleDropFloat = useCallback(async (siteId: string) => {
    if (!dragging) return;
    setSaving(true);
    const isPhysician   = dragging.role === 'physician';
    const existing      = assignments.filter((a) => a.staff_id === dragging.id);
    const alreadyFloat  = existing.some((a) => a.room_id === siteId);
    if (alreadyFloat) { setDragging(null); setDragOver(null); setSaving(false); return; }
    if (!isPhysician) {
      setAssignments((prev) => prev.filter((a) => a.staff_id !== dragging.id));
      await Promise.all(existing.map((a) => fetch('/api/assignments?id=' + a.id, { method: 'DELETE' })));
    }
    setAssignments((prev) => [...prev, { id: 'opt-' + Date.now(), room_id: siteId, staff_id: dragging.id, board_date: viewDate, staff: dragging } as Assignment]);
    await fetch('/api/assignments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: siteId, staff_id: dragging.id, board_date: viewDate, role: dragging.role }),
    });
    setDragging(null); setDragOver(null); setSaving(false);
  }, [dragging, assignments, viewDate]);

  const handleDropSidebar = useCallback(async () => {
    if (!dragging) return;
    const existing = assignments.filter((a) => a.staff_id === dragging.id);
    if (!existing.length) { setDragging(null); return; }
    setAssignments((prev) => prev.filter((a) => a.staff_id !== dragging.id));
    await Promise.all(existing.map((a) => fetch('/api/assignments?id=' + a.id, { method: 'DELETE' })));
    setDragging(null); setDragOver(null);
  }, [dragging, assignments]);

  const handleDropRelieved = useCallback(async (person: DraggedPerson) => {
    const existing   = assignments.filter((a) => a.staff_id === person.id);
    setAssignments((prev) => prev.filter((a) => a.staff_id !== person.id));
    await Promise.all(existing.map((a) => fetch('/api/assignments?id=' + a.id, { method: 'DELETE' })));
    const shiftHours = dailyShifts[person.id] || person.hours;
    const desg       = designations[person.id];
    const res = await fetch('/api/relief', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: person.id, staff_name: person.name, staff_role: person.role, staff_initials: person.initials, board_date: viewDate, designation: desg, shift_hours: shiftHours }),
    });
    const entry = await res.json();
    setReliefLog((prev) => [...prev, entry]);
    setDragging(null);
  }, [assignments, dailyShifts, designations, viewDate]);

  const removeAssignment = useCallback(async (id: string) => {
    setAssignments((prev) => prev.filter((a) => a.id !== id));
    await fetch('/api/assignments?id=' + id, { method: 'DELETE' });
  }, []);

  // ── Designation / Shift / Breaks ──────────────────────────────────────────
  const setDesignation = useCallback(async (staffId: string, designation: MDDesignation | null) => {
    if (!designation) {
      setDesignations((prev) => { const n = { ...prev }; delete n[staffId]; return n; });
      await fetch('/api/designations?staff_id=' + staffId + '&date=' + viewDate, { method: 'DELETE' });
    } else {
      setDesignations((prev) => ({ ...prev, [staffId]: designation }));
      await fetch('/api/designations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staff_id: staffId, board_date: viewDate, designation }) });
    }
  }, [viewDate]);

  const setDailyShift = useCallback(async (staffId: string, hours: ShiftHours) => {
    setDailyShifts((prev) => ({ ...prev, [staffId]: hours }));
    await fetch('/api/daily-shifts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staff_id: staffId, board_date: viewDate, hours }) });
  }, [viewDate]);

  const toggleBreak = useCallback(async (staffId: string, breakType: BreakType, taken: boolean) => {
    setBreaks((prev) => {
      const ex = prev.find((b) => b.staff_id === staffId && b.break_type === breakType);
      if (ex) return prev.map((b) => b.staff_id === staffId && b.break_type === breakType ? { ...b, taken } : b);
      return [...prev, { id: 'opt-' + Date.now(), staff_id: staffId, board_date: viewDate, break_type: breakType, taken } as Break];
    });
    await fetch('/api/breaks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staff_id: staffId, board_date: viewDate, break_type: breakType, taken }) });
  }, [viewDate]);

  // ── Sidebar resize ────────────────────────────────────────────────────────
  function onSidebarResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    sidebarResizing.current = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    function onMove(ev: MouseEvent) {
      if (!sidebarResizing.current) return;
      const next = Math.min(480, Math.max(200, startW + ev.clientX - startX));
      setSidebarWidth(next);
      try { localStorage.setItem('sidebarWidth', String(next)); } catch {}
    }
    function onUp() {
      sidebarResizing.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ── Site height resize ────────────────────────────────────────────────────
  const setSiteHeight = useCallback((siteId: string, height: number) => {
    setSiteHeights((prev) => {
      const next = { ...prev, [siteId]: height };
      try { localStorage.setItem('siteHeights', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // ── Sites / Rooms / Staff CRUD ────────────────────────────────────────────
  const addSite = useCallback(async (name: string, color: string, icon: string) => {
    const res  = await fetch('/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color, icon, position: sites.length + 1, hospital: hospital || null }) });
    const data = await res.json();
    setSites((prev) => [...prev, { ...data, rooms: [] }]);
    setShowAddSite(false);
  }, [sites.length, hospital]);

  const deleteSite = useCallback(async (id: string) => {
    setSites((prev) => prev.filter((s) => s.id !== id));
    await fetch('/api/sites?id=' + id, { method: 'DELETE' });
  }, []);

  const resetBoard = useCallback(async () => {
    if (!hospital || !HOSPITAL_BASELINES[hospital]) return;
    if (!confirm(`Reset ${hospital} board?\n\n• All today's assignments will be cleared\n• All sites/rooms will be restored to baseline`)) return;
    setSaving(true);
    const siteIdsToDelete = sites.filter((s) => !s.is_float && s.hospital === hospital).map((s) => s.id);
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hospital, date: viewDate, siteIdsToDelete, baseline: HOSPITAL_BASELINES[hospital] }),
    });
    if (!res.ok) { setSaving(false); alert('Reset failed: ' + await res.text()); return; }
    const { sites: newSites } = await res.json();
    setAssignments([]);
    setSites((prev) => [...prev.filter((s) => s.is_float), ...newSites]);
    setSaving(false);
  }, [hospital, sites, viewDate]);

  const addRoom = useCallback(async (siteId: string, name: string) => {
    const res  = await fetch('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site_id: siteId, name, position: 99 }) });
    if (!res.ok) { const err = await res.text(); console.error('addRoom failed:', err); alert('Failed to add room: ' + err); return; }
    const data = await res.json();
    setSites((prev) => prev.map((s) => s.id === siteId ? { ...s, rooms: [...s.rooms, data] } : s));
    setShowAddRoom(null);
  }, []);

  const deleteRoom = useCallback(async (siteId: string, roomId: string) => {
    setSites((prev) => prev.map((s) => s.id === siteId ? { ...s, rooms: s.rooms.filter((r) => r.id !== roomId) } : s));
    setAssignments((prev) => prev.filter((a) => a.room_id !== roomId));
    await fetch('/api/rooms?id=' + roomId, { method: 'DELETE' });
  }, []);

  const addStaff = useCallback(async (name: string, role: Role, hours: ShiftHours, homeHospital: string | null) => {
    const initials = name.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2);
    const staffHospital = homeHospital || hospital || null;
    const res  = await fetch('/api/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, initials, role, hours, hospital: staffHospital }) });
    const data = await res.json();
    setStaff((prev) => [...prev, data]);
    setShowAddStaff(false);
  }, [hospital]);

  const deleteStaff = useCallback(async (id: string) => {
    setStaff((prev) => prev.filter((p) => p.id !== id));
    setAssignments((prev) => prev.filter((a) => a.staff_id !== id));
    await fetch('/api/staff?id=' + id, { method: 'DELETE' });
  }, []);

  const updateStaffHours = useCallback(async (id: string, hours: ShiftHours) => {
    setStaff((prev) => prev.map((p) => p.id === id ? { ...p, hours } : p));
    await fetch('/api/staff', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, hours }) });
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────
  const relievedIds      = new Set(reliefLog.map((r) => r.staff_id));
  const hospitalStaff    = hospital ? staff.filter((p) => p.hospital === hospital || !p.hospital) : staff;
  const activeStaff      = hospitalStaff.filter((p) => !relievedIds.has(p.id));
  const realRoomIds      = new Set(sites.filter((s) => !s.is_float).flatMap((s) => s.rooms.map((r) => r.id)));
  const realAssignedIds  = new Set(assignments.filter((a) => realRoomIds.has(a.room_id)).map((a) => a.staff_id));
  const assignedStaffIds = new Set(assignments.map((a) => a.staff_id));

  const roomAssignments: Record<string, Assignment[]> = {};
  assignments.forEach((a) => {
    if (!roomAssignments[a.room_id]) roomAssignments[a.room_id] = [];
    roomAssignments[a.room_id].push(a);
  });

  const supervisionLoads = computeSupervisionLoads(assignments, roomAssignments);

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

  const breaksMap: Record<string, Break[]> = {};
  breaks.forEach((b) => {
    if (!breaksMap[b.staff_id]) breaksMap[b.staff_id] = [];
    breaksMap[b.staff_id].push(b);
  });

  const dateLabel = formatDateLabel(viewDate);

  // Filter sites by selected hospital (float site always visible)
  const isSmallSite = (name: string) => {
    const n = name.toLowerCase();
    return n.includes('neuro') || n.includes('ep') || n.includes('endo') || n.includes(' ob') || n === 'ob' || n.startsWith('ob ') || n.includes('labor') || n.includes('l&d');
  };

  const filteredSites = hospital
    ? sites.filter((s) => s.is_float || s.hospital === hospital)
    : sites;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg-base)', color: 'var(--text)' }}>

      {/* TOP UTILITY BAR */}
      <header style={{ background: 'var(--bg-surface)', borderBottom: '0.5px solid var(--border)', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', top: 0, zIndex: 40, minHeight: 38, fontSize: 12 }}>
        {/* Mode toggle (leftmost — most fundamental nav) */}
        <PillToggleV1
          options={[{ value: 'grid', label: 'Cards' }, { value: 'rows', label: 'Rows' }, { value: 'network', label: 'Network' }]}
          value={viewMode}
          onChange={(v) => setViewModePersistent(v as 'grid' | 'rows' | 'network')}
        />

        <button
          onClick={() => setShowAssistant((v) => !v)}
          style={showAssistant ? {
            ...ghostButton,
            background: 'color-mix(in srgb, var(--indigo) 16%, transparent)',
            color: 'var(--indigo)',
            border: '1px solid color-mix(in srgb, var(--indigo) 40%, transparent)',
          } : ghostButton}
          title="Speak or type roster/assignment commands · undoable"
        >Assistant ✨</button>

        <BarDivider />

        {/* Date nav */}
        <button onClick={() => { const p = addDays(viewDate, -1); setViewDate(p < today ? today : p); }} style={chevButton} title="Previous day">‹</button>
        <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', fontSize: 11, color: 'var(--text)', minWidth: 110, textAlign: 'center' }}>
          {dateLabel.replace(/,.*/, '')}
        </span>
        <button onClick={() => setViewDate(addDays(viewDate, 1))} style={chevButton} title="Next day">›</button>
        {!isToday && (
          <button onClick={() => setViewDate(today)} style={ghostButton} title="Back to today">Today</button>
        )}
        {isToday && <LiveClock />}

        <BarDivider />

        {/* Live / Planning toggle */}
        <PillToggleV1
          options={[{ value: 'live', label: 'Live' }, { value: 'plan', label: 'Planning' }]}
          value={isPlanMode ? 'plan' : 'live'}
          onChange={(v) => { if (v === 'live' && !isToday) setViewDate(today); }}
        />

        <BarDivider />

        {/* Slim stats — MD/CRNA staffed-vs-total + room count, folded into the
            header line (was: standalone StatsBar box above the board) */}
        <StatsInline staff={activeStaff} assignedStaffIds={assignedStaffIds} sites={sites} />

        <BarDivider />

        {/* Facility pills */}
        <div style={{ display: 'flex', gap: 3 }}>
          <FacilityPillV1 label="All" active={!hospital} onClick={() => { setHospital(''); try { localStorage.setItem('hospital', ''); } catch {} }} />
          {HOSPITALS.map((h) => (
            <FacilityPillV1
              key={h}
              label={facilityAbbrev(h)}
              active={hospital === h}
              onClick={() => {
                const next = hospital === h ? '' : h;
                setHospital(next);
                try { localStorage.setItem('hospital', next); } catch {}
              }}
            />
          ))}
        </div>

        {hospital && HOSPITAL_BASELINES[hospital] && (
          <button onClick={resetBoard} style={{ ...ghostButton, color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)' }} title="Reset board to baseline">↺ Reset</button>
        )}

        {/* Right cluster */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {saving && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>saving…</span>}
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
            {realAssignedIds.size}/{activeStaff.filter((p) => activeStaffIds.has(p.id)).length} working · {filteredSites.filter((s) => !s.is_float).reduce((n, s) => n + s.rooms.length, 0)} rooms
          </span>
          {isToday && <Pill label="LIVE" color="var(--ok)" pulse />}
          <BarDivider />
          <button onClick={() => setShowPrint(true)} style={ghostButton} title="Print sheet">🖨 Print</button>
        </div>
      </header>

      {/* Supervision alert — full-width, directly under the header row.
          Self-contained: renders nothing when nobody is at/over limit. */}
      <SupervisionBanner supervisionLoads={supervisionLoads} />

      {/* Inline planning banner */}
      {isPlanMode && (
        <div style={{ background: 'color-mix(in srgb, var(--warn) 8%, transparent)', borderBottom: '0.5px solid color-mix(in srgb, var(--warn) 25%, transparent)', padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--warn)', fontWeight: 600 }}>
          <span>📅 Planning — editing <strong style={{ color: 'color-mix(in srgb, var(--warn) 60%, var(--text-strong))' }}>{dateLabel}</strong>. Won't affect today's live board.</span>
        </div>
      )}

      {/* BODY — flex:1 fills whatever vertical space the header + optional
          supervision/planning banners above it leave; no hardcoded height
          subtraction, so the now variable-height SupervisionBanner can't
          push content off-screen (previously a fixed calc(100vh - Npx)
          assumed only the header/planning-banner heights). */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

        {/* Sidebar — resizable, or a collapsed 44px icon rail */}
        <div style={{ width: sidebarCollapsed ? BT.railWidth : sidebarWidth, minWidth: sidebarCollapsed ? BT.railWidth : sidebarWidth, flexShrink: 0, display: 'flex', overflow: 'hidden' }}>
          <Sidebar
            staff={activeStaff}
            allStaff={staff}
            currentHospital={hospital}
            assignedStaffIds={realAssignedIds}
            supervisionLoads={supervisionLoads}
            designations={designations}
            dailyShifts={dailyShifts}
            breaksMap={breaksMap}
            alertLevels={alertLevels}
            activeStaffIds={activeStaffIds}
            dragging={dragging}
            today={viewDate}
            onDragStart={handleDragStart}
            onDropSidebar={handleDropSidebar}
            onAddStaff={() => setShowAddStaff(true)}
            onDeleteStaff={deleteStaff}
            onUpdateHours={updateStaffHours}
            onSetDesignation={setDesignation}
            onSetDailyShift={setDailyShift}
            onToggleBreak={toggleBreak}
            onToggleActive={toggleActive}
            collapsed={sidebarCollapsed}
            onToggleCollapse={toggleSidebarCollapsed}
          />
        </div>

        {/* Sidebar resize handle — hidden while collapsed (rail has no drag-resize) */}
        {!sidebarCollapsed && (
          <div
            onMouseDown={onSidebarResizeMouseDown}
            style={{ width: 5, cursor: 'col-resize', background: 'transparent', flexShrink: 0, transition: 'background 0.15s', zIndex: 10 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in srgb, var(--blue) 35%, transparent)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          />
        )}

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <main style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
            {/* CONTINGENCY ROW — sits directly above the Available bar (stub, wired in Phase 2) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', marginBottom: 8, borderRadius: 6, border: '0.5px solid var(--border)', background: 'var(--bg-surface)' }}>
              <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase', marginRight: 4 }}>Contingencies</span>
              <ContingencyPill label="Trauma alert" severity="high" />
              <ContingencyPill label="Add-on case"  severity="medium" />
              <ContingencyPill label="Late-out"     severity="medium" />
              <button style={{ padding: '1px 8px', borderRadius: 999, fontSize: 9, fontWeight: 700, background: 'transparent', color: 'var(--text-muted)', border: '0.5px dashed var(--border)', cursor: 'pointer' }}>
                + add
              </button>
              <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono), ui-monospace, monospace', fontStyle: 'italic' }}>coming soon</span>
            </div>

            <FloatBar
              staff={activeStaff}
              floatIds={floatStaffIds}
              assignedIds={realAssignedIds}
              activeStaffIds={activeStaffIds}
              dailyShifts={dailyShifts}
              designations={designations}
              onDragStart={handleDragStart}
            />

            {viewMode === 'grid' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
                {[
                  ...filteredSites.filter((s) => !s.is_float && !isSmallSite(s.name)),
                  ...filteredSites.filter((s) => !s.is_float && isSmallSite(s.name)),
                  ...filteredSites.filter((s) => s.is_float),
                ].map((site, i) => (
                  <div key={site.id}
                    style={{ gridColumn: site.is_float ? '1 / -1' : isSmallSite(site.name) ? 'span 2' : '1 / -1' }}
                    draggable={!site.is_float}
                    onDragStart={(e) => {
                      if ((e.target as HTMLElement).closest('button,input,select,textarea')) { e.preventDefault(); return; }
                      if (!site.is_float) { draggingSiteId.current = site.id; e.dataTransfer.effectAllowed = 'move'; }
                    }}
                    onDragEnd={() => { draggingSiteId.current = null; }}
                    onDragOver={(e) => {
                      const siteId = draggingSiteId.current;
                      if (siteId && siteId !== site.id && !site.is_float) { e.preventDefault(); handleReorderSite(siteId, site.id); }
                    }}
                  >
                    <SiteCard
                      site={site} index={i}
                      roomAssignments={roomAssignments}
                      floatAssignments={site.is_float ? floatAssignments : []}
                      dragOver={dragOver} dragging={dragging}
                      alertLevels={alertLevels} dailyShifts={dailyShifts}
                      roomsHeight={siteHeights[site.id]}
                      onDrop={handleDrop}
                      onDropFloat={handleDropFloat}
                      onDragOver={setDragOver}
                      onDragLeave={() => setDragOver(null)}
                      onRemoveAssignment={removeAssignment}
                      onAddRoom={() => setShowAddRoom(site.id)}
                      onDeleteRoom={(roomId) => deleteRoom(site.id, roomId)}
                      onDeleteSite={() => deleteSite(site.id)}
                      onReorderRoom={handleReorderRoom}
                      onResizeHeight={(h) => setSiteHeight(site.id, h)}
                    />
                  </div>
                ))}
                <div style={{ gridColumn: '1 / -1' }}>
                  <AddSiteTile onClick={() => setShowAddSite(true)} />
                </div>
              </div>
            ) : viewMode === 'rows' ? (
              <RowsView
                filteredSites={filteredSites}
                floatAssignments={floatAssignments}
                roomAssignments={roomAssignments}
                dragOver={dragOver} dragging={dragging}
                alertLevels={alertLevels} dailyShifts={dailyShifts}
                siteHeights={siteHeights}
                onDrop={handleDrop}
                onDropFloat={handleDropFloat}
                onDragOver={setDragOver}
                onDragLeave={() => setDragOver(null)}
                onRemoveAssignment={removeAssignment}
                onAddRoom={(siteId) => setShowAddRoom(siteId)}
                onDeleteRoom={(siteId, roomId) => deleteRoom(siteId, roomId)}
                onDeleteSite={(siteId) => deleteSite(siteId)}
                onAddSite={() => setShowAddSite(true)}
              />
            ) : (
              <NetworkView
                sites={sites}
                filteredSites={filteredSites}
                assignments={assignments}
                roomAssignments={roomAssignments}
                hospital={hospital}
                hospitalStaff={hospitalStaff}
                designations={designations}
                dailyShifts={dailyShifts}
                dragging={dragging}
                dragOver={dragOver}
                onDragOver={setDragOver}
                onDragLeave={() => setDragOver(null)}
                onDrop={handleDrop}
                onRemoveAssignment={removeAssignment}
              />
            )}
          </main>

          <div style={{ display: 'flex', gap: 10, padding: '0 22px 18px', flexShrink: 0, alignItems: 'flex-end' }}>
            <OutListPanel staff={activeStaff} designations={designations} />
            <RelievedBox
              reliefLog={reliefLog} today={viewDate} dragging={dragging}
              onDropRelieved={handleDropRelieved}
              onUndoRelief={async (id) => {
                setReliefLog((prev) => prev.filter((r) => r.id !== id));
                await fetch('/api/relief?id=' + id, { method: 'DELETE' });
              }}
            />
          </div>
        </div>
      </div>

      {showPrint && <PrintView date={viewDate} sites={sites} staff={activeStaff} assignments={assignments} designations={designations} dailyShifts={dailyShifts} onClose={() => setShowPrint(false)} />}
      {showAssistant && (
        <BoardAssistantPanel
          boardDate={viewDate}
          hospital={hospital}
          today={today}
          onMutated={() => { if (!isToday) loadDailyData(viewDate); }}
          onClose={() => setShowAssistant(false)}
        />
      )}
      {showAddSite  && <AddSiteModal  onClose={() => setShowAddSite(false)}  onConfirm={addSite} />}
      {showAddStaff && <AddStaffModal onClose={() => setShowAddStaff(false)} onConfirm={addStaff} />}
      {showAddRoom  && <AddRoomModal  onClose={() => setShowAddRoom(null)}   onConfirm={(n) => addRoom(showAddRoom, n)} />}
    </div>
  );
}

// ── Top-bar helpers (V2-style) ───────────────────────────────────────────────
const chevButton: React.CSSProperties = {
  width: 22, height: 22, borderRadius: 4, border: '0.5px solid var(--border)',
  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
  fontSize: 13, lineHeight: 1, padding: 0,
};

const ghostButton: React.CSSProperties = {
  padding: '2px 8px', borderRadius: 4, border: '0.5px solid var(--border)',
  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer',
  fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
};

function BarDivider() {
  return <span style={{ width: 1, height: 18, background: 'var(--border)', display: 'inline-block', flexShrink: 0 }} />;
}

function PillToggleV1({ options, value, onChange }: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'inline-flex', borderRadius: 999, border: '0.5px solid var(--border)', overflow: 'hidden', background: 'var(--bg-deep)' }}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              padding: '2px 12px', fontSize: 10, fontWeight: 600,
              background: active ? 'var(--text)' : 'transparent',
              color: active ? 'var(--bg-base)' : 'var(--text-muted)',
              border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

function FacilityPillV1({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '2px 8px', borderRadius: 999, fontSize: 9, fontWeight: 700,
      fontFamily: 'var(--font-mono), ui-monospace, monospace',
      background: active ? '#E1F5EE' : 'transparent',
      color: active ? '#085041' : 'var(--text-muted)',
      border: '0.5px solid ' + (active ? '#A8DBC9' : 'var(--border)'),
      cursor: 'pointer', transition: 'all 0.12s',
    }}>{label}</button>
  );
}

function ContingencyPill({ label, severity }: { label: string; severity: 'high' | 'medium' }) {
  const dot = severity === 'high' ? 'var(--danger)' : 'var(--warn)';
  return (
    <button style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '1px 8px', borderRadius: 999, fontSize: 9, fontWeight: 700,
      background: 'var(--bg-deep)', color: 'var(--text)',
      border: '0.5px solid var(--border)', cursor: 'pointer',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: dot, display: 'inline-block' }} />
      {label}
    </button>
  );
}

function facilityAbbrev(h: Hospital): string {
  if (h === 'Paoli Hospital') return 'Paoli';
  if (h === 'Bryn Mawr Hospital') return 'BMH';
  if (h === 'Lankenau Hospital') return 'Lank';
  if (h === 'Riddle Hospital') return 'Rid';
  return h as string;
}

function NavArrow({ dir, onClick }: { dir: 'left' | 'right'; onClick: () => void }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ width: 30, height: 30, borderRadius: 8, background: hov ? 'color-mix(in srgb, var(--blue) 15%, transparent)' : 'transparent', border: '1px solid ' + (hov ? 'color-mix(in srgb, var(--blue) 40%, transparent)' : 'var(--border)'), color: hov ? 'var(--blue)' : 'var(--text-muted)', cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' }}>
      {dir === 'left' ? '‹' : '›'}
    </button>
  );
}

function LiveClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const fmt = () => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    setTime(fmt());
    const t = setInterval(() => setTime(fmt()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', fontFamily: 'var(--font-mono), ui-monospace, monospace', letterSpacing: 0.5 }}>{time}</span>;
}

function Pill({ label, color, pulse }: { label: string; color: string; pulse?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 9px', borderRadius: 999, background: 'color-mix(in srgb, ' + color + ' 12%, transparent)', border: '1px solid color-mix(in srgb, ' + color + ' 30%, transparent)', fontSize: 10, fontWeight: 700, color, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
      {pulse && <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', animation: 'relief-flash 1.5s ease-in-out infinite' }} />}
      {label}
    </div>
  );
}

export function AddSiteTile({ onClick }: { onClick: () => void }) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ borderRadius: 14, border: '1px dashed ' + (hov ? 'var(--blue)' : 'var(--border)'), minHeight: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.2s', marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: hov ? 'var(--blue)' : 'var(--text-dim)', transition: 'color 0.2s' }}>
        <span style={{ fontSize: 22 }}>＋</span>
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>Add Site</span>
      </div>
    </div>
  );
}

export function hexToRgb(hex = '#0ea5e9') {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? parseInt(r[1], 16) + ',' + parseInt(r[2], 16) + ',' + parseInt(r[3], 16) : '14,165,233';
}

