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
  MD_DESIGNATIONS,
  HOUR_OPTIONS,
  type Assignment,
  type StaffMember,
  type Site,
  type Role,
  type MDDesignation,
  type ShiftHours,
  type DailyDesignation,
  type DailyShift,
  type Break,
  type ReliefEntry,
} from '@/types';
import type { AssistantToolDef } from '@/lib/assistantCore/client';
import type { LoopToolOutcome } from '@/lib/assistantCore/loop';
// recordReliefInsert lives in ./snapshot, which imports the scope helpers back
// from here — a benign import cycle: every binding is used lazily (inside
// function bodies, never at module init), so ESM live-bindings resolve fine.
import { recordReliefInsert } from './snapshot';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BoardClient = any;

// ── Context (resolved once per request from the POST body) ────────────────────

export interface BoardCtx {
  boardDate: string;
  // null / '' = "All hospitals" (the board's All facility pill).
  hospital: string | null;
}

// Shared handle for the turn's open snapshot id. This is a NEW pattern with no
// scheduling-side counterpart (the schedule executors never need the action id —
// their revert restores the whole version): runAssistantLoop keeps actionId
// private and never passes it to executors, so the board adapter's takeSnapshot
// closure stashes the id here and executors that need it (mark_relieved, to
// record the relief_log row it creates) read actionRef.actionId at execution
// time. Sound because runAssistantLoop awaits takeSnapshot BEFORE any mutating
// executor of the run executes (assistantCore/loop.ts), so the ref is populated
// first.
export interface BoardActionRef {
  actionId: string | null;
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
      'Fuzzy-search the staff list by spoken name or initials (scoped to the current hospital). Returns ALL plausible candidates with roles, working flags, and a match_score (higher = closer match). If zero or more than one candidate plausibly matches what the user said, ASK the user — never guess, never create people.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string' },
        role: { type: 'string', enum: ['physician', 'fellow', 'crna', 'srna', 'resident', 'surgeon'] },
      },
    },
  },
  {
    name: 'set_working',
    description:
      "Set today's working roster in one batch: for each entry mark the staff member working (true) or off (false). Marking someone off also clears their room assignments for the date (same as unchecking their sidebar box). Resolve every id with find_staff first.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['entries'],
      properties: {
        entries: {
          type: 'array',
          description: 'Roster changes to apply.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['staff_id', 'working'],
            properties: { staff_id: { type: 'string' }, working: { type: 'boolean' } },
          },
        },
      },
    },
  },
  {
    name: 'assign_to_room',
    description:
      "Assign a staff member to an operating room, resolved by room name within the current hospital (case-insensitive; spelled number words are normalized to digits, so 'room three' matches a room stored as 'OR 3'). Non-physicians move room-to-room (their prior room is cleared); physicians stack (they can supervise several rooms). Auto-adds the person to today's working roster if missing. If the room name is ambiguous or unknown, you get the candidate/available names back — ask the user, don't guess.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['staff_id', 'room'],
      properties: { staff_id: { type: 'string' }, room: { type: 'string' } },
    },
  },
  {
    name: 'send_to_float',
    description:
      "Assign a staff member to the float location (the day's floating/holding pool). Non-physicians' prior room is cleared; physicians stack.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['staff_id'],
      properties: { staff_id: { type: 'string' } },
    },
  },
  {
    name: 'unassign',
    description: "Clear all of a staff member's room assignments for the date (send them back to the roster).",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['staff_id'],
      properties: { staff_id: { type: 'string' } },
    },
  },
  {
    name: 'set_designation',
    description:
      "Set a PHYSICIAN's daily designation (D1–D9 day order, C1–C3 call, 3pm/5pm/7pm early-out, 8hr/10hr per-diem). Only physicians take designations — use set_shift_hours for CRNA/SRNA/resident/fellow hours.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['staff_id', 'designation'],
      properties: { staff_id: { type: 'string' }, designation: { type: 'string', enum: [...MD_DESIGNATIONS] } },
    },
  },
  {
    name: 'set_shift_hours',
    description:
      "Set today's shift length for a CRNA, SRNA, resident, or fellow. Physicians use set_designation instead; surgeons have no shift hours.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['staff_id', 'hours'],
      properties: { staff_id: { type: 'string' }, hours: { type: 'string', enum: [...HOUR_OPTIONS] } },
    },
  },
  {
    name: 'mark_break',
    description: "Mark a staff member's break (morning/lunch/afternoon) as taken (true) or not-yet-taken (false).",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['staff_id', 'break_type', 'taken'],
      properties: {
        staff_id: { type: 'string' },
        break_type: { type: 'string', enum: ['morning', 'lunch', 'afternoon'] },
        taken: { type: 'boolean' },
      },
    },
  },
  {
    name: 'mark_relieved',
    description:
      "Relieve a staff member — record that they went home. Clears their room assignments and logs the relief (with their designation and shift at time of relief). Removes them from the out-order.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['staff_id'],
      properties: { staff_id: { type: 'string' } },
    },
  },
];

