// D-assignment audit (Gabriel 2026-08-02: "re-check all the placements for
// correct D assignments after I make switches to peoples call ... if someone
// ends up having two D assignments, the lower one takes precedent ... I also
// want all the D4-D8 slots correctly ordered based on the nearest call shift").
//
// Two independent questions, deliberately kept apart because their fixes have
// very different blast radius:
//
//   SEQUENCE (D1-D3) — which day code a provider is OWED by the calls around
//   them. Derived from the site's CallPatternDoc, never from code literals:
//   weekendV2 says C2 → +1 D1, C1 → −1 D2, C2 → −1 D3, and every one of those
//   links is DAY-TYPE SCOPED. That scoping is what makes Gabriel's weekend
//   caveat ("on weekends it is possible for a C2 shift to occur the day after
//   a C1") fall out for free: this module never reasons "a C1 means rest
//   tomorrow", it only reads what the pattern actually declares for that day
//   type, so a weekend C1 → C2 → Monday-D1 sequence produces exactly the claim
//   the pattern states and nothing is mis-flagged.
//
//   LADDER (D4-D8) — the ORDER of the relief positions on one date. The rule
//   is the engine's own, quoted from solveKernel.rankByNextCall 'early-out':
//   "the FIRST relief position on a date (its holder leaves earliest, so
//   next-call adjacency is the clinical point of the code): soonest next call,
//   then that call's rank tier, then most-recently-called". A ladder fix is a
//   PERMUTATION — the same people work the same day, only their position
//   changes — which is why it is safe to offer as a bulk apply.
//
// TWO ORDERINGS, BOTH FROM DATA, no D-code literals anywhere:
//   • "lower D wins" is `display_order` ascending (D1=3 … D8=10 at Paoli).
//     Gabriel's rule generalises the standing one — a post-call D1 outranking a
//     pre-call D2/D3 (preFillEviction.ts, 2026-07-19) — and agrees with it
//     wherever both apply, since the post-call code sorts first.
//   • the ladder is exactly the codes carrying a `relief_rank`; the sequence
//     codes carry none. A site that renames its codes keeps working.

import { dayChainsFor, type CallPatternDoc } from './rulesEngine/callPattern';

export interface AuditShiftType {
  code: string;
  category: string;
  display_order?: number | null;
  relief_rank?: number | null;
  generation_engine?: string | null;
  parent_call_code?: string | null;
}

export interface AuditSlot {
  id: string;
  slot_date: string;
  derived_day_type?: string | null;
  locked?: boolean | null;
  shift_types: AuditShiftType | null;
  assignments?: ReadonlyArray<{ id?: string; provider_id?: string | null }> | null;
}

/** One thing to change. `providerId` null = vacate the slot. */
export interface DPlacement {
  slotId: string;
  providerId: string | null;
}

export type DFindingKind = 'wrong-sequence-code' | 'missing-sequence-code' | 'ladder-order';

export interface DFinding {
  kind: DFindingKind;
  date: string;
  /** Human-facing sentence; the UI renders this verbatim. */
  detail: string;
  /** Providers involved, for naming in the UI. */
  providerIds: string[];
  /** The writes that resolve it. Empty ⇒ reportable but not auto-fixable. */
  placements: DPlacement[];
}

const DAY = 86_400_000;
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

const isCall = (st: AuditShiftType | null) => st?.category === 'call';
/** Call-engine day slots — the D ladder + sequence. Day-pool codes (7-3/7-5)
 *  belong to another engine and are never touched. */
const isDaySlot = (st: AuditShiftType | null) =>
  !!st && st.category === 'regular' && (st.generation_engine ?? 'call') === 'call';
const isLadder = (st: AuditShiftType | null) => isDaySlot(st) && st!.relief_rank != null;
const isSequence = (st: AuditShiftType | null) => isDaySlot(st) && st!.relief_rank == null;
const order = (st: AuditShiftType | null) => st?.display_order ?? Number.MAX_SAFE_INTEGER;

const holderOf = (slot: AuditSlot): string | null =>
  (slot.assignments ?? []).find(a => a.provider_id)?.provider_id ?? null;

interface Indexed {
  byDate: Map<string, AuditSlot[]>;
  /** provider → sorted call dates with the code held. */
  callsByPid: Map<string, Array<{ date: string; code: string }>>;
}

function index(slots: readonly AuditSlot[]): Indexed {
  const byDate = new Map<string, AuditSlot[]>();
  const callsByPid = new Map<string, Array<{ date: string; code: string }>>();
  for (const s of slots) {
    const list = byDate.get(s.slot_date) ?? [];
    list.push(s);
    byDate.set(s.slot_date, list);
    if (!isCall(s.shift_types)) continue;
    const pid = holderOf(s);
    if (!pid) continue;
    const arr = callsByPid.get(pid) ?? [];
    arr.push({ date: s.slot_date, code: s.shift_types!.code });
    callsByPid.set(pid, arr);
  }
  for (const arr of callsByPid.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return { byDate, callsByPid };
}

/** Every day-code the pattern claims for a provider, keyed `pid|date`.
 *  A provider can collect more than one claim on a date — post-call from
 *  yesterday AND pre-call for tomorrow — which is precisely the case Gabriel's
 *  "lower one takes precedent" rule settles. */
function sequenceClaims(
  slots: readonly AuditSlot[], doc: CallPatternDoc, stByCode: Map<string, AuditShiftType>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const slot of slots) {
    if (!isCall(slot.shift_types)) continue;
    const pid = holderOf(slot);
    if (!pid) continue;
    for (const chain of dayChainsFor(doc, slot.shift_types!.code, slot.derived_day_type ?? '')) {
      for (const link of chain.links ?? []) {
        // Only DAY-code links are sequence claims; a call→call link (the
        // weekend block chains) says nothing about D placement.
        if (!isSequence(stByCode.get(link.code) ?? null)) continue;
        const key = `${pid}|${addDays(slot.slot_date, link.offset)}`;
        const list = out.get(key) ?? [];
        if (!list.includes(link.code)) list.push(link.code);
        out.set(key, list);
      }
    }
  }
  return out;
}

