'use client';

import { useState } from 'react';
import { Site, Room, Assignment, ROLE_META, DraggedPerson, SUPERVISED_ROLES, ShiftHours } from '@/types';
import { hexToRgb, AddSiteTile } from './BoardClient';
import SiteCard, { SiteHeader } from './SiteCard';
import PersonChip from './PersonChip';
import { BT } from './boardTheme';

// ── Rows view ─────────────────────────────────────────────────────────────────
// Third board view (spec §2): every room is ONE horizontal line; rooms flow
// top-to-bottom into balanced newspaper columns (CSS multi-column, see
// RowsSiteCard). Site cards stack full-width so each site gets the whole board
// width to spread its columns.
//
// Float zone stays as-is: the float site keeps its existing FloatSiteCard look
// by routing through the unchanged <SiteCard/> (which early-returns the float
// card). Only NON-float site cards change shape here. The FloatBar, relieved
// box, and out-list live in BoardClient outside the view switch and are
// untouched by rows mode.
//
// Ordering note: grid mode groups small sites into shared 2-col spans; rows
// mode renders every card full-width, so it uses natural DB position order
// (non-float first, float last) — no small/large grouping needed.
interface Props {
  filteredSites:      Site[];
  floatAssignments:   Assignment[];
  roomAssignments:    Record<string, Assignment[]>;
  dragOver:           string | null;
  dragging:           DraggedPerson | null;
  alertLevels:        Record<string, 'none' | 'warning' | 'critical'>;
  dailyShifts:        Record<string, ShiftHours>;
  siteHeights:        Record<string, number>;
  onDrop:             (roomId: string) => void;
  onDropFloat:        (siteId: string) => void;
  onDragOver:         (id: string) => void;
  onDragLeave:        () => void;
  onRemoveAssignment: (id: string) => void;
  onAddRoom:          (siteId: string) => void;
  onDeleteRoom:       (siteId: string, roomId: string) => void;
  onDeleteSite:       (siteId: string) => void;
  onReorderRoom:      (siteId: string, roomId: string, targetRoomId: string) => void;
  onResizeHeight:     (siteId: string, h: number) => void;
  onAddSite:          () => void;
}

export default function RowsView(props: Props) {
  const ordered = [
    ...props.filteredSites.filter((s) => !s.is_float),
    ...props.filteredSites.filter((s) => s.is_float),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {ordered.map((site, i) =>
        site.is_float ? (
          // Float zone — unchanged FloatSiteCard treatment via the shared SiteCard.
          <SiteCard
            key={site.id}
            site={site} index={i}
            roomAssignments={props.roomAssignments}
            floatAssignments={props.floatAssignments}
            dragOver={props.dragOver} dragging={props.dragging}
            alertLevels={props.alertLevels} dailyShifts={props.dailyShifts}
            roomsHeight={props.siteHeights[site.id]}
            onDrop={props.onDrop}
            onDropFloat={props.onDropFloat}
            onDragOver={props.onDragOver}
            onDragLeave={props.onDragLeave}
            onRemoveAssignment={props.onRemoveAssignment}
            onAddRoom={() => props.onAddRoom(site.id)}
            onDeleteRoom={(roomId) => props.onDeleteRoom(site.id, roomId)}
            onDeleteSite={() => props.onDeleteSite(site.id)}
            onReorderRoom={props.onReorderRoom}
            onResizeHeight={(h) => props.onResizeHeight(site.id, h)}
          />
        ) : (
          <RowsSiteCard
            key={site.id}
            site={site}
            roomAssignments={props.roomAssignments}
            dragOver={props.dragOver}
            alertLevels={props.alertLevels} dailyShifts={props.dailyShifts}
            roomsHeight={props.siteHeights[site.id]}
            onDrop={props.onDrop}
            onDragOver={props.onDragOver}
            onDragLeave={props.onDragLeave}
            onRemoveAssignment={props.onRemoveAssignment}
            onAddRoom={() => props.onAddRoom(site.id)}
            onDeleteSite={() => props.onDeleteSite(site.id)}
          />
        )
      )}
      <AddSiteTile onClick={props.onAddSite} />
    </div>
  );
}