// The loop snapshots the day (Task 6) before the FIRST tool in this set runs and
// collects each one's summary as a change chip. Read tools (get_board,
// find_staff) stay OUT so a pure advice turn never triggers a snapshot.
export const MUTATING_BOARD_TOOLS: ReadonlySet<string> = new Set<string>([
  'set_working',
  'assign_to_room',
  'send_to_float',
  'unassign',
  'set_designation',
  'set_shift_hours',
  'mark_break',
  'mark_relieved',
]);

// ── Hospital scoping (mirrors BoardClient's filters exactly) ──────────────────
// Staff (looser): hospital match OR null-hospital — unassigned staff show in
//   every hospital's roster (BoardClient: `p.hospital === hospital || !p.hospital`).
// Sites (stricter): hospital match OR is_float — a null-hospital non-float site
//   is NOT shown when a hospital is selected (BoardClient: `s.is_float ||
//   s.hospital === hospital`).
// Empty / null ctx.hospital = "All" — no filtering.
// Exported so snapshot.ts scopes the same day rows the board screen shows
// (single source of truth for the hospital-scope semantics).
export function scopeAllHospitals(ctx: BoardCtx): boolean {
  return ctx.hospital == null || ctx.hospital === '';
}
export function staffInScope(ctx: BoardCtx, h?: string | null): boolean {
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
// Ordinal scores — only their relative order matters (exact > prefix >
// substring > subsequence); the raw value rides out as match_score so the
// model can gauge how confident a hit is.
const SCORE_EXACT = 100;
const SCORE_PREFIX = 80;
const SCORE_SUBSTRING = 60;
const SCORE_SUBSEQUENCE = 40;
export function scoreStaffMatch(query: string, name: string, initials: string): number | null {
  const q = norm(query);
  if (!q) return null;
  const n = norm(name);
  const ini = norm(initials);
  if (n === q || ini === q) return SCORE_EXACT;
  if (n.startsWith(q) || ini.startsWith(q) || n.split(' ').some((w) => w.startsWith(q))) return SCORE_PREFIX;
  if (n.includes(q) || ini.includes(q)) return SCORE_SUBSTRING;
  if (isSubsequence(q.replace(/\s+/g, ''), n.replace(/\s+/g, ''))) return SCORE_SUBSEQUENCE;
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
    role: z.enum(['physician', 'fellow', 'crna', 'srna', 'resident', 'surgeon']).optional(),
  })
  .strict();

// ── Mutation input schemas (strict, small — respect the API grammar budget) ────
const SetWorkingInput = z
  .object({
    entries: z
      .array(z.object({ staff_id: z.string().min(1), working: z.boolean() }).strict())
      .min(1, 'entries must contain at least one {staff_id, working}'),
  })
  .strict();
const AssignRoomInput = z
  .object({ staff_id: z.string().min(1), room: z.string().min(1, 'room name is required') })
  .strict();
const StaffIdInput = z.object({ staff_id: z.string().min(1) }).strict();
const SetDesignationInput = z
  .object({ staff_id: z.string().min(1), designation: z.enum(MD_DESIGNATIONS as [MDDesignation, ...MDDesignation[]]) })
  .strict();
const SetShiftHoursInput = z
  .object({ staff_id: z.string().min(1), hours: z.enum(HOUR_OPTIONS as unknown as [ShiftHours, ...ShiftHours[]]) })
  .strict();
const MarkBreakInput = z
  .object({ staff_id: z.string().min(1), break_type: z.enum(['morning', 'lunch', 'afternoon']), taken: z.boolean() })
  .strict();

