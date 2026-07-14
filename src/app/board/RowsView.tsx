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
//
// Cards-only affordances (by design, not oversights):
// - Room drag-reorder: multicol flow renders rooms column-major, so visual
//   order ≠ list order and drag-reorder semantics would be ambiguous. Reorder
//   rooms in Cards view; no onReorderRoom prop here.
// - Site resize HANDLE: rows cards still honor a height set in Cards view
//   (siteHeights → maxHeight in RowsSiteCard) but expose no drag handle of
//   their own; no onResizeHeight prop here.
interface Props {
  filteredSites:      Site[];
  floatAssignments:   Assignment[];
  roomAssignments:    Record<string, Assignment[]>;
  dragOver:           string | null;
  dragging:           DraggedPerson | null;
  alertLevels:        Record<string, 'none' | 'warning' | 'critical'>;
  dailyShifts:        Record<string, ShiftHours>;
  siteHeights:        Record<string, number>;
  // Wall display: strips ALL editing — no drop wiring, no chip remove, no
  // delete ×, no + Room / Delete Site header buttons, no Add-Site tile, no
  // hover affordances. Defaults false; the grid/board editing path is
  // unaffected (BoardClient never sets it).
  readOnly?:          boolean;
  // Edit-mode handlers — the board passes all of them; the wall passes none.
  // Optional with no-op defaults so read-only callers stay clean and the
  // rendering code below can call them unconditionally where !readOnly.
  onDrop?:             (roomId: string) => void;
  onDropFloat?:        (siteId: string) => void;
  onDragOver?:         (id: string) => void;
  onDragLeave?:        () => void;
  onRemoveAssignment?: (id: string) => void;
  onAddRoom?:          (siteId: string) => void;
  onDeleteRoom?:       (siteId: string, roomId: string) => void;
  onDeleteSite?:       (siteId: string) => void;
  onAddSite?:          () => void;
}

export default function RowsView({
  filteredSites, floatAssignments, roomAssignments, dragOver, dragging,
  alertLevels, dailyShifts, siteHeights, readOnly = false,
  onDrop = () => {}, onDropFloat = () => {}, onDragOver = () => {},
  onDragLeave = () => {}, onRemoveAssignment = () => {}, onAddRoom = () => {},
  onDeleteRoom = () => {}, onDeleteSite = () => {}, onAddSite = () => {},
}: Props) {
  const ordered = [
    ...filteredSites.filter((s) => !s.is_float),
    ...filteredSites.filter((s) => s.is_float),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {ordered.map((site, i) =>
        site.is_float ? (
          // Float zone — unchanged FloatSiteCard treatment via the shared
          // SiteCard, which honors readOnly (static panel on the wall).
          <SiteCard
            key={site.id}
            site={site} index={i}
            roomAssignments={roomAssignments}
            floatAssignments={floatAssignments}
            dragOver={dragOver} dragging={dragging}
            alertLevels={alertLevels} dailyShifts={dailyShifts}
            roomsHeight={siteHeights[site.id]}
            readOnly={readOnly}
            onDrop={onDrop}
            onDropFloat={onDropFloat}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onRemoveAssignment={onRemoveAssignment}
            onAddRoom={() => onAddRoom(site.id)}
            onDeleteRoom={(roomId) => onDeleteRoom(site.id, roomId)}
            onDeleteSite={() => onDeleteSite(site.id)}
            // SiteCard's Props require these, but is_float early-returns
            // FloatSiteCard which has no rooms to reorder and no resize
            // handle — provably unreachable, so no-ops (not threaded props).
            onReorderRoom={() => {}}
            onResizeHeight={() => {}}
          />
        ) : (
          <RowsSiteCard
            key={site.id}
            site={site}
            roomAssignments={roomAssignments}
            dragOver={dragOver} dragging={dragging}
            alertLevels={alertLevels} dailyShifts={dailyShifts}
            roomsHeight={siteHeights[site.id]}
            readOnly={readOnly}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onRemoveAssignment={onRemoveAssignment}
            onAddRoom={() => onAddRoom(site.id)}
            onDeleteRoom={(roomId) => onDeleteRoom(site.id, roomId)}
            onDeleteSite={() => onDeleteSite(site.id)}
          />
        )
      )}
      {!readOnly && <AddSiteTile onClick={onAddSite} />}
    </div>
  );
}

