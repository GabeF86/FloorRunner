// Board assistant tools (Task 4: reads). Definitions + executors over the
// public-schema BOARD tables (staff, daily_active, sites/rooms, assignments,
// daily_designations, daily_shifts, breaks, relief_log). Executors are built by
// createBoardExecutors(sb, ctx) — they close over the server client and the
// per-request BoardCtx and expose the loop's (input) => {result, summary?}
// signature (assistantCore/loop.ts). Supervision/out-order logic is the SAME
// module the board screen uses (@/lib/boardLogic) so the two can never disagree.
//
// Mutations arrive in Task 5; MUTATING_BOARD_TOOLS is intentionally empty here.
import { z } from 'zod';
import { computeSupervisionLoads } from '@/lib/boardLogic';
import {
  DESIGNATION_OUT_ORDER,
  type Assignment,
  type StaffMember,
  type Site,
  type DailyDesignation,
  type DailyShift,
  type Break,
  type ReliefEntry,
} from '@/types';
import type { AssistantToolDef } from '@/lib/assistantCore/client';
import type { LoopToolOutcome } from '@/lib/assistantCore/loop';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BoardClient = any;

// ── Context (resolved once per request from the POST body) ────────────────────

export interface BoardCtx {
  boardDate: string;
  // null / '' = "All hospitals" (the board's All facility pill).
  hospital: string | null;
}

// Invalid model-supplied tool input → surfaced to the model verbatim as an
// is_error tool_result so it self-corrects (loop.ts keys off name ===
// 'ToolInputError'). Defined locally per the domain-isolation rule — NOT
// imported from scheduleAssistant/mutations.ts.
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

// ── Tool definitions (strict — small schemas, well under the grammar limits) ──

export const boardTools: AssistantToolDef[] = [
  {
    name: 'get_board',
    description:
      'Read the full board for the working date: staff (with working-today flags), sites and rooms, room assignments, MD designations, shift hours, breaks, relief log, supervision loads (limits: 4 CRNA/SRNA rooms, 2 resident rooms per MD), and the out-order. Call this before giving advice or when you need current state.',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  },
  {
    name: 'find_staff',
    description:
      'Fuzzy-search the staff list by spoken name or initials (scoped to the current hospital). Returns ALL plausible candidates with roles and working flags. If zero or more than one candidate plausibly matches what the user said, ASK the user — never guess, never create people.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string' },
        role: { type: 'string', enum: ['physician', 'crna', 'srna', 'resident', 'surgeon'] },
      },
    },
  },
];

// No board mutations yet (Task 5 adds them). The loop only snapshots/records
// changes for names in this set, so an empty set = every board tool is read-only.
export const MUTATING_BOARD_TOOLS: ReadonlySet<string> = new Set<string>();

// ── Hospital scoping (mirrors BoardClient's filters exactly) ──────────────────
// Staff (looser): hospital match OR null-hospital — unassigned staff show in
//   every hospital's roster (BoardClient: `p.hospital === hospital || !p.hospital`).
// Sites (stricter): hospital match OR is_float — a null-hospital non-float site
//   is NOT shown when a hospital is selected (BoardClient: `s.is_float ||
//   s.hospital === hospital`).
// Empty / null ctx.hospital = "All" — no filtering.
function scopeAllHospitals(ctx: BoardCtx): boolean {
  return ctx.hospital == null || ctx.hospital === '';
}
function staffInScope(ctx: BoardCtx, h?: string | null): boolean {
  return scopeAllHospitals(ctx) || h === ctx.hospital || !h;
}
function siteInScope(ctx: BoardCtx, site: Site): boolean {
  return scopeAllHospitals(ctx) || !!site.is_float || site.hospital === ctx.hospital;
}

// ── Fuzzy staff matcher (dependency-free) ─────────────────────────────────────
// exact/equal > exact-prefix (full name, any name word, or initials) > substring
// > loose subsequence (tolerates dropped letters — the common speech-to-text
// error). Case-insensitive; whitespace collapsed. Returns null for no match.
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
function isSubsequence(needle: string, hay: string): boolean {
  if (!needle) return false;
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}
export function scoreStaffMatch(query: string, name: string, initials: string): number | null {
  const q = norm(query);
  if (!q) return null;
  const n = norm(name);
  const ini = norm(initials);
  if (n === q || ini === q) return 100;
  if (n.startsWith(q) || ini.startsWith(q) || n.split(' ').some((w) => w.startsWith(q))) return 80;
  if (n.includes(q) || ini.includes(q)) return 60;
  if (isSubsequence(q.replace(/\s+/g, ''), n.replace(/\s+/g, ''))) return 40;
  return null;
}