function parseInput<T>(schema: z.ZodType<T>, input: unknown, tool: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ToolInputError(
      `Invalid ${tool} input — ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

// Which roles the Sidebar offers each picker to (mirrored EXACTLY from
// Sidebar.tsx: the designation dropdown opens only for `isPhys`, the shift
// dropdown for `!isPhys && !isSurgeon`). Fellows therefore take a shift, NOT a
// designation — enforced here so the assistant can't write a state the UI can't.
const DESIGNATION_ROLES: ReadonlySet<Role> = new Set<Role>(['physician']);
const SHIFT_HOURS_ROLES: ReadonlySet<Role> = new Set<Role>(['fellow', 'crna', 'srna', 'resident']);

// ── Mutation helpers ──────────────────────────────────────────────────────────

// Read the whole (small) staff table; in production the id filter narrows it,
// in the fake it returns everything and we find in-memory — either way robust.
async function fetchStaffById(sb: BoardClient, staffId: string): Promise<StaffMember> {
  const { data, error } = await sb.from('staff').select('*').eq('id', staffId);
  if (error) throw new Error(`staff read failed: ${error.message}`);
  const row = ((data ?? []) as StaffMember[]).find((s) => s.id === staffId);
  if (!row) {
    throw new ToolInputError(
      `No staff member with id "${staffId}" — resolve the person with find_staff first; never invent ids.`,
    );
  }
  return row;
}

function displayName(s: StaffMember): string {
  return s.name;
}

// Assignment placement shared by assign_to_room and send_to_float — the exact
// POST /api/assignments code path: non-physicians clear prior same-date rows
// first (they move), physicians stack; then upsert on (staff_id,room_id,
// board_date). For float, roomId is the SITE id (BoardClient.handleDropFloat).
async function placeAssignment(sb: BoardClient, ctx: BoardCtx, staff: StaffMember, roomId: string): Promise<void> {
  if (staff.role !== 'physician') {
    // Non-atomic delete-then-upsert (no client-side txn) — the SAME two-step the
    // UI drag handler runs. Failure mode: if the upsert throws after the delete
    // lands, the person is left unassigned (not in the new room); the loop
    // surfaces the error and the turn snapshot makes it undoable.
    const { error: delErr } = await sb
      .from('assignments')
      .delete()
      .eq('staff_id', staff.id)
      .eq('board_date', ctx.boardDate);
    if (delErr) throw new Error(`assignment clear failed: ${delErr.message}`);
  }
  const { error } = await sb
    .from('assignments')
    .upsert(
      { room_id: roomId, staff_id: staff.id, board_date: ctx.boardDate },
      { onConflict: 'staff_id,room_id,board_date' },
    )
    .select('*, staff(*)')
    .single();
  if (error) throw new Error(`assignment write failed: ${error.message}`);
}

// ── Room-name normalization (voice-transcript hardening) ─────────────────────
// Speech-to-text renders numbers as words ("room three", "or one"), so room
// matching normalizes BOTH sides identically: norm() plus each standalone token
// that is a spelled number word (zero–twenty) mapped to its digit. Multi-word
// numbers ("twenty one") are NOT joined — the prompt tells the model to write
// the stored room name for anything the normalizer doesn't cover.
const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
};
function normRoomName(s: string): string {
  return norm(s)
    .split(' ')
    .map((t) => NUMBER_WORDS[t] ?? t)
    .join(' ');
}
// Trailing digit run of a normalized room string ("or 3" → "3"), or null.
function digitSuffix(normed: string): string | null {
  const m = normed.match(/(\d+)$/);
  return m ? m[1] : null;
}
// Generic "room" words a speaker prepends to a number without naming the room
// ("room three", "OR three") — allowed as fallback prefix tokens below.
const GENERIC_ROOM_WORDS = new Set(['room', 'or']);

// Resolve a spoken room name to a room id within the current hospital's sites.
// Two passes over normalized names (normRoomName on both sides):
//   1. normalized-exact — "or one" === "OR 1". An exact name always wins; the
//      fallback never overrides it. ≥2 exact matches → ambiguity error.
//   2. digit-suffix fallback — ONLY when pass 1 found nothing AND the query
//      ends in digits after normalization: rooms whose trailing digit run
//      EXACTLY equals the query's ("3" matches "OR 3", not "OR 13"/"OR 03"),
//      provided every query token before the digits is either one of the
//      room's own name tokens or a generic room word ("room"/"or") — so
//      "room three" finds "OR 3", but "BMH OR 1" never falls back onto a
//      different site's "OR 1".
// 0 matches → list the available room names; ≥2 → list the ambiguous candidates
// with their site names. Both are ToolInputErrors so the model asks the user.
function resolveRoom(sites: Site[], roomName: string): { roomId: string; roomName: string } {
  const q = normRoomName(roomName);
  const rooms: Array<{ roomId: string; roomName: string; siteName: string; normed: string }> = [];
  for (const s of sites) {
    for (const rm of s.rooms ?? []) {
      rooms.push({ roomId: rm.id, roomName: rm.name, siteName: s.name, normed: normRoomName(rm.name) });
    }
  }
  let matches = rooms.filter((r) => r.normed === q);
  if (matches.length === 0) {
    const suffix = digitSuffix(q);
    if (suffix !== null) {
      const prefixTokens = q.split(' ').slice(0, -1); // tokens before the digit run
      matches = rooms.filter((r) => {
        if (digitSuffix(r.normed) !== suffix) return false;
        const roomTokens = new Set(r.normed.split(' '));
        return prefixTokens.every((t) => roomTokens.has(t) || GENERIC_ROOM_WORDS.has(t));
      });
    }
  }
  if (matches.length === 0) {
    const avail = rooms.map((r) => r.roomName);
    throw new ToolInputError(
      `No room named "${roomName}" in this hospital. Available rooms: ${avail.join(', ') || '(none in scope)'}. Ask the user which room.`,
    );
  }
  if (matches.length > 1) {
    throw new ToolInputError(
      `Room "${roomName}" is ambiguous — it matches ${matches
        .map((m) => `${m.roomName} in ${m.siteName}`)
        .join('; ')}. Ask the user which one.`,
    );
  }
  return { roomId: matches[0].roomId, roomName: matches[0].roomName };
}

async function loadScopedSites(sb: BoardClient, ctx: BoardCtx): Promise<Site[]> {
  const { data, error } = await sb.from('sites').select('*, rooms(*)').order('position');
  if (error) throw new Error(`sites read failed: ${error.message}`);
  return ((data ?? []) as Site[]).filter((s) => siteInScope(ctx, s));
}

// Upsert the person into daily_active if they aren't already working today.
// Returns whether a row was added (so the summary can say so). Mirrors the
// daily_active POST upsert shape.
async function ensureWorking(sb: BoardClient, ctx: BoardCtx, staffId: string): Promise<boolean> {
  const { data, error } = await sb.from('daily_active').select('*').eq('board_date', ctx.boardDate);
  if (error) throw new Error(`daily_active read failed: ${error.message}`);
  const working = ((data ?? []) as Array<{ staff_id: string }>).some((r) => r.staff_id === staffId);
  if (working) return false;
  const { error: upErr } = await sb
    .from('daily_active')
    .upsert({ staff_id: staffId, board_date: ctx.boardDate }, { onConflict: 'staff_id,board_date' })
    .select()
    .single();
  if (upErr) throw new Error(`daily_active write failed: ${upErr.message}`);
  return true;
}

export function createBoardExecutors(
  sb: BoardClient,
  ctx: BoardCtx,
  // Optional: when the adapter (SSE route) wires an action ref, mark_relieved
  // records the relief_log row it creates into the open snapshot so revert can
  // delete it. Omitted in unit tests that don't exercise the undo path.
  actionRef?: BoardActionRef,
): Record<string, (input: unknown) => Promise<LoopToolOutcome>> {
  return {
    async get_board(): Promise<LoopToolOutcome> {
      // Result size: a department-day is bounded (~100 staff, dozens of rooms,
      // a handful of day-scoped rows per person), so no pagination here; the
      // loop's MAX_TOOL_RESULT_CHARS truncation is the backstop if a board
      // ever balloons.
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
      // BoardClient.tsx:432-434 (mounted at :683):
      //   relievedIds  ← the date's reliefLog                    (:432)
      //   hospitalStaff ← hospital match OR null-hospital        (:433)
      //   activeStaff  ← hospitalStaff MINUS relieved            (:434)
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
      const { query, role } = parseInput(FindStaffInput, input, 'find_staff');
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

    // ── Mutations ─────────────────────────────────────────────────────────────

    // daily_active batch. Validate EVERY id before any write (all-or-nothing) so
    // a bad id never leaves a half-applied roster. working=false also clears the
    // person's assignments for the date — toggleActive uncheck parity.
    async set_working(input: unknown): Promise<LoopToolOutcome> {
      const { entries } = parseInput(SetWorkingInput, input, 'set_working');
      const staffList = ((await sb.from('staff').select('*')).data ?? []) as StaffMember[];
      const byId = new Map(staffList.map((s) => [s.id, s]));
      for (const e of entries) {
        if (!byId.has(e.staff_id)) {
          throw new ToolInputError(
            `No staff member with id "${e.staff_id}" — resolve everyone with find_staff first; nothing was changed.`,
          );
        }
      }
      const on: string[] = [];
      const off: string[] = [];
      for (const e of entries) {
        const person = byId.get(e.staff_id)!;
        if (e.working) {
          const { error } = await sb
            .from('daily_active')
            .upsert({ staff_id: e.staff_id, board_date: ctx.boardDate }, { onConflict: 'staff_id,board_date' })
            .select()
            .single();
          if (error) throw new Error(`daily_active write failed: ${error.message}`);
          on.push(displayName(person));
        } else {
          const { error: delActive } = await sb
            .from('daily_active')
            .delete()
            .eq('staff_id', e.staff_id)
            .eq('board_date', ctx.boardDate);
          if (delActive) throw new Error(`daily_active delete failed: ${delActive.message}`);
          const { error: delAssign } = await sb
            .from('assignments')
            .delete()
            .eq('staff_id', e.staff_id)
            .eq('board_date', ctx.boardDate);
          if (delAssign) throw new Error(`assignment clear failed: ${delAssign.message}`);
          off.push(displayName(person));
        }
      }
      const summary =
        `Working: ${on.join(', ') || '—'}` + (off.length ? ` · Off: ${off.join(', ')}` : '');
      return { result: { working_on: on, working_off: off }, summary };
    },

    async assign_to_room(input: unknown): Promise<LoopToolOutcome> {
      const { staff_id, room } = parseInput(AssignRoomInput, input, 'assign_to_room');
      const staff = await fetchStaffById(sb, staff_id);
      const sites = await loadScopedSites(sb, ctx);
      const { roomId, roomName } = resolveRoom(sites, room);
      await placeAssignment(sb, ctx, staff, roomId);
      const added = await ensureWorking(sb, ctx, staff_id);
      const summary = `Assigned ${displayName(staff)} to ${roomName}` + (added ? ' (added to working list)' : '');
      return { result: { staff_id, room_id: roomId, room: roomName, added_to_working: added }, summary };
    },

    async send_to_float(input: unknown): Promise<LoopToolOutcome> {
      const { staff_id } = parseInput(StaffIdInput, input, 'send_to_float');
      const staff = await fetchStaffById(sb, staff_id);
      const sites = await loadScopedSites(sb, ctx);
      const floatSite = sites.find((s) => s.is_float);
      if (!floatSite) {
        throw new ToolInputError('No float location is configured for this hospital.');
      }
      // Float assignments store the SITE id in room_id (BoardClient.handleDropFloat).
      await placeAssignment(sb, ctx, staff, floatSite.id);
      const summary = `Sent ${displayName(staff)} to ${floatSite.name}`;
      return { result: { staff_id, room_id: floatSite.id, float_site: floatSite.name }, summary };
    },

    async unassign(input: unknown): Promise<LoopToolOutcome> {
      const { staff_id } = parseInput(StaffIdInput, input, 'unassign');
      const staff = await fetchStaffById(sb, staff_id);
      const { error } = await sb
        .from('assignments')
        .delete()
        .eq('staff_id', staff_id)
        .eq('board_date', ctx.boardDate);
      if (error) throw new Error(`assignment clear failed: ${error.message}`);
      return { result: { staff_id }, summary: `Unassigned ${displayName(staff)}` };
    },

    async set_designation(input: unknown): Promise<LoopToolOutcome> {
      const { staff_id, designation } = parseInput(SetDesignationInput, input, 'set_designation');
      const staff = await fetchStaffById(sb, staff_id);
      if (!DESIGNATION_ROLES.has(staff.role)) {
        throw new ToolInputError(
          `${displayName(staff)} is a ${staff.role} — only physicians take a designation. Use set_shift_hours for non-physician hours.`,
        );
      }
      const { error } = await sb
        .from('daily_designations')
        .upsert(
          { staff_id, board_date: ctx.boardDate, designation },
          { onConflict: 'staff_id,board_date' },
        )
        .select()
        .single();
      if (error) throw new Error(`designation write failed: ${error.message}`);
      return { result: { staff_id, designation }, summary: `Set ${displayName(staff)} → ${designation}` };
    },

    async set_shift_hours(input: unknown): Promise<LoopToolOutcome> {
      const { staff_id, hours } = parseInput(SetShiftHoursInput, input, 'set_shift_hours');
      const staff = await fetchStaffById(sb, staff_id);
      if (!SHIFT_HOURS_ROLES.has(staff.role)) {
        throw new ToolInputError(
          `${displayName(staff)} is a ${staff.role} — shift hours apply to CRNA/SRNA/resident/fellow only${
            staff.role === 'physician' ? ' (physicians take a designation)' : ''
          }.`,
        );
      }
      const { error } = await sb
        .from('daily_shifts')
        .upsert({ staff_id, board_date: ctx.boardDate, hours }, { onConflict: 'staff_id,board_date' })
        .select()
        .single();
      if (error) throw new Error(`shift write failed: ${error.message}`);
      return { result: { staff_id, hours }, summary: `Set ${displayName(staff)}'s shift → ${hours}` };
    },

    async mark_break(input: unknown): Promise<LoopToolOutcome> {
      const { staff_id, break_type, taken } = parseInput(MarkBreakInput, input, 'mark_break');
      const staff = await fetchStaffById(sb, staff_id);
      // taken_at stamped now when taken, else null — breaks route parity.
      const taken_at = taken ? new Date().toISOString() : null;
      const { error } = await sb
        .from('breaks')
        .upsert(
          { staff_id, board_date: ctx.boardDate, break_type, taken, taken_at },
          { onConflict: 'staff_id,board_date,break_type' },
        )
        .select()
        .single();
      if (error) throw new Error(`break write failed: ${error.message}`);
      const summary = `${displayName(staff)}: ${break_type} break ${taken ? 'taken' : 'cleared'}`;
      return { result: { staff_id, break_type, taken }, summary };
    },

    async mark_relieved(input: unknown): Promise<LoopToolOutcome> {
      const { staff_id } = parseInput(StaffIdInput, input, 'mark_relieved');
      const staff = await fetchStaffById(sb, staff_id);
      // Denormalize the person's CURRENT designation + shift at time of relief,
      // exactly like BoardClient.handleDropRelieved (dailyShifts override → base
      // hours; designations map, may be absent).
      const [shiftRes, desgRes] = await Promise.all([
        sb.from('daily_shifts').select('*').eq('board_date', ctx.boardDate),
        sb.from('daily_designations').select('*').eq('board_date', ctx.boardDate),
      ]);
      if (shiftRes.error) throw new Error(`daily_shifts read failed: ${shiftRes.error.message}`);
      if (desgRes.error) throw new Error(`daily_designations read failed: ${desgRes.error.message}`);
      const shiftRow = ((shiftRes.data ?? []) as DailyShift[]).find((s) => s.staff_id === staff_id);
      const desgRow = ((desgRes.data ?? []) as DailyDesignation[]).find((d) => d.staff_id === staff_id);
      const shift_hours: string = shiftRow?.hours ?? staff.hours;
      const designation: string | null = desgRow?.designation ?? null;

      // Non-atomic unassign-then-insert (no client-side txn) — the SAME two-step
      // BoardClient.handleDropRelieved runs on drag-to-relieved. Failure mode: if
      // the relief insert throws after the delete lands, the person is unassigned
      // but not logged as relieved; the loop surfaces the error and the turn
      // snapshot makes it undoable.
      const { error: delErr } = await sb
        .from('assignments')
        .delete()
        .eq('staff_id', staff_id)
        .eq('board_date', ctx.boardDate);
      if (delErr) throw new Error(`assignment clear failed: ${delErr.message}`);

      const { data: reliefRow, error: insErr } = await sb
        .from('relief_log')
        .insert({
          staff_id,
          staff_name: staff.name,
          staff_role: staff.role,
          staff_initials: staff.initials,
          board_date: ctx.boardDate,
          relieved_at: new Date().toISOString(),
          designation,
          shift_hours,
        })
        .select()
        .single();
      if (insErr) throw new Error(`relief write failed: ${insErr.message}`);
      // relief_log is append-only (not snapshotted wholesale) — record the new
      // row's id in the open snapshot so revert deletes exactly this entry.
      const newReliefId = (reliefRow as { id?: string } | null)?.id;
      if (actionRef?.actionId && newReliefId) {
        await recordReliefInsert(sb, actionRef.actionId, newReliefId);
      }
      const summary = `Relieved ${displayName(staff)} — went home`;
      return { result: { staff_id, designation, shift_hours }, summary };
    },
  };
}