// ── One site as stacked room-lines in balanced columns ────────────────────────
function RowsSiteCard({ site, roomAssignments, dragOver, dragging, alertLevels, dailyShifts, roomsHeight, readOnly, onDrop, onDragOver, onDragLeave, onRemoveAssignment, onAddRoom, onDeleteRoom, onDeleteSite }: {
  site: Site; roomAssignments: Record<string, Assignment[]>;
  dragOver: string | null; dragging: DraggedPerson | null;
  alertLevels: Record<string, 'none' | 'warning' | 'critical'>;
  dailyShifts: Record<string, ShiftHours>;
  roomsHeight?: number; readOnly: boolean;
  onDrop: (roomId: string) => void; onDragOver: (id: string) => void; onDragLeave: () => void;
  onRemoveAssignment: (id: string) => void; onAddRoom: () => void;
  onDeleteRoom: (roomId: string) => void; onDeleteSite: () => void;
}) {
  const [hov, setHov] = useState(false);

  return (
    <div
      onMouseEnter={readOnly ? undefined : () => setHov(true)}
      onMouseLeave={readOnly ? undefined : () => setHov(false)}
      style={{ background: 'var(--bg-surface)', borderRadius: BT.siteHeader.radius, border: '1px solid var(--border)', overflow: 'hidden' }}
    >
      <SiteHeader site={site} showDelete={hov} onAddRoom={onAddRoom} onDeleteSite={onDeleteSite} readOnly={readOnly} />

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
              dragging={dragging}
              alertLevels={alertLevels} dailyShifts={dailyShifts}
              readOnly={readOnly}
              onDrop={() => onDrop(room.id)}
              onDragOver={() => onDragOver(room.id)}
              onDragLeave={onDragLeave}
              onRemoveAssignment={onRemoveAssignment}
              onDeleteRoom={() => onDeleteRoom(room.id)}
            />
          </div>
        ))}
        {site.rooms.length === 0 && (
          <div style={{ padding: '6px 4px', color: 'var(--text-dim)', fontSize: 11, fontStyle: 'italic' }}>
            {readOnly ? 'No rooms' : 'No rooms yet — click + Room to add one'}
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
function RoomRow({ room, site, people, isOver, dragging, alertLevels, dailyShifts, readOnly, onDrop, onDragOver, onDragLeave, onRemoveAssignment, onDeleteRoom }: {
  room: Room; site: Site; people: Assignment[];
  isOver: boolean; dragging: DraggedPerson | null;
  alertLevels: Record<string, 'none' | 'warning' | 'critical'>;
  dailyShifts: Record<string, ShiftHours>;
  readOnly: boolean;
  onDrop: () => void; onDragOver: () => void; onDragLeave: () => void;
  onRemoveAssignment: (id: string) => void; onDeleteRoom: () => void;
}) {
  const [hov, setHov] = useState(false);
  const rgb = hexToRgb(site.color);

  const surgeon    = people.find((a) => a.staff?.role === 'surgeon');
  const mdPeople   = people.filter((a) => a.staff && ['physician', 'resident'].includes(a.staff.role));
  const crnaPeople = people.filter((a) => a.staff && ['crna', 'srna'].includes(a.staff.role));

  const hasSupervised = people.some((a) => a.staff && SUPERVISED_ROLES.includes(a.staff.role));
  const hasMd         = people.some((a) => a.staff?.role === 'physician');
  const needsMd       = hasSupervised && !hasMd;

  return (
    <div
      // Read-only (wall): no drop wiring and no hover — a static status line.
      // The No-MD amber border stays (it's information, not an edit affordance).
      onDragOver={readOnly ? undefined : (e) => { e.preventDefault(); onDragOver(); }}
      onDragLeave={readOnly ? undefined : onDragLeave}
      onDrop={readOnly ? undefined : (e) => { e.preventDefault(); e.stopPropagation(); onDrop(); }}
      onMouseEnter={readOnly ? undefined : () => setHov(true)}
      onMouseLeave={readOnly ? undefined : () => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5,
        minHeight: BT.rows.rowMinHeight, padding: BT.rows.rowPad,
        borderRadius: BT.chip.radius, border: '1px solid',
        borderColor: isOver ? site.color : needsMd ? 'rgba(245,158,11,.4)' : 'var(--border-faint)',
        background: isOver ? `rgba(${rgb},0.09)` : 'var(--bg-deep)',
        boxShadow: isOver ? `0 0 12px rgba(${rgb},0.22)` : 'none',
        transition: 'all 0.14s', position: 'relative',
      }}
    >
      <span style={{ minWidth: 44, flexShrink: 0, fontSize: BT.font.roomName, fontWeight: 750, color: 'var(--text)', letterSpacing: 0.2, fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
        {room.name}
      </span>

      {needsMd && (
        <span style={{ flexShrink: 0, fontSize: BT.font.chipSub, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-bg)', border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)', borderRadius: 3, padding: '0 4px', whiteSpace: 'nowrap' }}>⚠ MD</span>
      )}

      {mdPeople.map((a) => a.staff ? <PersonChip key={a.id} assignment={a} person={a.staff} alertLevels={alertLevels} dailyShifts={dailyShifts} onRemove={readOnly ? undefined : () => onRemoveAssignment(a.id)} /> : null)}
      {crnaPeople.map((a) => a.staff ? <PersonChip key={a.id} assignment={a} person={a.staff} alertLevels={alertLevels} dailyShifts={dailyShifts} onRemove={readOnly ? undefined : () => onRemoveAssignment(a.id)} /> : null)}

      {surgeon?.staff && (
        <span title={surgeon.staff.name} style={{ flexShrink: 0, fontSize: BT.font.chipSub, color: ROLE_META.surgeon.color, fontWeight: 600, marginLeft: 2, whiteSpace: 'nowrap', fontFamily: 'var(--font-sans)' }}>
          — {surgeon.staff.name.split(' ').pop()}
        </span>
      )}

      {people.length === 0 && (
        readOnly ? (
          <span style={{ fontSize: BT.font.chip, color: 'var(--text-dim)' }}>—</span>
        ) : (
          <span style={{ fontSize: BT.font.chip, color: isOver ? site.color : 'var(--text-dim)', fontStyle: isOver ? 'normal' : 'italic', fontWeight: isOver ? 700 : 400 }}>
            {isOver ? 'Release' : 'drop staff'}
          </span>
        )
      )}

      {/* Delete room — mirrors RoomCell's reveal-on-hover ✕ (same hov &&
          !dragging gate, same straight-through onDeleteRoom, no confirm).
          Absolutely positioned inside the row so the reveal never reflows
          row height, and inside the bounds because RoomCell's -8px corner
          offsets would clip against the multicol container's overflow.
          Suppressed entirely in read-only (wall) mode. */}
      {!readOnly && hov && !dragging && (
        <button onClick={onDeleteRoom} title={`Delete ${room.name}`} style={{ position: 'absolute', right: 3, top: '50%', transform: 'translateY(-50%)', width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, zIndex: 10, padding: 0 }}>×</button>
      )}
    </div>
  );
}
