'use client';

import { useMemo } from 'react';
import { Site, Assignment, StaffMember, MDDesignation, ShiftHours, DraggedPerson, Hospital } from '@/types';

/* ── Spec constants ───────────────────────────────────────────────────────── */

const TEAM_COLORS = [
  '#1D9E75', // teal
  '#BA7517', // amber
  '#D85A30', // coral
  '#D4537E', // pink
  '#534AB7', // purple
  '#185FA5', // blue
  '#3B6D11', // green
  '#A32D2D', // red
];

const MD_W = 100, MD_H = 38;
const CRNA_W = 120, CRNA_H = 30;
const ROOM_W = 100, ROOM_H = 38;

const COL_GAP = 130;
const ROW_GAP = 8;
const SITE_HEADER_H = 22;
const PAD = 24;

const STROKE = 1.5;
const STROKE_OPACITY = 0.65;

const MD_BG = '#EEEDFE', MD_FG = '#3C3489', MD_BD = '#CECBF6', MD_STATUS = '#534AB7';
const CRNA_BG = '#E6F1FB', CRNA_FG = '#0C447C', CRNA_BD = '#B5D4F4';
const ROOM_BG = '#F1EFE8', ROOM_FG = '#2C2C2A', ROOM_SUR = '#5F5E5A';
const EMPTY_ROOM_BD = '#888780';
const SITE_LABEL = '#6B6B65';

const FELLOW_BG = '#E5F8F4', FELLOW_FG = '#0F6F65', FELLOW_BD = '#B5E5DC';

/* ── Props (subset of LayoutV2Props that we actually use) ─────────────────── */

export interface NetworkProps {
  sites: Site[];                                    // all sites (need for facility filter)
  filteredSites: Site[];                            // already hospital-filtered, includes float
  assignments: Assignment[];
  roomAssignments: Record<string, Assignment[]>;
  hospital: Hospital | '';
  hospitalStaff: StaffMember[];
  designations: Record<string, MDDesignation>;
  dailyShifts: Record<string, ShiftHours>;
  dragging: DraggedPerson | null;
  dragOver: string | null;
  onDragOver: (id: string) => void;
  onDragLeave: () => void;
  onDrop: (roomId: string) => void;
  onRemoveAssignment: (id: string) => void;
}

/* ── Layout calculator ────────────────────────────────────────────────────── */

interface MDNode {
  id: string; name: string; status?: string; isFellow: boolean;
  x: number; y: number; teamColor: string;
}
interface CRNANode {
  id: string; name: string; shift?: string; mdId: string; roomId: string; assignmentId: string;
  x: number; y: number; teamColor: string;
}
interface RoomNode {
  id: string; name: string; surgeon?: string; siteId: string;
  x: number; y: number; mdId?: string; isEmpty: boolean;
}
interface SiteSection {
  id: string; name: string; y: number; height: number;
}

interface NetworkData {
  mds: MDNode[];
  crnas: CRNANode[];
  rooms: RoomNode[];
  siteSections: SiteSection[];
  width: number;
  height: number;
}

function lastName(full: string): string { return full.split(' ').pop() || full; }

function pickRoomTeam(people: Assignment[]) {
  const md      = people.find((a) => a.staff?.role === 'physician' || a.staff?.role === 'fellow');
  const crna    = people.find((a) => a.staff && ['crna','srna','resident'].includes(a.staff.role));
  const surgeon = people.find((a) => a.staff?.role === 'surgeon');
  return { md, crna, surgeon };
}

