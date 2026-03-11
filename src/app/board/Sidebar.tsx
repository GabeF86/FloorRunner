'use client';

import { useState, useRef } from 'react';
import {
  StaffMember, Role, ROLE_META, ShiftHours, HOUR_OPTIONS, DraggedPerson,
  SupervisionLoad, SUPERVISION_LIMITS, MDDesignation, MD_DESIGNATIONS,
  Break, BreakType, getBreaksForShift,
} from '@/types';
import { hexToRgb } from './BoardClient';

interface Props {
  staff:            StaffMember[];
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
}

export default function Sidebar(props: Props) {
  const { staff, assignedStaffIds, activeStaffIds, dragging, onDropSidebar, onAddStaff } = props;
  const isDragTarget = !!dragging && assignedStaffIds.has(dragging.id);

  const byRole = (role: Role) => staff.filter((p) => p.role === role);

  const [search, setSearch] = useState('');
  const [mdPct, setMdPct] = useState<number>(() => {
    try { return parseFloat(localStorage.getItem('sidebarMdPct') || '45'); } catch { return 45; }
  });
  const bodyRef = useRef<HTMLDivElement>(null);
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

  const searchTerm = search.toLowerCase().trim();
  const searchResults = searchTerm ? staff.filter((p) => p.name.toLowerCase().includes(searchTerm)) : null;

  const renderRoleGroup = (role: Role) => {
    const meta = ROLE_META[role];
    const members = byRole(role);
    const activeCount = members.filter((p) => activeStaffIds.has(p.id)).length;
    if (!members.length) return null;
    return (
      <div key={role} style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 3px', borderBottom: '1px solid rgba(' + hexToRgb(meta.color) + ',0.2)', marginBottom: 7 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: meta.color, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.2, textTransform: 'uppercase', color: meta.color }}>{meta.label}</span>
          {role === 'physician' && (
            <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
              (max {SUPERVISION_LIMITS.crna} CRNA · {SUPERVISION_LIMITS.resident} Res)
            </span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)', fontWeight: 700 }}>
            {activeCount}/{members.length} on
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
      style={{ flex: 1, minWidth: 0, height: '100%', background: '#0a1628', display: 'flex', flexDirection: 'column', overflow: 'hidden', transition: 'box-shadow 0.2s', boxShadow: isDragTarget ? 'inset -3px 0 12px rgba(14,165,233,0.1)' : 'none' }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropSidebar}
    >
      {/* Header */}
      <div style={{ padding: '14px 16px 11px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: 1.5, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Staff Roster</span>
        <button onClick={onAddStaff} style={{ background: 'rgba(14,165,233,0.12)', border: '1px solid rgba(14,165,233,0.3)', color: '#0ea5e9', borderRadius: 7, padding: '4px 13px', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>+ Add</button>
      </div>

      {/* Search bar */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <input
          type="text"
          placeholder="🔍  Search staff..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, padding: '6px 10px', fontSize: 12, color: 'var(--text)', outline: 'none' }}
        />
      </div>

      {isDragTarget && (
        <div style={{ margin: '8px 10px 0', padding: '8px 10px', borderRadius: 8, border: '1px dashed rgba(14,165,233,0.4)', background: 'rgba(14,165,233,0.06)', fontSize: 12, color: '#0ea5e9', textAlign: 'center', fontWeight: 600, flexShrink: 0 }}>
          ↩ Drop here to unassign
        </div>
      )}

      {searchResults ? (
        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 10px 20px' }}>
          {searchResults.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 12, fontStyle: 'italic', padding: '12px 4px' }}>No staff found</div>
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
            style={{ flexShrink: 0, height: 8, cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(14,165,233,0.07)', borderTop: '1px solid rgba(14,165,233,0.25)', borderBottom: '1px solid rgba(14,165,233,0.25)', transition: 'background 0.15s' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(14,165,233,0.2)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(14,165,233,0.07)')}
          >
            <div style={{ width: 28, height: 3, borderRadius: 2, background: 'rgba(14,165,233,0.5)' }} />
          </div>

          {/* CRNAs + others pane */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '8px 10px 20px' }}>
            {(['crna', 'srna', 'resident', 'surgeon'] as Role[]).map((role) => renderRoleGroup(role))}
          </div>
        </div>
      )}
    </aside>
  );
}

// ── Staff Card ────────────────────────────────────────────────────────────────
function StaffCard({ person, role, assignedStaffIds, supervisionLoads, designations, dailyShifts, breaksMap, alertLevels, isActive, onDragStart, onDeleteStaff, onSetDesignation, onSetDailyShift, onToggleBreak, onToggleActive }: Props & { person: StaffMember; role: Role; isActive: boolean }) {
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
    !isActive            ? 'rgba(255,255,255,0.05)' :
    alert === 'critical' ? 'rgba(239,68,68,0.7)' :
    alert === 'warning'  ? 'rgba(251,191,36,0.6)' :
    isOver               ? 'rgba(248,113,113,0.5)' :
    isAtLimit            ? 'rgba(251,191,36,0.4)' :
    hov || assigned      ? meta.border : 'transparent';

  const bgColor =
    !isActive            ? 'transparent' :
    alert === 'critical' ? 'rgba(239,68,68,0.1)' :
    alert === 'warning'  ? 'rgba(251,191,36,0.07)' :
    isOver               ? 'rgba(248,113,113,0.08)' :
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
      style={{ borderRadius: 10, marginBottom: 5, border: '1px solid ' + borderColor, background: bgColor, opacity: isActive ? 1 : 0.72, transition: 'all 0.14s', position: 'relative', userSelect: 'none', cursor: canDrag ? 'grab' : 'default' }}
    >
      {/* Alert flash */}
      {isActive && alert === 'critical' && <div style={{ position: 'absolute', inset: 0, borderRadius: 10, border: '2px solid rgba(239,68,68,0.6)', animation: 'relief-flash 1s ease-in-out infinite', pointerEvents: 'none' }} />}
      {isActive && alert === 'warning'  && <div style={{ position: 'absolute', inset: 0, borderRadius: 10, border: '2px solid rgba(251,191,36,0.5)', animation: 'relief-flash 2s ease-in-out infinite', pointerEvents: 'none' }} />}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 10px' }}>
        {/* Working today checkbox */}
        <div style={{ paddingTop: 2, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => onToggleActive(person.id, e.target.checked)}
            title={isActive ? 'Working today — uncheck to mark off' : 'Not working — check to activate'}
            style={{ width: 15, height: 15, accentColor: meta.color, cursor: 'pointer' }}
          />
        </div>

        {/* Avatar */}
        <div style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0, background: isActive ? meta.bg : 'rgba(255,255,255,0.05)', color: isActive ? meta.color : '#475569', border: '1px solid ' + (isActive ? meta.border : 'rgba(255,255,255,0.08)'), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800 }}>
          {person.initials}
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: isActive ? 'var(--text)' : '#8899aa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {person.name}
          </div>

          {/* Physician badges */}
          {isPhys && isActive && (
            <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
              {desg ? <DesignationBadge designation={desg} /> : <span style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>no designation</span>}
              {load && <SupervisionBadge load={load} />}
            </div>
          )}

          {/* CRNA/SRNA/Resident shift */}
          {!isPhys && !isSurgeon && isActive && shiftHours && (
            <div style={{ marginTop: 3 }}>
              <ShiftBadge hours={shiftHours} role={role} />
            </div>
          )}

          {/* Breaks */}
          {showBreaks && breaksForShift.length > 0 && (
            <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
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
                style={{ fontSize: 11, padding: '3px 8px', fontWeight: 800, cursor: 'pointer', color: meta.color, background: meta.bg, border: '1px solid ' + meta.border, borderRadius: 6, lineHeight: 1.6 }}>
                {isPhys ? (desg || '—') : (shiftHours || person.hours)}
              </button>
            )}

            {/* Picker dropdown — fixed to viewport so it's never clipped */}
            {showPicker && (
              <div style={{ position: 'fixed', zIndex: 9999, background: '#0d1b30', border: '1px solid #334155', borderRadius: 12, padding: 10, boxShadow: '0 16px 48px rgba(0,0,0,0.8)', minWidth: 200 }}
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
                          style={{ padding: '5px 10px', borderRadius: 7, cursor: 'pointer', fontWeight: 800, fontSize: 12, border: '1px solid ' + (desg === d ? meta.color : '#334155'), background: desg === d ? meta.bg : 'transparent', color: desg === d ? meta.color : '#94a3b8', transition: 'all 0.1s' }}>
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
                          style={{ padding: '5px 10px', borderRadius: 7, cursor: 'pointer', fontWeight: 800, fontSize: 12, border: '1px solid ' + (shiftHours === h ? meta.color : '#334155'), background: shiftHours === h ? meta.bg : 'transparent', color: shiftHours === h ? meta.color : '#94a3b8', transition: 'all 0.1s' }}>
                          {h}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            <button onClick={() => onDeleteStaff(person.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#475569', fontSize: 18, lineHeight: 1, padding: '2px 4px', borderRadius: 4 }}>×</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function DesignationBadge({ designation }: { designation: MDDesignation }) {
  const isCall    = designation === 'C1';
  const isLastOut = designation === 'C2';
  const isPerDiem = designation === '8hr' || designation === '10hr';
  const color = isCall ? '#a78bfa' : isLastOut ? '#fb7185' : isPerDiem ? '#94a3b8' : '#f59e0b';
  return (
    <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 7px', borderRadius: 5, background: 'rgba(' + hexToRgb(color) + ',0.15)', color, border: '1px solid rgba(' + hexToRgb(color) + ',0.35)' }}>
      {isCall ? '☾ ' + designation : designation}
    </span>
  );
}

function SupervisionBadge({ load }: { load: SupervisionLoad }) {
  const cc = load.overCrna ? '#f87171' : load.atCrna ? '#fbbf24' : '#34d399';
  const rc = load.overResident ? '#f87171' : load.atResident ? '#fbbf24' : '#34d399';
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      <span style={{ fontSize: 10, fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: 'rgba(' + hexToRgb(cc) + ',0.15)', color: cc, border: '1px solid rgba(' + hexToRgb(cc) + ',0.3)' }}>
        {load.crnaCount}/{SUPERVISION_LIMITS.crna} CRNA
      </span>
      <span style={{ fontSize: 10, fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: 'rgba(' + hexToRgb(rc) + ',0.15)', color: rc, border: '1px solid rgba(' + hexToRgb(rc) + ',0.3)' }}>
        {load.residentCount}/{SUPERVISION_LIMITS.resident} Res
      </span>
    </div>
  );
}

function BreakCheckbox({ type, done, onChange }: { type: BreakType; done: boolean; onChange: (v: boolean) => void }) {
  const labels: Record<BreakType, string> = { morning: 'AM Brk', lunch: 'Lunch', afternoon: 'PM Brk' };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }} onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={done} onChange={(e) => onChange(e.target.checked)} style={{ width: 13, height: 13, accentColor: '#10b981', cursor: 'pointer' }} />
      <span style={{ fontSize: 10, color: done ? '#10b981' : 'var(--text-dim)', fontWeight: 700, textDecoration: done ? 'line-through' : 'none' }}>
        {labels[type]}
      </span>
    </label>
  );
}

const LATE_SHIFT_COLORS: Record<string, string> = {
  '10hr': '#f59e0b',  // amber
  '12hr': '#f97316',  // orange
  '16hr': '#ef4444',  // red-orange
  '24hr': '#f87171',  // bright red
};

export function ShiftBadge({ hours, role }: { hours: string; role: Role }) {
  const lateColor = LATE_SHIFT_COLORS[hours];
  const roleColor = ROLE_META[role]?.color || '#94a3b8';
  const color     = lateColor ?? roleColor;
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
      background: `rgba(${hexToRgb(color)},${lateColor ? 0.18 : 0.12})`,
      color,
      border: `1px solid rgba(${hexToRgb(color)},${lateColor ? 0.45 : 0.28})`,
      letterSpacing: lateColor ? 0.3 : 0,
    }}>
      {hours}
    </span>
  );
}
