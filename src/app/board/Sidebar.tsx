'use client';

import { useState, useRef } from 'react';
import {
  StaffMember, Role, ROLE_META, ShiftHours, HOUR_OPTIONS, DraggedPerson,
  SupervisionLoad, SUPERVISION_LIMITS, MDDesignation, MD_DESIGNATIONS,
  Break, BreakType, getBreaksForShift,
} from '@/types';
import { hexToRgb } from './BoardClient';
import { ShiftBadge } from './ShiftBadge';
import { BT } from './boardTheme';

interface Props {
  staff:            StaffMember[];
  allStaff:         StaffMember[];
  currentHospital:  string;
  assignedStaffIds: Set<string>;
  supervisionLoads: Record<string, SupervisionLoad>;
  designations:     Record<string, MDDesignation>;
  dailyShifts:      Record<string, ShiftHours>;
  breaksMap:        Record<string, Break[]>;
  alertLevels:      Record<string, 'none' | 'warning' | 'critical'>;
  activeStaffIds:   Set<string>;   // working today
  dragging:         DraggedPerson | null;
  today:            string;
  onDragStart:      (p: DraggedPerson) => void;
  onDropSidebar:    () => void;
  onAddStaff:       () => void;
  onDeleteStaff:    (id: string) => void;
  onUpdateHours:    (id: string, h: ShiftHours) => void;
  onSetDesignation: (id: string, d: MDDesignation | null) => void;
  onSetDailyShift:  (id: string, h: ShiftHours) => void;
  onToggleBreak:    (id: string, t: BreakType, taken: boolean) => void;
  onToggleActive:   (id: string, active: boolean) => void;
  collapsed:        boolean;
  onToggleCollapse: () => void;
}

// Rail role groups — icon + live "working today" count badge per group.
// Counts reuse the exact sidebar data (staff = activeStaff upstream,
// already hospital-filtered; activeStaffIds = daily_active for today).
const RAIL_GROUPS: Array<{ icon: string; label: string; roles: Role[] }> = [
  { icon: '🩺', label: 'Physicians', roles: ['physician'] },
  { icon: '💉', label: 'CRNAs / SRNAs / Residents / Fellows', roles: ['crna', 'srna', 'resident', 'fellow'] },
  { icon: '🔪', label: 'Surgeons', roles: ['surgeon'] },
];