function computeLayout(p: NetworkProps): NetworkData {
  // Sites for the chosen facility (exclude float).
  const sites = p.filteredSites.filter((s) => !s.is_float);

  // Build the flat list of room teams (one per actual room).
  type RoomEntry = {
    site: Site; roomId: string; roomName: string;
    md?: Assignment; crna?: Assignment; surgeon?: Assignment;
  };
  const roomEntries: RoomEntry[] = [];
  for (const site of sites) {
    for (const room of site.rooms) {
      const team = pickRoomTeam(p.roomAssignments[room.id] || []);
      roomEntries.push({ site, roomId: room.id, roomName: room.name, ...team });
    }
  }

  // MDs: distinct physicians/fellows currently assigned somewhere in this facility.
  const mdIdToRoomEntries = new Map<string, RoomEntry[]>();
  for (const e of roomEntries) {
    if (!e.md?.staff) continue;
    const id = e.md.staff.id;
    if (!mdIdToRoomEntries.has(id)) mdIdToRoomEntries.set(id, []);
    mdIdToRoomEntries.get(id)!.push(e);
  }
  const mdIds = [...mdIdToRoomEntries.keys()].sort((a, b) => {
    const sa = p.hospitalStaff.find((s) => s.id === a)?.name || '';
    const sb = p.hospitalStaff.find((s) => s.id === b)?.name || '';
    return lastName(sa).localeCompare(lastName(sb));
  });

  // Assign team color per MD (cycle).
  const mdColorMap = new Map<string, string>();
  mdIds.forEach((id, i) => mdColorMap.set(id, TEAM_COLORS[i % TEAM_COLORS.length]));

  // ROOM column layout — group by site, with header per site.
  const roomCol_x = PAD + (MD_W + COL_GAP) + (CRNA_W + COL_GAP);
  const siteSections: SiteSection[] = [];
  const rooms: RoomNode[] = [];
  let cursorY = PAD;
  for (const site of sites) {
    const sectionStart = cursorY;
    cursorY += SITE_HEADER_H;
    for (const room of site.rooms) {
      const entry = roomEntries.find((e) => e.roomId === room.id);
      rooms.push({
        id: room.id,
        name: room.name,
        surgeon: entry?.surgeon?.staff?.name ? lastName(entry.surgeon.staff.name) : undefined,
        siteId: site.id,
        x: roomCol_x,
        y: cursorY,
        mdId: entry?.md?.staff?.id,
        isEmpty: !entry?.md && !entry?.crna,
      });
      cursorY += ROOM_H + ROW_GAP;
    }
    cursorY += 8; // gap between site sections
    siteSections.push({ id: site.id, name: site.name, y: sectionStart, height: cursorY - sectionStart });
  }
  const roomColEndY = cursorY;

  // MD column layout — distribute evenly along the room column's vertical extent.
  const mdCol_x = PAD;
  const mds: MDNode[] = mdIds.map((id, i) => {
    const staff = p.hospitalStaff.find((s) => s.id === id)!;
    const totalH = roomColEndY - PAD;
    const step = mdIds.length > 1 ? (totalH - MD_H) / (mdIds.length - 1) : 0;
    return {
      id,
      name: lastName(staff.name),
      status: p.designations[id],
      isFellow: staff.role === 'fellow',
      x: mdCol_x,
      y: PAD + i * step,
      teamColor: mdColorMap.get(id)!,
    };
  });

  // CRNA column layout — Y averages MD's Y and room's Y so lines look natural.
  const crnaCol_x = PAD + MD_W + COL_GAP;
  const crnas: CRNANode[] = [];
  for (const e of roomEntries) {
    if (!e.crna?.staff) continue;
    const mdId = e.md?.staff?.id;
    if (!mdId) continue; // skip orphan CRNAs (no MD in same room) for first pass
    const mdNode = mds.find((m) => m.id === mdId);
    const roomNode = rooms.find((r) => r.id === e.roomId);
    if (!mdNode || !roomNode) continue;
    const yMD = mdNode.y + MD_H / 2;
    const yRoom = roomNode.y + ROOM_H / 2;
    const yMid = (yMD + yRoom) / 2 - CRNA_H / 2;
    crnas.push({
      id: e.crna.staff.id,
      assignmentId: e.crna.id,
      name: lastName(e.crna.staff.name),
      shift: e.crna.staff.role !== 'physician' ? (p.dailyShifts[e.crna.staff.id] || e.crna.staff.hours) : undefined,
      mdId,
      roomId: e.roomId,
      x: crnaCol_x,
      y: yMid,
      teamColor: mdColorMap.get(mdId)!,
    });
  }

  // De-clutter: when several CRNAs end up at near-identical Y, fan them apart.
  // Group CRNAs by MD, sort by Y, then enforce min spacing.
  const byMd = new Map<string, CRNANode[]>();
  for (const c of crnas) {
    if (!byMd.has(c.mdId)) byMd.set(c.mdId, []);
    byMd.get(c.mdId)!.push(c);
  }
  for (const list of byMd.values()) {
    list.sort((a, b) => a.y - b.y);
    for (let i = 1; i < list.length; i++) {
      const minY = list[i - 1].y + CRNA_H + 4;
      if (list[i].y < minY) list[i].y = minY;
    }
  }

  const width = roomCol_x + ROOM_W + PAD;
  const height = Math.max(roomColEndY + PAD, mds.length ? mds[mds.length - 1].y + MD_H + PAD : PAD);

  return { mds, crnas, rooms, siteSections, width, height };
}

