'use client';

import { useState, useRef } from 'react';
import { Site, Room, Assignment, ROLE_META, DraggedPerson, SUPERVISED_ROLES, ShiftHours, StaffMember } from '@/types';
import { hexToRgb } from './BoardClient';
import { ShiftBadge } from './Sidebar';

interface Props {
  site:               Site;
  index:              number;
  roomAssignments:    Record<string, Assignment[]>;
  floatAssignments:   Assignment[];
  dragOver:           string | null;
  dragging:           DraggedPerson | null;
  alertLevels:        Record<string, 'none' | 'warning' | 'critical'>;
  dailyShifts:        Record<string, ShiftHours>;
  roomsHeight?:       number;
  onDrop:             (roomId: string) => void;
  onDropFloat:        (siteId: string) => void;
  onDragOver:         (id: string) => void;
  onDragLeave:        () => void;
  onRemoveAssignment: (id: string) => void;
  onAddRoom:          () => void;
  onDeleteRoom:       (roomId: string) => void;
  onDeleteSite:       () => void;
  onReorderRoom:      (siteId: string, roomId: string, targetRoomId: string) => void;
  onResizeHeight:     (h: number) => void;
}

export default function SiteCard(props: Props) {
  const { site, roomAssignments, floatAssignments, dragOver, dragging, alertLevels, dailyShifts, roomsHeight, onResizeHeight } = props;
  const [hov, setHov] = useState(false);
  const rgb    = hexToRgb(site.color);
  const isFloat = !!site.is_float;
  const resizeStartY = useRef<number | null>(null);
  const resizeStartH = useRef<number>(roomsHeight ?? 110);

  function onResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    resizeStartY.current = e.clientY;
    resizeStartH.current = roomsHeight ?? 110;
    function onMove(ev: MouseEvent) {
      if (resizeStartY.current === null) return;
      const delta = ev.clientY - resizeStartY.current;
      onResizeHeight(Math.max(110, resizeStartH.current + delta));
    }
    function onUp() {
      resizeStartY.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  if (isFloat) return (
    <FloatSiteCard
      site={site} floatAssignments={floatAssignments} dragging={dragging}
      isOver={dragOver === 'float-' + site.id} dailyShifts={dailyShifts} alertLevels={alertLevels}
      onDragOver={() => props.onDragOver('float-' + site.id)}
      onDragLeave={props.onDragLeave}
      onDropFloat={() => props.onDropFloat(site.id)}
      onRemoveAssignment={props.onRemoveAssignment}
    />
  );

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ background: 'var(--bg-surface)', borderRadius: 14, border: '1px solid var(--border)', overflow: 'visible', marginBottom: 14 }}
    >
      {/* Site header — full width */}
      <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'linear-gradient(135deg,rgba(' + rgb + ',0.28) 0%,rgba(' + rgb + ',0.14) 100%)', borderBottom: '1px solid rgba(' + rgb + ',0.32)', borderRadius: '14px 14px 0 0' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span style={{ fontSize: 15, fontWeight: 750, color: site.color, letterSpacing: -0.3 }}>{site.name}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>· {site.rooms.length} rooms</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button draggable={false} onClick={(e) => { e.stopPropagation(); props.onAddRoom(); }} style={{ background: 'rgba(' + rgb + ',0.12)', border: '1px solid rgba(' + rgb + ',0.3)', color: site.color, borderRadius: 5, padding: '2px 9px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>+ Room</button>
          {hov && <button draggable={false} onClick={(e) => { e.stopPropagation(); props.onDeleteSite(); }} style={{ background: 'color-mix(in srgb, var(--danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)', color: 'var(--danger)', borderRadius: 5, padding: '2px 9px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>Delete Site</button>}
        </div>
      </div>

      {/* Rooms — wrapping */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '12px 14px', overflowX: 'hidden', overflowY: 'auto', alignContent: 'flex-start', minHeight: 110, maxHeight: roomsHeight ?? undefined }}>
        {site.rooms.map((room) => (
          <RoomCell
            key={room.id}
            room={room} site={site}
            people={roomAssignments[room.id] || []}
            isOver={dragOver === room.id}
            dragging={dragging}
            alertLevels={alertLevels}
            dailyShifts={dailyShifts}
            onDrop={() => props.onDrop(room.id)}
            onDragOver={() => props.onDragOver(room.id)}
            onDragLeave={props.onDragLeave}
            onRemoveAssignment={props.onRemoveAssignment}
            onDeleteRoom={() => props.onDeleteRoom(room.id)}
            onReorderRoom={(targetId) => props.onReorderRoom(site.id, room.id, targetId)}
          />
        ))}
        {site.rooms.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 13, fontStyle: 'italic' }}>
            No rooms yet — click + Room to add one
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={onResizeMouseDown}
        style={{ height: 6, cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '0 0 14px 14px', background: hov ? `rgba(${rgb},0.08)` : 'transparent', transition: 'background 0.15s' }}
      >
        <div style={{ width: 32, height: 3, borderRadius: 2, background: hov ? `rgba(${rgb},0.4)` : 'var(--tint-surface-strong)', transition: 'background 0.15s' }} />
      </div>
    </div>
  );
}

// ── Room Cell ────────────────────────────────────────────────────────────────
function RoomCell({ room, site, people, isOver, dragging, alertLevels, dailyShifts, onDrop, onDragOver, onDragLeave, onRemoveAssignment, onDeleteRoom, onReorderRoom }: {
  room: Room; site: Site; people: Assignment[];
  isOver: boolean; dragging: DraggedPerson | null;
  alertLevels: Record<string, 'none' | 'warning' | 'critical'>;
  dailyShifts: Record<string, ShiftHours>;
  onDrop: () => void; onDragOver: () => void; onDragLeave: () => void;
  onRemoveAssignment: (id: string) => void; onDeleteRoom: () => void;
  onReorderRoom: (targetRoomId: string) => void;
}) {
  const [hov, setHov]           = useState(false);
  const [draggingRoom, setDraggingRoom] = useState(false);
  const rgb = hexToRgb(site.color);

  const surgeon   = people.find((a) => a.staff?.role === 'surgeon');
  const mdPeople  = people.filter((a) => a.staff && ['physician', 'resident'].includes(a.staff.role));
  const crnaPeople = people.filter((a) => a.staff && ['crna', 'srna'].includes(a.staff.role));

  const hasSupervised = people.some((a) => a.staff && SUPERVISED_ROLES.includes(a.staff.role));
  const hasMd         = people.some((a) => a.staff?.role === 'physician');
  const needsMd       = hasSupervised && !hasMd;

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('roomId', room.id); setDraggingRoom(true); e.stopPropagation(); }}
      onDragEnd={() => setDraggingRoom(false)}
      onDragOver={(e) => {
        e.preventDefault();
        const roomId = e.dataTransfer.getData('roomId');
        if (roomId && roomId !== room.id) { onReorderRoom(room.id); return; }
        if (!roomId) onDragOver();
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const roomId = e.dataTransfer.getData('roomId');
        if (roomId) return; // room reorder handled in onDragOver
        onDrop();
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        flexShrink: 0, width: 'auto', minWidth: 152, minHeight: 132,
        borderRadius: 12, border: '1px solid',
        borderColor: isOver ? site.color : needsMd ? 'color-mix(in srgb, var(--warn) 50%, transparent)' : draggingRoom ? site.color : 'var(--border-faint)',
        background: isOver ? 'rgba(' + rgb + ',0.09)' : draggingRoom ? 'rgba(' + rgb + ',0.04)' : 'var(--bg-deep)',
        boxShadow: isOver ? '0 0 16px rgba(' + rgb + ',0.25)' : '0 1px 2px rgba(15,23,42,0.04)',
        transition: 'all 0.14s', cursor: draggingRoom ? 'grabbing' : 'default',
        display: 'flex', flexDirection: 'column', position: 'relative',
        opacity: draggingRoom ? 0.5 : 1,
      }}
    >
      {/* Room header */}
      <div style={{ padding: '7px 10px 6px', borderBottom: '1px solid var(--border-muted)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
          <span style={{ fontSize: 12.5, fontWeight: 750, color: 'var(--text)', letterSpacing: 0.2, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
            {room.name}
            {surgeon?.staff && (
              <span style={{ fontSize: 11, color: ROLE_META.surgeon.color, fontWeight: 600, marginLeft: 5, fontFamily: 'var(--font-sans)' }}>
                — {surgeon.staff.name}
              </span>
            )}
          </span>
          {needsMd && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)', borderRadius: 3, padding: '0 4px', whiteSpace: 'nowrap' }}>⚠ No MD</span>}
        </div>
      </div>

      {/* Stacked: MD on top, CRNA below */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 6px 6px' }}>
        {/* MD / Resident */}
        {mdPeople.map((a) => a.staff ? <PersonChip key={a.id} assignment={a} person={a.staff} alertLevels={alertLevels} dailyShifts={dailyShifts} onRemove={() => onRemoveAssignment(a.id)} /> : null)}

        {/* Divider between MD and CRNA when both present */}
        {mdPeople.length > 0 && crnaPeople.length > 0 && (
          <div style={{ height: 1, background: 'var(--border-muted)', margin: '1px 0' }} />
        )}

        {/* CRNA / SRNA */}
        {crnaPeople.map((a) => a.staff ? <PersonChip key={a.id} assignment={a} person={a.staff} alertLevels={alertLevels} dailyShifts={dailyShifts} onRemove={() => onRemoveAssignment(a.id)} /> : null)}

        {people.length === 0 && !isOver && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, color: 'var(--text-dim)', fontStyle: 'italic' }}>
            drop here
          </div>
        )}
        {isOver && people.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: site.color, fontWeight: 700 }}>
            Release
          </div>
        )}
      </div>

      {/* Delete room button */}
      {hov && !dragging && (
        <button onClick={onDeleteRoom} style={{ position: 'absolute', top: -8, right: -8, width: 22, height: 22, borderRadius: '50%', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, zIndex: 10, padding: 0 }}>×</button>
      )}
    </div>
  );
}

