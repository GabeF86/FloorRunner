'use client';

import { useState, useRef } from 'react';
import { Site, Room, Assignment, ROLE_META, DraggedPerson, SUPERVISED_ROLES, ShiftHours } from '@/types';
import { hexToRgb } from './BoardClient';
import { ShiftBadge } from './ShiftBadge';
import PersonChip from './PersonChip';
import { BT, BOARD_DROP_TARGET_CLASS } from './boardTheme';

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
  // Wall display: render the float card as a static panel (no drop wiring, no
  // remove affordances). Defaults false — the grid/editing path is unaffected.
  readOnly?:          boolean;
}

export default function SiteCard(props: Props) {
  const { site, roomAssignments, floatAssignments, dragOver, dragging, alertLevels, dailyShifts, roomsHeight, onResizeHeight, readOnly = false } = props;
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
      site={site} floatAssignments={floatAssignments}
      isOver={dragOver === 'float-' + site.id} dailyShifts={dailyShifts} alertLevels={alertLevels}
      readOnly={readOnly}
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
      style={{ background: 'var(--bg-surface)', borderRadius: BT.siteHeader.radius, border: '1px solid var(--border)', overflow: 'visible', marginBottom: 12 }}
    >
      <SiteHeader site={site} showDelete={hov} onAddRoom={props.onAddRoom} onDeleteSite={props.onDeleteSite} />

      {/* Rooms — wrapping */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: BT.roomsArea.gap, padding: BT.roomsArea.pad, overflowX: 'hidden', overflowY: 'auto', alignContent: 'flex-start', minHeight: 72, maxHeight: roomsHeight ?? undefined }}>
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
        style={{ height: 6, cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: `0 0 ${BT.siteHeader.radius}px ${BT.siteHeader.radius}px`, background: hov ? `rgba(${rgb},0.08)` : 'transparent', transition: 'background 0.15s' }}
      >
        <div style={{ width: 32, height: 3, borderRadius: 2, background: hov ? `rgba(${rgb},0.4)` : 'var(--tint-surface-strong)', transition: 'background 0.15s' }} />
      </div>
    </div>
  );
}