/* ── SVG rendering ───────────────────────────────────────────────────────── */

function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const cx1 = x1 + (x2 - x1) * 0.5;
  const cx2 = x1 + (x2 - x1) * 0.5;
  return `M ${x1},${y1} C ${cx1},${y1} ${cx2},${y2} ${x2},${y2}`;
}

export default function NetworkView(p: NetworkProps) {
  // Hooks must run unconditionally — early return below guards rendering only.
  const data = useMemo(() => computeLayout(p), [p.hospital, p.filteredSites, p.roomAssignments, p.hospitalStaff, p.designations, p.dailyShifts]);

  if (!p.hospital) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Network mode shows one facility at a time.</div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Pick a facility from the top bar to render its network.</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
      <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-surface)', border: '0.5px solid var(--border)', borderRadius: 4 }}>
        <svg width={data.width} height={data.height} style={{ display: 'block' }}>
          {/* Site section dividers */}
          {data.siteSections.map((s) => (
            <g key={s.id}>
              <text x={data.width - PAD - ROOM_W} y={s.y + 14} fontSize={10} fontFamily="var(--font-mono), ui-monospace, monospace" fill={SITE_LABEL} textAnchor="start" letterSpacing={0.5}>
                {s.name.toUpperCase()}
              </text>
              <line x1={data.width - PAD - ROOM_W} x2={data.width - PAD} y1={s.y + 18} y2={s.y + 18} stroke={SITE_LABEL} strokeWidth={0.5} opacity={0.4} />
            </g>
          ))}

          {/* Lines first so nodes paint over them */}
          {data.crnas.map((c) => {
            const md = data.mds.find((m) => m.id === c.mdId);
            const room = data.rooms.find((r) => r.id === c.roomId);
            if (!md || !room) return null;
            const mdRight = { x: md.x + MD_W, y: md.y + MD_H / 2 };
            const crnaLeft = { x: c.x, y: c.y + CRNA_H / 2 };
            const crnaRight = { x: c.x + CRNA_W, y: c.y + CRNA_H / 2 };
            const roomLeft = { x: room.x, y: room.y + ROOM_H / 2 };
            return (
              <g key={c.id} stroke={c.teamColor} strokeWidth={STROKE} opacity={STROKE_OPACITY} fill="none">
                <path d={bezier(mdRight.x, mdRight.y, crnaLeft.x, crnaLeft.y)} />
                <path d={bezier(crnaRight.x, crnaRight.y, roomLeft.x, roomLeft.y)} />
              </g>
            );
          })}

          {/* Solo-MD lines: MD → Room when no CRNA */}
          {data.rooms.filter((r) => r.mdId && !data.crnas.some((c) => c.roomId === r.id)).map((r) => {
            const md = data.mds.find((m) => m.id === r.mdId);
            if (!md) return null;
            const x1 = md.x + MD_W, y1 = md.y + MD_H / 2;
            const x2 = r.x, y2 = r.y + ROOM_H / 2;
            return <path key={'solo-' + r.id} d={bezier(x1, y1, x2, y2)} stroke={md.teamColor} strokeWidth={STROKE} opacity={STROKE_OPACITY} fill="none" />;
          })}

          {/* MD nodes */}
          {data.mds.map((m) => (
            <g key={m.id} transform={`translate(${m.x},${m.y})`}>
              <rect width={MD_W} height={MD_H} rx={5} fill={m.isFellow ? FELLOW_BG : MD_BG} stroke={m.isFellow ? FELLOW_BD : MD_BD} strokeWidth={0.5} />
              <text x={MD_W / 2} y={15} textAnchor="middle" fontSize={11} fontWeight={500} fill={m.isFellow ? FELLOW_FG : MD_FG}>
                {m.name}{m.isFellow ? ' fel' : ''}
              </text>
              {m.status && (
                <text x={MD_W / 2} y={29} textAnchor="middle" fontSize={10} fontFamily="var(--font-mono), ui-monospace, monospace" fill={m.isFellow ? FELLOW_FG : MD_STATUS}>
                  {m.status}
                </text>
              )}
              {/* Team color swatch on the left edge */}
              <rect x={0} y={0} width={3} height={MD_H} fill={m.teamColor} />
            </g>
          ))}

          {/* CRNA nodes */}
          {data.crnas.map((c) => (
            <g key={c.assignmentId} transform={`translate(${c.x},${c.y})`}>
              <rect width={CRNA_W} height={CRNA_H} rx={4} fill={CRNA_BG} stroke={CRNA_BD} strokeWidth={0.5} />
              <text x={CRNA_W / 2} y={CRNA_H / 2 + 3} textAnchor="middle" fontSize={11} fill={CRNA_FG}>
                {c.name}
                {c.shift && <tspan fontFamily="var(--font-mono), ui-monospace, monospace" fill={CRNA_FG} opacity={0.7} dx={4}>· {c.shift.replace('hr', 'h')}</tspan>}
              </text>
            </g>
          ))}

          {/* Room nodes — drag/drop targets */}
          {data.rooms.map((r) => {
            const isOver = p.dragOver === r.id;
            return (
              <g
                key={r.id}
                transform={`translate(${r.x},${r.y})`}
                onDragOver={(e) => { e.preventDefault(); p.onDragOver(r.id); }}
                onDragLeave={p.onDragLeave}
                onDrop={(e) => { e.preventDefault(); p.onDrop(r.id); }}
                style={{ cursor: 'pointer' }}
              >
                <rect
                  width={ROOM_W} height={ROOM_H} rx={4}
                  fill={r.isEmpty ? 'transparent' : ROOM_BG}
                  stroke={isOver ? MD_STATUS : (r.isEmpty ? EMPTY_ROOM_BD : ROOM_BG)}
                  strokeWidth={isOver ? 1.5 : 0.5}
                  strokeDasharray={r.isEmpty ? '3,2' : undefined}
                />
                <text x={ROOM_W / 2} y={r.surgeon ? 15 : ROOM_H / 2 + 3} textAnchor="middle" fontSize={11} fontFamily="var(--font-mono), ui-monospace, monospace" fontWeight={600} fill={r.isEmpty ? EMPTY_ROOM_BD : ROOM_FG}>
                  {r.name}
                </text>
                {r.surgeon && (
                  <text x={ROOM_W / 2} y={29} textAnchor="middle" fontSize={10} fill={ROOM_SUR}>
                    {r.surgeon}
                  </text>
                )}
              </g>
            );
          })}

          {/* Column captions */}
          <text x={PAD + MD_W / 2}                                  y={PAD - 6} textAnchor="middle" fontSize={9} fontFamily="var(--font-mono), ui-monospace, monospace" fill={SITE_LABEL} letterSpacing={0.5}>ANESTHESIOLOGISTS</text>
          <text x={PAD + MD_W + COL_GAP + CRNA_W / 2}               y={PAD - 6} textAnchor="middle" fontSize={9} fontFamily="var(--font-mono), ui-monospace, monospace" fill={SITE_LABEL} letterSpacing={0.5}>CRNAs</text>
          <text x={PAD + MD_W + COL_GAP + CRNA_W + COL_GAP + ROOM_W / 2} y={PAD - 6} textAnchor="middle" fontSize={9} fontFamily="var(--font-mono), ui-monospace, monospace" fill={SITE_LABEL} letterSpacing={0.5}>ROOMS</text>
        </svg>
      </div>

      <Legend mds={data.mds} />
    </div>
  );
}

function Legend({ mds }: { mds: MDNode[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 10px', borderTop: '0.5px solid var(--border)', background: 'var(--bg-surface)', flexShrink: 0, flexWrap: 'wrap', fontSize: 10 }}>
      <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Teams</span>
      {mds.map((m) => (
        <span key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 14, height: 2, background: m.teamColor, borderRadius: 1 }} />
          <span style={{ fontSize: 10, color: 'var(--text)' }}>{m.name}</span>
        </span>
      ))}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
        <span style={{ width: 14, height: 8, border: `0.5px dashed ${EMPTY_ROOM_BD}`, borderRadius: 2 }} />
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>empty room</span>
      </span>
    </div>
  );
}