export interface DAuditResult {
  findings: DFinding[];
  /** Every placement across all findings, de-duplicated by slot — the payload
   *  a "fix all" applies. Later findings win on a contested slot; the order
   *  below puts sequence fixes before ladder ones so a ladder reorder never
   *  overwrites a sequence correction. */
  placements: DPlacement[];
}

export function auditDAssignments(
  slots: readonly AuditSlot[], doc: CallPatternDoc,
): DAuditResult {
  const stByCode = new Map<string, AuditShiftType>();
  for (const s of slots) if (s.shift_types) stByCode.set(s.shift_types.code, s.shift_types);
  const { byDate, callsByPid } = index(slots);
  const claims = sequenceClaims(slots, doc, stByCode);
  const findings: DFinding[] = [];

  // ── 1. SEQUENCE: the lowest-ordered claim wins ────────────────────────────
  for (const [key, codes] of claims) {
    const [pid, date] = key.split('|');
    const want = [...codes].sort((a, b) =>
      order(stByCode.get(a) ?? null) - order(stByCode.get(b) ?? null))[0];
    const onDate = byDate.get(date) ?? [];
    const wantSlot = onDate.find(s => s.shift_types?.code === want);
    if (!wantSlot || wantSlot.locked) continue;          // nothing to place into
    if (holderOf(wantSlot) === pid) continue;            // already right

    // What else does this provider hold that day? A sequence slot they occupy
    // wrongly is vacated by the same fix; a CALL is never touched.
    const heldSeq = onDate.filter(s => isSequence(s.shift_types) && holderOf(s) === pid);
    const heldCall = onDate.some(s => isCall(s.shift_types) && holderOf(s) === pid);
    if (heldCall) continue;   // on call that day — the pattern's own doing, not a D error

    const occupant = holderOf(wantSlot);
    if (occupant) continue;   // taken by someone else: reportable, not auto-fixable here

    const placements: DPlacement[] = [
      ...heldSeq.map(s => ({ slotId: s.id, providerId: null })),
      { slotId: wantSlot.id, providerId: pid },
    ];
    // The two-claims fact is the most interesting thing this pass finds, so it
    // is appended to EITHER branch — an earlier version bound it to the
    // wrong-code branch only and a "both claimed, lower wins" case reported as
    // a plain missing slot.
    const both = codes.length > 1
      ? ` (${codes.join(' and ')} both claimed — ${want} is lower)` : '';
    findings.push({
      kind: heldSeq.length > 0 ? 'wrong-sequence-code' : 'missing-sequence-code',
      date,
      detail: (heldSeq.length > 0
        ? `holds ${heldSeq.map(s => s.shift_types!.code).join(' + ')} but the call pattern gives them ${want}`
        : `is owed ${want} and ${want} is open`) + both,
      providerIds: [pid],
      placements,
    });
  }

  // ── 2. LADDER: D4-D8 by soonest next call ─────────────────────────────────
  for (const [date, onDate] of byDate) {
    const ladder = onDate
      .filter(s => isLadder(s.shift_types) && !s.locked)
      .sort((a, b) => order(a.shift_types) - order(b.shift_types));
    const holders = ladder.map(holderOf);
    const present = holders.filter((p): p is string => !!p);
    if (present.length < 2) continue;

    // The engine's 'early-out' clinical tuple: soonest next call, then that
    // call's rank tier, then most-recently-called. (The workday deficit, which
    // breaks exact ties in the engine, is not available here; it never
    // outranks a clinical key in 'early-out' mode, so its absence can only
    // affect providers tied on all three.)
    const keyOf = (pid: string) => {
      const calls = callsByPid.get(pid) ?? [];
      const next = calls.find(c => c.date > date);
      const prev = [...calls].reverse().find(c => c.date < date);
      return {
        distance: next ? daysBetween(date, next.date) : Number.MAX_SAFE_INTEGER,
        recency: prev ? daysBetween(prev.date, date) : Number.MAX_SAFE_INTEGER,
      };
    };
    const wanted = [...present].sort((a, b) => {
      const ka = keyOf(a), kb = keyOf(b);
      return ka.distance - kb.distance || ka.recency - kb.recency || a.localeCompare(b);
    });
    // Compare against the CURRENT order with gaps removed, so an empty D6 in
    // the middle is not itself a finding — only relative order matters.
    if (present.every((pid, i) => pid === wanted[i])) continue;

    // Fill the ladder top-down: the reordered holders take the first N slots.
    const placements: DPlacement[] = ladder.map((s, i) => ({
      slotId: s.id, providerId: wanted[i] ?? null,
    }));
    findings.push({
      kind: 'ladder-order', date,
      detail: `relief order is ${present.join(' → ')} but nearest-call order is ${wanted.join(' → ')}`,
      providerIds: wanted,
      placements,
    });
  }

  findings.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  const bySlot = new Map<string, DPlacement>();
  for (const f of findings) for (const p of f.placements) bySlot.set(p.slotId, p);
  return { findings, placements: [...bySlot.values()] };
}