// ── Person chip inside a room ─────────────────────────────────────────────────
function PersonChip({ assignment, person, alertLevels, dailyShifts, onRemove }: {
  assignment: Assignment; person: StaffMember;
  alertLevels: Record<string, 'none' | 'warning' | 'critical'>;
  dailyShifts: Record<string, ShiftHours>;
  onRemove: () => void;
}) {
  const m     = ROLE_META[person.role] || ROLE_META.crna;
  const alert = alertLevels[person.id] || 'none';
  const hours = person.role !== 'physician' && person.role !== 'surgeon' ? (dailyShifts[person.id] || person.hours) : null;

  // Surgeon shown in room header, not as chip
  if (person.role === 'surgeon') return null;

  return (
    <div onClick={onRemove} title={person.name + ' — click to unassign'}
      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 7px', borderRadius: 6, cursor: 'pointer', background: m.bg, color: m.color, border: '1px solid ' + (alert === 'critical' ? 'color-mix(in srgb, var(--danger) 70%, transparent)' : alert === 'warning' ? 'color-mix(in srgb, var(--warn) 60%, transparent)' : m.border), fontSize: 12, fontWeight: 700, position: 'relative', transition: 'opacity 0.12s' }}
      onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
      onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}>
      {alert !== 'none' && <div style={{ position: 'absolute', inset: 0, borderRadius: 6, border: '1px solid ' + (alert === 'critical' ? 'color-mix(in srgb, var(--danger) 70%, transparent)' : 'color-mix(in srgb, var(--warn) 60%, transparent)'), animation: 'relief-flash ' + (alert === 'critical' ? '1s' : '2s') + ' ease-in-out infinite', pointerEvents: 'none' }} />}
      <span style={{ fontWeight: 800, fontSize: 11, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>{person.initials}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90 }}>{person.name.split(' ').pop()}</span>
      {hours && <ShiftBadge hours={hours} role={person.role} />}
      <span style={{ opacity: 0.4, fontSize: 12 }}>×</span>
    </div>
  );
}