export default function Sidebar(props: Props) {
  const { staff, currentHospital, assignedStaffIds, activeStaffIds, dragging, onDropSidebar, onAddStaff, collapsed, onToggleCollapse } = props;
  const isDragTarget = !!dragging && assignedStaffIds.has(dragging.id);

  // Collapsed → 44px icon rail instead of the full panes. The rail stays a
  // drop target (same onDragOver/onDrop as the expanded <aside>) so dragging
  // a person onto the collapsed sidebar still unassigns them.
  if (collapsed) {
    return (
      <div
        style={{ width: BT.railWidth, minWidth: BT.railWidth, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '10px 0', borderRight: '1px solid var(--border)', background: 'var(--bg-sidebar)', boxShadow: isDragTarget ? 'inset -3px 0 12px color-mix(in srgb, var(--blue) 10%, transparent)' : 'none' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDropSidebar}
      >
        <button onClick={onToggleCollapse} title="Expand sidebar (⌘B)" style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg-deep)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13 }}>≡</button>
        {RAIL_GROUPS.map((g) => {
          const working = staff.filter((p) => g.roles.includes(p.role) && activeStaffIds.has(p.id)).length;
          return (
            <button key={g.label} onClick={onToggleCollapse} title={`${g.label}: ${working} working today — click to expand`} style={{ position: 'relative', width: 28, height: 28, borderRadius: 7, background: 'var(--bg-deep)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 12 }}>
              {g.icon}
              {working > 0 && <span style={{ position: 'absolute', top: -5, right: -5, background: '#1e3a8a', color: '#fff', fontSize: 8, fontWeight: 800, borderRadius: 6, padding: '0 3px', minWidth: 12 }}>{working}</span>}
            </button>
          );
        })}
      </div>
    );
  }

  // Sidebar auto-populates with home staff for the currently selected facility.
  // (`staff` here is `activeStaff` upstream, which is already hospital-filtered.)
  // Each row's "working today" checkbox still controls assignability/break tracking.
  // Full roster (incl. visiting staff from other facilities) is reachable via search.
  const byRole = (role: Role) => staff.filter((p) => p.role === role);
  const onCount = staff.filter((p) => activeStaffIds.has(p.id)).length;

  const [search, setSearch] = useState('');
  const [mdPct, setMdPct] = useState<number>(() => {
    try { return parseFloat(localStorage.getItem('sidebarMdPct') || '45'); } catch { return 45; }
  });
  const [srnaSurgeonPct, setSrnaSurgeonPct] = useState<number>(() => {
    try { return parseFloat(localStorage.getItem('sidebarSrnaSurgeonPct') || '60'); } catch { return 60; }
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const divStartY = useRef(0);
  const divStartPct = useRef(0);

  function onDividerMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    divStartY.current = e.clientY;
    divStartPct.current = mdPct;
    function onMove(ev: MouseEvent) {
      const el = bodyRef.current;
      if (!el) return;
      const totalH = el.getBoundingClientRect().height;
      if (!totalH) return;
      const deltaPct = ((ev.clientY - divStartY.current) / totalH) * 100;
      const next = Math.max(15, Math.min(80, divStartPct.current + deltaPct));
      setMdPct(next);
      try { localStorage.setItem('sidebarMdPct', String(next)); } catch {}
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onBottomDividerMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    divStartY.current = e.clientY;
    divStartPct.current = srnaSurgeonPct;
    function onMove(ev: MouseEvent) {
      const el = bottomRef.current;
      if (!el) return;
      const totalH = el.getBoundingClientRect().height;
      if (!totalH) return;
      const deltaPct = ((ev.clientY - divStartY.current) / totalH) * 100;
      const next = Math.max(15, Math.min(85, divStartPct.current + deltaPct));
      setSrnaSurgeonPct(next);
      try { localStorage.setItem('sidebarSrnaSurgeonPct', String(next)); } catch {}
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const searchTerm = search.toLowerCase().trim();
  const searchResults = searchTerm ? props.allStaff.filter((p) => p.name.toLowerCase().includes(searchTerm)) : null;

  // Visible list — what bulk-actions operate on. When searching, that's the
  // search hits (so you can mass-activate a different facility's roster);
  // otherwise it's just the current facility's staff.
  const visibleStaff = searchResults ?? staff;
  const anyVisibleActive = visibleStaff.some((p) => activeStaffIds.has(p.id));
  const bulkToggle = () => {
    const next = !anyVisibleActive;
    // Skip no-op toggles so we don't slam the API for no reason.
    visibleStaff.forEach((p) => {
      const isActive = activeStaffIds.has(p.id);
      if (isActive !== next) props.onToggleActive(p.id, next);
    });
  };

  const renderRoleGroup = (role: Role) => {
    const meta = ROLE_META[role];
    const members = byRole(role);
    if (!members.length) return null;
    return (
      <div key={role} style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 3px', borderBottom: '1px solid rgba(' + hexToRgb(meta.color) + ',0.2)', marginBottom: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: meta.color, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: meta.color }}>{meta.label}</span>
          {role === 'physician' && (
            <span style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
              max {SUPERVISION_LIMITS.crna}c·{SUPERVISION_LIMITS.resident}r
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
            {members.length}
          </span>
        </div>
        {members.map((person) => (
          <StaffCard key={person.id} person={person} role={role}
            isActive={activeStaffIds.has(person.id)}
            {...props} />
        ))}
      </div>
    );
  };

  return (
    <aside
      style={{ flex: 1, minWidth: 0, height: '100%', background: 'var(--bg-sidebar)', display: 'flex', flexDirection: 'column', overflow: 'hidden', transition: 'box-shadow 0.2s', boxShadow: isDragTarget ? 'inset -3px 0 12px color-mix(in srgb, var(--blue) 10%, transparent)' : 'none' }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropSidebar}
    >
      {/* Header */}
      <div style={{ padding: 'var(--space-2) var(--space-3) var(--space-1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
          <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 800, letterSpacing: 1.2, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            {currentHospital ? facilityShort(currentHospital) + ' Staff' : 'Staff Roster'}
          </span>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', fontFamily: 'var(--font-mono), ui-monospace, monospace', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <span>{onCount}/{staff.length} on</span>
            <span>·</span>
            {visibleStaff.length > 0 && (
              <>
                <button
                  onClick={bulkToggle}
                  title={anyVisibleActive ? 'Deselect every visible staff member' : 'Mark every visible staff member as working today'}
                  style={{
                    background: 'transparent', border: 'none', padding: 0,
                    color: 'var(--blue)', fontSize: 'var(--fs-xs)', fontWeight: 700, cursor: 'pointer',
                    fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2,
                  }}
                >
                  {anyVisibleActive ? 'deselect all' : 'select all'}
                </button>
                <span>·</span>
              </>
            )}
            <span>search for full roster</span>
          </span>
        </div>
        <button onClick={onAddStaff} style={{ background: 'color-mix(in srgb, var(--blue) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--blue) 30%, transparent)', color: 'var(--blue)', borderRadius: 5, padding: '2px 9px', fontSize: 'var(--fs-xs)', fontWeight: 700, cursor: 'pointer' }}>+ Add</button>
      </div>

      {/* Search bar */}
      <div style={{ padding: 'var(--space-1) var(--space-2)', borderBottom: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="text"
          placeholder="Search full roster…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', background: 'var(--tint-surface)', border: '1px solid var(--border-input)', borderRadius: 5, padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--fs-xs)', color: 'var(--text)', outline: 'none' }}
        />
        <button
          onClick={onToggleCollapse}
          title="Collapse sidebar (⌘B)"
          style={{ flexShrink: 0, width: 24, height: 24, borderRadius: 5, background: 'var(--bg-deep)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}
        >≡</button>
      </div>

      {isDragTarget && (
        <div style={{ margin: 'var(--space-2) var(--space-3) 0', padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm)', border: '1px dashed color-mix(in srgb, var(--blue) 40%, transparent)', background: 'color-mix(in srgb, var(--blue) 6%, transparent)', fontSize: 'var(--fs-sm)', color: 'var(--blue)', textAlign: 'center', fontWeight: 600, flexShrink: 0 }}>
          ↩ Drop here to unassign
        </div>
      )}

      {searchResults ? (
        <div style={{ overflowY: 'auto', flex: 1, padding: 'var(--space-2) var(--space-3) var(--space-5)' }}>
          {searchResults.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-sm)', fontStyle: 'italic', padding: 'var(--space-3) var(--space-1)' }}>No staff found</div>
          )}
          {searchResults.map((person) => (
            <StaffCard key={person.id} person={person} role={person.role as Role}
              isActive={activeStaffIds.has(person.id)}
              {...props} />
          ))}
        </div>
      ) : (
        <div ref={bodyRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* MDs pane */}
          <div style={{ height: mdPct + '%', overflowY: 'auto', minHeight: 0, padding: '8px 10px' }}>
            {renderRoleGroup('physician')}
          </div>

          {/* Movable divider */}
          <div
            onMouseDown={onDividerMouseDown}
            style={{ flexShrink: 0, height: 8, cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--blue) 7%, transparent)', borderTop: '1px solid color-mix(in srgb, var(--blue) 25%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--blue) 25%, transparent)', transition: 'background 0.15s' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in srgb, var(--blue) 20%, transparent)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'color-mix(in srgb, var(--blue) 7%, transparent)')}
          >
            <div style={{ width: 28, height: 3, borderRadius: 2, background: 'color-mix(in srgb, var(--blue) 50%, transparent)' }} />
          </div>

          {/* CRNAs + SRNAs + Residents / Surgeons split pane */}
          <div ref={bottomRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
            <div style={{ height: srnaSurgeonPct + '%', overflowY: 'auto', minHeight: 0, padding: '8px 10px' }}>
              {/* 'fellow' included: fellows were previously reachable only via search (pre-existing gap fixed alongside the rail counts) */}
              {(['crna', 'srna', 'resident', 'fellow'] as Role[]).map((role) => renderRoleGroup(role))}
            </div>

            {/* Divider between SRNA/Resident and Surgeon */}
            <div
              onMouseDown={onBottomDividerMouseDown}
              style={{ flexShrink: 0, height: 8, cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--blue) 7%, transparent)', borderTop: '1px solid color-mix(in srgb, var(--blue) 25%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--blue) 25%, transparent)', transition: 'background 0.15s' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in srgb, var(--blue) 20%, transparent)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'color-mix(in srgb, var(--blue) 7%, transparent)')}
            >
              <div style={{ width: 28, height: 3, borderRadius: 2, background: 'color-mix(in srgb, var(--blue) 50%, transparent)' }} />
            </div>

            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '8px 10px 20px' }}>
              {renderRoleGroup('surgeon')}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

// ── Staff Card ────────────────────────────────────────────────────────────────
function StaffCard({ person, role, assignedStaffIds, currentHospital, supervisionLoads, designations, dailyShifts, breaksMap, alertLevels, isActive, onDragStart, onDeleteStaff, onSetDesignation, onSetDailyShift, onToggleBreak, onToggleActive }: Props & { person: StaffMember; role: Role; isActive: boolean }) {
  const isVisiting = currentHospital && person.hospital && person.hospital !== currentHospital;
  const [hov,        setHov]        = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const meta      = ROLE_META[role];
  const assigned  = assignedStaffIds.has(person.id);
  const alert     = alertLevels[person.id] || 'none';
  const isPhys    = role === 'physician';
  const isSurgeon = role === 'surgeon';
  const load      = isPhys ? supervisionLoads[person.id] : undefined;
  const desg      = isPhys ? designations[person.id] : undefined;
  const shiftHours = (!isPhys && !isSurgeon) ? (dailyShifts[person.id] || person.hours) : undefined;
  const myBreaks   = breaksMap[person.id] || [];
  const isOver     = load && (load.overCrna || load.overResident);
  const isAtLimit  = load && !isOver && (load.atCrna || load.atResident);
  const canDrag    = isActive;

  const borderColor =
    !isActive            ? 'var(--border-muted)' :
    alert === 'critical' ? 'color-mix(in srgb, var(--danger) 70%, transparent)' :
    alert === 'warning'  ? 'color-mix(in srgb, var(--warn) 60%, transparent)' :
    isOver               ? 'color-mix(in srgb, var(--danger) 50%, transparent)' :
    isAtLimit            ? 'color-mix(in srgb, var(--warn) 40%, transparent)' :
    hov || assigned      ? meta.border : 'transparent';

  const bgColor =
    !isActive            ? 'transparent' :
    alert === 'critical' ? 'color-mix(in srgb, var(--danger) 10%, transparent)' :
    alert === 'warning'  ? 'color-mix(in srgb, var(--warn) 7%, transparent)' :
    isOver               ? 'color-mix(in srgb, var(--danger) 8%, transparent)' :
    assigned             ? meta.bg :
    hov                  ? 'rgba(' + hexToRgb(meta.color) + ',0.06)' : 'transparent';

  const showBreaks     = isActive && !isPhys && !isSurgeon && shiftHours;
  const breaksForShift = showBreaks ? getBreaksForShift(shiftHours!) : [];

  return (
    <div
      draggable={canDrag}
      onDragStart={() => { if (canDrag) onDragStart({ ...person, role }); }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => { setHov(false); setShowPicker(false); }}
      style={{ borderRadius: 6, marginBottom: 3, border: '1px solid ' + borderColor, background: bgColor, opacity: isActive ? 1 : 0.72, transition: 'all 0.14s', position: 'relative', userSelect: 'none', cursor: canDrag ? 'grab' : 'default' }}
    >
      {/* Alert flash */}
      {isActive && alert === 'critical' && <div style={{ position: 'absolute', inset: 0, borderRadius: 6, border: '2px solid color-mix(in srgb, var(--danger) 60%, transparent)', animation: 'relief-flash 1s ease-in-out infinite', pointerEvents: 'none' }} />}
      {isActive && alert === 'warning'  && <div style={{ position: 'absolute', inset: 0, borderRadius: 6, border: '2px solid color-mix(in srgb, var(--warn) 50%, transparent)', animation: 'relief-flash 2s ease-in-out infinite', pointerEvents: 'none' }} />}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '5px 7px' }}>
        {/* Working today checkbox */}
        <div style={{ paddingTop: 1, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => onToggleActive(person.id, e.target.checked)}
            title={isActive ? 'Working today — uncheck to mark off' : 'Not working — check to activate'}
            style={{ width: 12, height: 12, accentColor: meta.color, cursor: 'pointer' }}
          />
        </div>

        {/* Avatar */}
        <div style={{ width: 24, height: 24, borderRadius: 5, flexShrink: 0, background: isActive ? meta.bg : 'var(--tint-surface)', color: isActive ? meta.color : 'var(--text-faint)', border: '1px solid ' + (isActive ? meta.border : 'var(--border-subtle)'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
          {person.initials}
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: isActive ? 'var(--text)' : 'var(--text-disabled)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {person.name}
          </div>
          {isVisiting && (
            <div style={{ fontSize: 8, color: 'var(--warn)', fontWeight: 700, marginTop: 0 }}>
              visiting from {person.hospital}
            </div>
          )}

          {/* Physician badges */}
          {isPhys && isActive && (
            <div style={{ marginTop: 2, display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
              {desg ? <DesignationBadge designation={desg} /> : <span style={{ fontSize: 9, color: 'var(--text-dim)', fontStyle: 'italic' }}>no designation</span>}
              {load && <SupervisionBadge load={load} />}
            </div>
          )}

          {/* CRNA/SRNA/Resident shift */}
          {!isPhys && !isSurgeon && isActive && shiftHours && (
            <div style={{ marginTop: 2 }}>
              <ShiftBadge hours={shiftHours} role={role} />
            </div>
          )}

          {/* Breaks */}
          {showBreaks && breaksForShift.length > 0 && (
            <div style={{ display: 'flex', gap: 3, marginTop: 3, flexWrap: 'wrap' }}>
              {breaksForShift.map((bt) => {
                const done = myBreaks.find((b) => b.break_type === bt)?.taken ?? false;
                return <BreakCheckbox key={bt} type={bt} done={done} onChange={(v) => onToggleBreak(person.id, bt, v)} />;
              })}
            </div>
          )}
        </div>

        {/* Hover controls — shift/designation picker + delete */}
        {hov && isActive && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0, position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            {/* Picker button */}
            {!isSurgeon && (
              <button onClick={() => setShowPicker((v) => !v)}
                style={{ fontSize: 9, padding: '2px 6px', fontWeight: 800, cursor: 'pointer', color: meta.color, background: meta.bg, border: '1px solid ' + meta.border, borderRadius: 4, lineHeight: 1.4, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
                {isPhys ? (desg || '—') : (shiftHours || person.hours)}
              </button>
            )}

            {/* Picker dropdown — fixed to viewport so it's never clipped */}
            {showPicker && (
              <div style={{ position: 'fixed', zIndex: 9999, background: 'var(--bg-popover)', border: '1px solid var(--border-strong)', borderRadius: 12, padding: 10, boxShadow: 'var(--shadow-popover)', minWidth: 200 }}
                ref={(el) => {
                  if (!el) return;
                  // Position below the button, flush right of sidebar
                  el.style.top  = Math.min(el.parentElement!.getBoundingClientRect().bottom + 6, window.innerHeight - el.offsetHeight - 10) + 'px';
                  el.style.left = '10px';
                  el.style.width = '268px';
                }}>
                {isPhys ? (
                  <>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, fontWeight: 700 }}>Daily Designation</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {MD_DESIGNATIONS.map((d) => (
                        <button key={d} onClick={() => { onSetDesignation(person.id, desg === d ? null : d); setShowPicker(false); }}
                          style={{ padding: '5px 10px', borderRadius: 7, cursor: 'pointer', fontWeight: 800, fontSize: 12, border: '1px solid ' + (desg === d ? meta.color : 'var(--border-strong)'), background: desg === d ? meta.bg : 'transparent', color: desg === d ? meta.color : 'var(--text-muted)', transition: 'all 0.1s' }}>
                          {d}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, fontWeight: 700 }}>Today's Shift</div>
                    <div style={{ display: 'flex', gap: 5 }}>
                      {HOUR_OPTIONS.map((h) => (
                        <button key={h} onClick={() => { onSetDailyShift(person.id, h as ShiftHours); setShowPicker(false); }}
                          style={{ padding: '5px 10px', borderRadius: 7, cursor: 'pointer', fontWeight: 800, fontSize: 12, border: '1px solid ' + (shiftHours === h ? meta.color : 'var(--border-strong)'), background: shiftHours === h ? meta.bg : 'transparent', color: shiftHours === h ? meta.color : 'var(--text-muted)', transition: 'all 0.1s' }}>
                          {h}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            <button onClick={() => onDeleteStaff(person.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', fontSize: 18, lineHeight: 1, padding: '2px 4px', borderRadius: 4 }}>×</button>
          </div>
        )}
      </div>
    </div>
  );
}

function facilityShort(h: string): string {
  if (h === 'Paoli Hospital') return 'Paoli';
  if (h === 'Bryn Mawr Hospital') return 'BMH';
  if (h === 'Lankenau Hospital') return 'Lank';
  if (h === 'Riddle Hospital') return 'Rid';
  return h;
}

// ── Sub-components ────────────────────────────────────────────────────────────
function DesignationBadge({ designation }: { designation: MDDesignation }) {
  const isCall    = designation === 'C1';
  const isLastOut = designation === 'C2';
  const isPerDiem = designation === '8hr' || designation === '10hr';
  const color = isCall ? '#a78bfa' : isLastOut ? '#fb7185' : isPerDiem ? '#94a3b8' : '#f59e0b';
  return (
    <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: 'rgba(' + hexToRgb(color) + ',0.15)', color, border: '1px solid rgba(' + hexToRgb(color) + ',0.35)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
      {isCall ? '☾' + designation : designation}
    </span>
  );
}

function SupervisionBadge({ load }: { load: SupervisionLoad }) {
  const cc = load.overCrna ? 'var(--danger)' : load.atCrna ? 'var(--warn)' : 'var(--ok)';
  const rc = load.overResident ? 'var(--danger)' : load.atResident ? 'var(--warn)' : 'var(--ok)';
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 4px', borderRadius: 3, background: 'color-mix(in srgb, ' + cc + ' 15%, transparent)', color: cc, border: '1px solid color-mix(in srgb, ' + cc + ' 30%, transparent)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
        {load.crnaCount}/{SUPERVISION_LIMITS.crna}c
      </span>
      <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 4px', borderRadius: 3, background: 'color-mix(in srgb, ' + rc + ' 15%, transparent)', color: rc, border: '1px solid color-mix(in srgb, ' + rc + ' 30%, transparent)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
        {load.residentCount}/{SUPERVISION_LIMITS.resident}r
      </span>
    </div>
  );
}

function BreakCheckbox({ type, done, onChange }: { type: BreakType; done: boolean; onChange: (v: boolean) => void }) {
  const labels: Record<BreakType, string> = { morning: 'AM', lunch: 'Lunch', afternoon: 'PM' };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', userSelect: 'none' }} onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={done} onChange={(e) => onChange(e.target.checked)} style={{ width: 11, height: 11, accentColor: 'var(--ok)', cursor: 'pointer' }} />
      <span style={{ fontSize: 9, color: done ? 'var(--ok)' : 'var(--text-dim)', fontWeight: 700, textDecoration: done ? 'line-through' : 'none' }}>
        {labels[type]}
      </span>
    </label>
  );
}