// ── One site as stacked room-lines in balanced columns ────────────────────────
function RowsSiteCard({ site, roomAssignments, dragOver, alertLevels, dailyShifts, roomsHeight, onDrop, onDragOver, onDragLeave, onRemoveAssignment, onAddRoom, onDeleteSite }: {
  site: Site; roomAssignments: Record<string, Assignment[]>;
  dragOver: string | null;
  alertLevels: Record<string, 'none' | 'warning' | 'critical'>;
  dailyShifts: Record<string, ShiftHours>;
  roomsHeight?: number;
  onDrop: (roomId: string) => void; onDragOver: (id: string) => void; onDragLeave: () => void;
  onRemoveAssignment: (id: string) => void; onAddRoom: () => void; onDeleteSite: () => void;
}) {
  const [hov, setHov] = useState(false);

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ background: 'var(--bg-surface)', borderRadius: BT.siteHeader.radius, border: '1px solid var(--border)', overflow: 'hidden' }}
    >
      <SiteHeader site={site} showDelete={hov} onAddRoom={onAddRoom} onDeleteSite={onDeleteSite} />

      {/* Column flow: CSS multi-column gives height-driven fill with automatic
          balance; column-rule renders the divider between columns (spec §2 —
          rooms flow down, spill right). breakInside:avoid keeps a room-line
          intact across a column break. Default (no user resize) has no height
          cap, so rooms balance across floor(width/260) columns and the card
          grows to fit. When the site box is resized (roomsHeight set) the cap
          applies and any overflow scrolls — multicol layout does not affect
          drop-target event handling, so RoomRow drops work in every column. */}
      <div style={{ padding: '6px 8px', columnWidth: 260, columnGap: 16, columnRule: BT.rows.divider, maxHeight: roomsHeight ?? undefined, overflowY: 'auto' }}>
        {site.rooms.map((room) => (
          <div key={room.id} style={{ breakInside: 'avoid', marginBottom: 3 }}>
            <RoomRow
              room={room} site={site}
              people={roomAssignments[room.id] || []}
              isOver={dragOver === room.id}
              alertLevels={alertLevels} dailyShifts={dailyShifts}
              onDrop={() => onDrop(room.id)}
              onDragOver={() => onDragOver(room.id)}
              onDragLeave={onDragLeave}
              onRemoveAssignment={onRemoveAssignment}
            />
          </div>
        ))}
        {site.rooms.length === 0 && (
          <div style={{ padding: '6px 4px', color: 'var(--text-dim)', fontSize: 11, fontStyle: 'italic' }}>
            No rooms yet — click + Room to add one
          </div>
        )}
      </div>
    </div>
  );
}

// ── One room as a single horizontal line ──────────────────────────────────────
// Full drop-target parity with SiteCard's RoomCell: same handleDrop(room.id)
// wiring, same drag-over glow keyed to site.color, same remove-on-chip-click
// (via the shared PersonChip). People are partitioned exactly as RoomCell —
// surgeon shown last as amber last-name text, MD then CRNA as chips. Chips
// flexWrap so a heavily-staffed room wraps to a second line rather than hiding
// anyone (spec risk #3). No-MD warning = amber row border + compact ⚠ MD badge.
function RoomRow({ room, site, people, isOver, alertLevels, dailyShifts, onDrop, onDragOver, onDragLeave, onRemoveAssignment }: {
  room: Room; site: Site; people: Assignment[];
  isOver: boolean;
  alertLevels: Record<string, 'none' | 'warning' | 'critical'>;
  dailyShifts: Record<string, ShiftHours>;
  onDrop: () => void; onDragOver: () => void; onDragLeave: () => void;
  onRemoveAssignment: (id: string) => void;
}) {
  const rgb = hexToRgb(site.color);

  const surgeon    = people.find((a) => a.staff?.role === 'surgeon');
  const mdPeople   = people.filter((a) => a.staff && ['physician', 'resident'].includes(a.staff.role));
  const crnaPeople = people.filter((a) => a.staff && ['crna', 'srna'].includes(a.staff.role));

  const hasSupervised = people.some((a) => a.staff && SUPERVISED_ROLES.includes(a.staff.role));
  const hasMd         = people.some((a) => a.staff?.role === 'physician');
  const needsMd       = hasSupervised && !hasMd;

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDragLeave={onDragLeave}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(); }}
      style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5,
        minHeight: BT.rows.rowMinHeight, padding: BT.rows.rowPad,
        borderRadius: BT.chip.radius, border: '1px solid',
        borderColor: isOver ? site.color : needsMd ? 'rgba(245,158,11,.4)' : 'var(--border-faint)',
        background: isOver ? `rgba(${rgb},0.09)` : 'var(--bg-deep)',
        boxShadow: isOver ? `0 0 12px rgba(${rgb},0.22)` : 'none',
        transition: 'all 0.14s',
      }}
    >
      <span style={{ minWidth: 44, flexShrink: 0, fontSize: BT.font.roomName, fontWeight: 750, color: 'var(--text)', letterSpacing: 0.2, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
        {room.name}
      </span>

      {needsMd && (
        <span style={{ flexShrink: 0, fontSize: BT.font.chipSub, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)', borderRadius: 3, padding: '0 4px', whiteSpace: 'nowrap' }}>⚠ MD</span>
      )}

      {mdPeople.map((a) => a.staff ? <PersonChip key={a.id} assignment={a} person={a.staff} alertLevels={alertLevels} dailyShifts={dailyShifts} onRemove={() => onRemoveAssignment(a.id)} /> : null)}
      {crnaPeople.map((a) => a.staff ? <PersonChip key={a.id} assignment={a} person={a.staff} alertLevels={alertLevels} dailyShifts={dailyShifts} onRemove={() => onRemoveAssignment(a.id)} /> : null)}

      {surgeon?.staff && (
        <span title={surgeon.staff.name} style={{ flexShrink: 0, fontSize: BT.font.chipSub, color: ROLE_META.surgeon.color, fontWeight: 600, marginLeft: 2, whiteSpace: 'nowrap', fontFamily: 'var(--font-sans)' }}>
          — {surgeon.staff.name.split(' ').pop()}
        </span>
      )}

      {people.length === 0 && (
        <span style={{ fontSize: BT.font.chip, color: isOver ? site.color : 'var(--text-dim)', fontStyle: isOver ? 'normal' : 'italic', fontWeight: isOver ? 700 : 400 }}>
          {isOver ? 'Release' : 'drop staff'}
        </span>
      )}
    </div>
  );
}