// ── Float site card ───────────────────────────────────────────────────────────
function FloatSiteCard({ site, floatAssignments, dragging, isOver, dailyShifts, alertLevels, onDragOver, onDragLeave, onDropFloat, onRemoveAssignment }: {
  site: Site; floatAssignments: Assignment[]; dragging: DraggedPerson | null;
  isOver: boolean; dailyShifts: Record<string, ShiftHours>;
  alertLevels: Record<string, 'none' | 'warning' | 'critical'>;
  onDragOver: () => void; onDragLeave: () => void; onDropFloat: () => void;
  onRemoveAssignment: (id: string) => void;
}) {
  const rgb = hexToRgb(site.color);
  return (
    <div style={{ background: 'var(--bg-surface)', borderRadius: 14, border: '1px solid ' + (isOver ? site.color : 'var(--border)'), marginBottom: 14, boxShadow: isOver ? '0 0 20px rgba(' + rgb + ',0.2)' : 'none', transition: 'all 0.15s' }}>
      <div style={{ padding: '7px 12px', display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: '1px solid rgba(' + rgb + ',0.32)', background: 'linear-gradient(135deg,rgba(' + rgb + ',0.28) 0%,rgba(' + rgb + ',0.14) 100%)', borderRadius: '14px 14px 0 0' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: site.color }}>{site.name}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>· {floatAssignments.length} floating · giving breaks or standby</span>
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
        onDragLeave={onDragLeave}
        onDrop={(e) => { e.preventDefault(); onDropFloat(); }}
        style={{ padding: '12px 14px', minHeight: 70, display: 'flex', flexWrap: 'wrap', gap: 7, alignContent: 'flex-start', background: isOver ? 'rgba(' + rgb + ',0.04)' : 'transparent', transition: 'background 0.15s' }}
      >
        {floatAssignments.length === 0 && (
          <div style={{ color: isOver ? site.color : 'var(--text-dim)', fontSize: 13, fontStyle: isOver ? 'normal' : 'italic', fontWeight: isOver ? 700 : 400, width: '100%', textAlign: 'center', paddingTop: 8 }}>
            {isOver ? 'Release to float' : 'Drop staff here to float'}
          </div>
        )}
        {floatAssignments.map((a) => {
          const p = a.staff; if (!p) return null;
          const m = ROLE_META[p.role] || ROLE_META.crna;
          const h = p.role !== 'physician' ? (dailyShifts[p.id] || p.hours) : null;
          const al = alertLevels[p.id] || 'none';
          return (
            <div key={a.id} onClick={() => onRemoveAssignment(a.id)} title={p.name + ' — click to remove'}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 7px', borderRadius: 5, cursor: 'pointer', background: m.bg, color: m.color, border: '1px solid ' + m.border, fontSize: 10, fontWeight: 700 }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.7')}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}>
              <span style={{ fontWeight: 800, fontSize: 9, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>{p.initials}</span>
              <span>{p.name.split(' ').pop()}</span>
              {h && <ShiftBadge hours={h} role={p.role} />}
              <span style={{ opacity: 0.3, fontSize: 11 }}>×</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