// ── Shared reads ──────────────────────────────────────────────────────────────

async function loadStaffAndActive(
  sb: BoardClient,
  ctx: BoardCtx,
): Promise<{ staff: StaffMember[]; workingIds: Set<string> }> {
  const [staffRes, activeRes] = await Promise.all([
    sb.from('staff').select('*').order('role').order('name'),
    sb.from('daily_active').select('*').eq('board_date', ctx.boardDate),
  ]);
  if (staffRes.error) throw new Error(`staff read failed: ${staffRes.error.message}`);
  if (activeRes.error) throw new Error(`daily_active read failed: ${activeRes.error.message}`);
  const staff = ((staffRes.data ?? []) as StaffMember[]).filter((s) => staffInScope(ctx, s.hospital));
  const workingIds = new Set(
    ((activeRes.data ?? []) as Array<{ staff_id: string }>).map((r) => r.staff_id),
  );
  return { staff, workingIds };
}

// ── Executors ─────────────────────────────────────────────────────────────────

const FindStaffInput = z
  .object({
    query: z.string().min(1, 'query must be a non-empty name or initials'),
    role: z.enum(['physician', 'crna', 'srna', 'resident', 'surgeon']).optional(),
  })
  .strict();

export function createBoardExecutors(
  sb: BoardClient,
  ctx: BoardCtx,
): Record<string, (input: unknown) => Promise<LoopToolOutcome>> {
  return {
    async get_board(): Promise<LoopToolOutcome> {
      const date = ctx.boardDate;
      const [staffRes, activeRes, sitesRes, assignRes, desgRes, shiftRes, breakRes, reliefRes] =
        await Promise.all([
          sb.from('staff').select('*').order('role').order('name'),
          sb.from('daily_active').select('*').eq('board_date', date),
          sb.from('sites').select('*, rooms(*)').order('position'),
          sb.from('assignments').select('*, staff(*)').eq('board_date', date),
          sb.from('daily_designations').select('*').eq('board_date', date),
          sb.from('daily_shifts').select('*').eq('board_date', date),
          sb.from('breaks').select('*').eq('board_date', date),
          sb.from('relief_log').select('*').eq('board_date', date).order('relieved_at'),
        ]);

      // A failed read must surface as a tool error — presenting empties as fact
      // would have the model advise from a fake-clean board.
      const readErr = [staffRes, activeRes, sitesRes, assignRes, desgRes, shiftRes, breakRes, reliefRes]
        .map((r) => (r as { error?: { message: string } | null }).error?.message)
        .find(Boolean);
      if (readErr) throw new Error(`board read failed: ${readErr}`);

      const allStaff = (staffRes.data ?? []) as StaffMember[];
      const staffScoped = allStaff.filter((s) => staffInScope(ctx, s.hospital));
      const workingIds = new Set(
        ((activeRes.data ?? []) as Array<{ staff_id: string }>).map((r) => r.staff_id),
      );
      const sitesScoped = ((sitesRes.data ?? []) as Site[]).filter((s) => siteInScope(ctx, s));
      const assignments = (assignRes.data ?? []) as Assignment[];
      const designations = (desgRes.data ?? []) as DailyDesignation[];
      const shifts = (shiftRes.data ?? []) as DailyShift[];
      const breaks = (breakRes.data ?? []) as Break[];
      const relief = (reliefRes.data ?? []) as ReliefEntry[];

      // Supervision loads over the FULL unscoped assignments array — deliberate
      // asymmetry with the hospital-scoped assignments facet below. This is
      // exactly what BoardClient does (BoardClient.tsx:445: it feeds the whole
      // date's assignments to computeSupervisionLoads before any hospital
      // slicing), so screen and assistant report identical loads.
      const roomAssignments: Record<string, Assignment[]> = {};
      for (const a of assignments) (roomAssignments[a.room_id] ??= []).push(a);
      const supervisionLoads = computeSupervisionLoads(assignments, roomAssignments);

      // Assignments facet: scoped to rooms of in-scope sites so the model never
      // sees rows referencing rooms absent from `sites` (dangling context).
      // Float assignments store the SITE id as room_id (BoardClient
      // handleDropFloat posts room_id: siteId; floatAssignments filters on it),
      // so float site ids count as in-scope "rooms" too.
      const scopedRoomIds = new Set<string>();
      for (const s of sitesScoped) {
        if (s.is_float) scopedRoomIds.add(s.id);
        for (const rm of s.rooms ?? []) scopedRoomIds.add(rm.id);
      }
      const assignmentsScoped = assignments.filter((a) => scopedRoomIds.has(a.room_id));

      // Out-order — mirrors the EFFECTIVE UI pipeline, not OutListPanel in
      // isolation. BoardClient composes the panel's staff prop at
      // BoardClient.tsx:431-433 (mounted at :682):
      //   relievedIds  ← the date's reliefLog                    (:431)
      //   hospitalStaff ← hospital match OR null-hospital        (:432)
      //   activeStaff  ← hospitalStaff MINUS relieved            (:433)
      // — there is NO daily_active/working filter in that pipeline. The panel
      // then lists designated physicians by DESIGNATION_OUT_ORDER (D1…D9,
      // 3pm/5pm/7pm, C2; C1/C3 overnight and 8hr/10hr never enter the day
      // out-order) followed by ALL undesignated physicians it received. The
      // `working` flag is carried per row so the model can weigh it, but it
      // never filters membership (UI parity).
      const relievedIds = new Set(relief.map((r) => r.staff_id));
      const desgByStaff = new Map(designations.map((d) => [d.staff_id, d.designation]));
      const physicians = staffScoped.filter(
        (s) => s.role === 'physician' && !relievedIds.has(s.id),
      );
      const outOrder: Array<{
        staff_id: string; name: string; initials: string;
        designation: string | null; working: boolean;
      }> = [];
      for (const d of DESIGNATION_OUT_ORDER) {
        const p = physicians.find((ph) => desgByStaff.get(ph.id) === d);
        if (p) outOrder.push({ staff_id: p.id, name: p.name, initials: p.initials, designation: d, working: workingIds.has(p.id) });
      }
      for (const p of physicians) {
        if (!desgByStaff.has(p.id)) {
          outOrder.push({ staff_id: p.id, name: p.name, initials: p.initials, designation: null, working: workingIds.has(p.id) });
        }
      }

      return {
        result: {
          boardDate: date,
          hospital: scopeAllHospitals(ctx) ? null : ctx.hospital,
          currentTime: new Date().toISOString(),
          staff: staffScoped.map((s) => ({
            id: s.id, name: s.name, initials: s.initials, role: s.role,
            hours: s.hours, hospital: s.hospital ?? null, working: workingIds.has(s.id),
          })),
          sites: sitesScoped.map((s) => ({
            id: s.id, name: s.name, is_float: !!s.is_float, hospital: s.hospital ?? null,
            rooms: (s.rooms ?? []).map((rm) => ({ id: rm.id, name: rm.name, position: rm.position })),
          })),
          assignments: assignmentsScoped.map((a) => ({
            id: a.id, room_id: a.room_id, staff_id: a.staff_id,
            staff_name: a.staff?.name ?? null, staff_role: a.staff?.role ?? null,
            staff_initials: a.staff?.initials ?? null,
          })),
          designations: designations.map((d) => ({ staff_id: d.staff_id, designation: d.designation })),
          shifts: shifts.map((s) => ({ staff_id: s.staff_id, hours: s.hours })),
          breaks: breaks.map((b) => ({
            staff_id: b.staff_id, break_type: b.break_type, taken: b.taken, taken_at: b.taken_at ?? null,
          })),
          reliefLog: relief.map((r) => ({
            id: r.id, staff_id: r.staff_id, staff_name: r.staff_name, staff_role: r.staff_role,
            staff_initials: r.staff_initials, relieved_at: r.relieved_at,
            designation: r.designation ?? null, shift_hours: r.shift_hours ?? null,
          })),
          supervisionLoads,
          outOrder,
        },
      };
    },

    async find_staff(input: unknown): Promise<LoopToolOutcome> {
      const parsed = FindStaffInput.safeParse(input);
      if (!parsed.success) {
        throw new ToolInputError(
          `Invalid find_staff input — ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      const { query, role } = parsed.data;
      const { staff, workingIds } = await loadStaffAndActive(sb, ctx);

      const pool = role ? staff.filter((s) => s.role === role) : staff;
      const candidates = pool
        .map((s) => ({ s, score: scoreStaffMatch(query, s.name, s.initials) }))
        .filter((x): x is { s: StaffMember; score: number } => x.score !== null)
        .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
        .map((x) => ({
          id: x.s.id, name: x.s.name, initials: x.s.initials, role: x.s.role,
          hospital: x.s.hospital ?? null, working: workingIds.has(x.s.id), match_score: x.score,
        }));

      return {
        result: { query, role: role ?? null, count: candidates.length, candidates },
      };
    },
  };
}