// ── Site header (solid bar) ───────────────────────────────────────────────────
// Extracted so RowsView reuses the exact same treatment (spec §3). White text
// is tuned for the dark palette (applied as data at the Task 9 gate). On the
// current light DB colors this header is intentionally washed out in the
// interim (worst offenders: EP Lab #f59e0b at 2.15:1, Endoscopy #10b981 at
// 2.54:1 vs white) — do not add per-color conditionals. `showDelete` is the
// host card's hover state (Delete Site reveals on hover, matching grid cards).
export function SiteHeader({ site, showDelete, onAddRoom, onDeleteSite, readOnly = false }: {
  site: Site; showDelete: boolean; onAddRoom: () => void; onDeleteSite: () => void;
  // Wall display: drop the entire action cluster (+ Room / Delete Site) so the
  // header is a pure label with no edit affordances.
  readOnly?: boolean;
}) {
  return (
    <div style={{ padding: BT.siteHeader.pad, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: site.color, borderRadius: `${BT.siteHeader.radius}px ${BT.siteHeader.radius}px 0 0` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: BT.siteHeader.nameSize, fontWeight: 750, color: '#fff', letterSpacing: -0.3 }}>{site.name}</span>
        <span style={{ fontSize: BT.siteHeader.countSize, color: 'rgba(255,255,255,.65)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>· {site.rooms.length} rooms</span>
      </div>
      {!readOnly && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button draggable={false} onClick={(e) => { e.stopPropagation(); onAddRoom(); }} style={{ background: 'rgba(255,255,255,.14)', border: '1px solid rgba(255,255,255,.3)', color: '#fff', borderRadius: BT.chip.radius, padding: '2px 8px', fontSize: BT.font.chip, fontWeight: 700, cursor: 'pointer' }}>+ Room</button>
          {showDelete && <button draggable={false} onClick={(e) => { e.stopPropagation(); onDeleteSite(); }} style={{ background: 'rgba(255,255,255,.12)', border: '1px solid rgba(254,202,202,.4)', color: '#fecaca', borderRadius: BT.chip.radius, padding: '2px 8px', fontSize: BT.font.chip, fontWeight: 700, cursor: 'pointer' }}>Delete Site</button>}
        </div>
      )}
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
      className={BOARD_DROP_TARGET_CLASS}
      style={{
        flexShrink: 0, width: 'auto', minWidth: BT.room.minWidth, minHeight: BT.room.minHeight,
        borderRadius: BT.room.radius, border: '1px solid',
        borderColor: isOver ? site.color : needsMd ? 'color-mix(in srgb, var(--warn) 50%, transparent)' : draggingRoom ? site.color : 'var(--border-faint)',
        background: isOver ? 'rgba(' + rgb + ',0.09)' : draggingRoom ? 'rgba(' + rgb + ',0.04)' : 'var(--bg-deep)',
        boxShadow: isOver ? '0 0 16px rgba(' + rgb + ',0.25)' : '0 1px 2px rgba(15,23,42,0.04)',
        transform: isOver ? BT.drag.hoverScale : 'none',
        cursor: draggingRoom ? 'grabbing' : 'default',
        display: 'flex', flexDirection: 'column', position: 'relative',
        opacity: draggingRoom ? 0.5 : 1,
      }}
    >
      {/* Room header */}
      <div style={{ padding: BT.room.headerPad, borderBottom: '1px solid var(--border-muted)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
          <span style={{ fontSize: BT.font.roomName, fontWeight: 750, color: 'var(--text)', letterSpacing: 0.2, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
            {room.name}
            {surgeon?.staff && (
              <span title={surgeon.staff.name} style={{ fontSize: BT.font.chipSub, color: ROLE_META.surgeon.color, fontWeight: 600, marginLeft: 5, fontFamily: 'var(--font-sans)' }}>
                — {surgeon.staff.name.split(' ').pop()}
              </span>
            )}
          </span>
          {needsMd && <span style={{ fontSize: BT.font.chipSub, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)', borderRadius: 3, padding: '0 4px', whiteSpace: 'nowrap' }}>⚠ No MD</span>}
        </div>
      </div>

      {/* Stacked: MD on top, CRNA below */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: BT.room.gap, padding: BT.room.bodyPad }}>
        {/* MD / Resident */}
        {mdPeople.map((a) => a.staff ? <PersonChip key={a.id} assignment={a} person={a.staff} alertLevels={alertLevels} dailyShifts={dailyShifts} onRemove={() => onRemoveAssignment(a.id)} /> : null)}

        {/* Divider between MD and CRNA when both present */}
        {mdPeople.length > 0 && crnaPeople.length > 0 && (
          <div style={{ height: 1, background: 'var(--border-muted)', margin: '1px 0' }} />
        )}

        {/* CRNA / SRNA */}
        {crnaPeople.map((a) => a.staff ? <PersonChip key={a.id} assignment={a} person={a.staff} alertLevels={alertLevels} dailyShifts={dailyShifts} onRemove={() => onRemoveAssignment(a.id)} /> : null)}

        {people.length === 0 && !isOver && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: BT.font.roomName, color: 'var(--text-dim)', fontStyle: 'italic' }}>
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
        <button onClick={onDeleteRoom} title={`Delete ${room.name}`} style={{ position: 'absolute', top: -8, right: -8, width: 22, height: 22, borderRadius: '50%', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, zIndex: 10, padding: 0 }}>×</button>
      )}
    </div>
  );
}

// ── Float site card ───────────────────────────────────────────────────────────
function FloatSiteCard({ site, floatAssignments, isOver, dailyShifts, alertLevels, readOnly = false, onDragOver, onDragLeave, onDropFloat, onRemoveAssignment }: {
  site: Site; floatAssignments: Assignment[];
  isOver: boolean; dailyShifts: Record<string, ShiftHours>;
  alertLevels: Record<string, 'none' | 'warning' | 'critical'>;
  readOnly?: boolean;
  onDragOver: () => void; onDragLeave: () => void; onDropFloat: () => void;
  onRemoveAssignment: (id: string) => void;
}) {
  const rgb = hexToRgb(site.color);
  return (
    <div
      className={readOnly ? undefined : BOARD_DROP_TARGET_CLASS}
      style={{ background: 'var(--bg-surface)', borderRadius: BT.siteHeader.radius, border: '1px solid ' + (isOver ? site.color : 'var(--border)'), marginBottom: 12, boxShadow: isOver ? '0 0 20px rgba(' + rgb + ',0.2)' : 'none', transform: !readOnly && isOver ? BT.drag.hoverScale : 'none' }}>
      <div style={{ padding: BT.siteHeader.pad, display: 'flex', alignItems: 'baseline', gap: 8, borderBottom: '1px solid rgba(' + rgb + ',0.32)', background: 'linear-gradient(135deg,rgba(' + rgb + ',0.28) 0%,rgba(' + rgb + ',0.14) 100%)', borderRadius: `${BT.siteHeader.radius}px ${BT.siteHeader.radius}px 0 0` }}>
        <span style={{ fontSize: BT.siteHeader.nameSize, fontWeight: 700, color: site.color }}>{site.name}</span>
        <span style={{ fontSize: BT.siteHeader.countSize, color: 'var(--text-muted)', fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>· {floatAssignments.length} floating · giving breaks or standby</span>
      </div>
      <div
        onDragOver={readOnly ? undefined : (e) => { e.preventDefault(); onDragOver(); }}
        onDragLeave={readOnly ? undefined : onDragLeave}
        onDrop={readOnly ? undefined : (e) => { e.preventDefault(); onDropFloat(); }}
        style={{ padding: BT.roomsArea.pad, minHeight: 72, display: 'flex', flexWrap: 'wrap', gap: BT.roomsArea.gap, alignContent: 'flex-start', background: isOver ? 'rgba(' + rgb + ',0.04)' : 'transparent', transition: 'background 0.15s' }}
      >
        {floatAssignments.length === 0 && (
          <div style={{ color: isOver ? site.color : 'var(--text-dim)', fontSize: 13, fontStyle: isOver ? 'normal' : 'italic', fontWeight: isOver ? 700 : 400, width: '100%', textAlign: 'center', paddingTop: 8 }}>
            {readOnly ? 'No one floating' : isOver ? 'Release to float' : 'Drop staff here to float'}
          </div>
        )}
        {floatAssignments.map((a) => {
          const p = a.staff; if (!p) return null;
          const m = ROLE_META[p.role] || ROLE_META.crna;
          const h = p.role !== 'physician' ? (dailyShifts[p.id] || p.hours) : null;
          const al = alertLevels[p.id] || 'none';
          return (
            <div key={a.id} onClick={readOnly ? undefined : () => onRemoveAssignment(a.id)} title={readOnly ? p.name : p.name + ' — click to remove'}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: BT.chip.pad, minHeight: BT.chip.minHeight, borderRadius: BT.chip.radius, cursor: readOnly ? 'default' : 'pointer', background: m.bg, color: m.color, border: '1px solid ' + m.border, fontSize: BT.font.chip, fontWeight: 700 }}
              onMouseEnter={readOnly ? undefined : (e) => (e.currentTarget.style.opacity = '0.7')}
              onMouseLeave={readOnly ? undefined : (e) => (e.currentTarget.style.opacity = '1')}>
              <span style={{ fontWeight: 800, fontSize: BT.font.chipSub, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>{p.initials}</span>
              <span>{p.name.split(' ').pop()}</span>
              {h && <ShiftBadge hours={h} role={p.role} />}
              {!readOnly && <span style={{ opacity: 0.3, fontSize: BT.font.chipSub }}>×</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
