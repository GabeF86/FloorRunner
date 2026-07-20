// SolveState — the mutable in-memory bookkeeping every placement pass reads
// and writes — plus its pure mutators/readers. Split out of solve.ts and
// genTypes.ts (2026-07-20 solve decomposition); genTypes RE-EXPORTS
// SolveState/emptySolveState so existing imports (tests included) keep
// working unchanged. Never touches I/O.
import { dayTypeBucket, daysBetween } from './shared';
import { creditWorkedDay } from './workDays';
import type { WorkDayBudget } from './genTypes';

// Mutable in-memory bookkeeping during solve. Never touches I/O.
export interface SolveState {
  bucketAssigned: Map<string, number>;       // "pid|bucket|code" -> count
  assignedOnDate: Map<string, Set<string>>;  // date -> set of pids
  handledSlotIds: Set<string>;
  callDatesByProvider: Map<string, string[]>; // pid -> sorted call dates
  // date -> pids whose day this is a pattern post-call BLOCK (day off), as
  // opposed to an ordinary assignment. Written alongside markAssigned at the
  // two block-marking sites (applyDayChains blocks; seedSolveState IF-1) so
  // OVERLAY placements — which skip the assignedOnDate budget — can still see
  // and respect blocked days (clinical invariant 1).
  blockedOnDate: Map<string, Set<string>>;
  // FTE working-days credit ledger (2026-07-17): pid -> set of WORKING dates
  // credited as worked (weekday assignments from any pass, post-call rest days
  // on weekdays, ICU-week weekdays). Single home for the credited counter the
  // workdays cap consults; only populated when ctx carries a workDayBudget.
  creditedWorkDays: Map<string, Set<string>>;
}

export function emptySolveState(): SolveState {
  return {
    bucketAssigned: new Map(),
    assignedOnDate: new Map(),
    handledSlotIds: new Set(),
    callDatesByProvider: new Map(),
    blockedOnDate: new Map(),
    creditedWorkDays: new Map(),
  };
}

// ── pure state helpers ──
export function markAssigned(s: SolveState, date: string, pid: string) {
  if (!s.assignedOnDate.has(date)) s.assignedOnDate.set(date, new Set());
  s.assignedOnDate.get(date)!.add(pid);
}
// Post-call BLOCK marker (day off), kept alongside markAssigned at the two
// block-marking sites only (applyDayChains blocks; seedSolveState IF-1).
// Overlay eligibility reads this map because overlays skip assignedOnDate.
export function markBlocked(s: SolveState, date: string, pid: string) {
  if (!s.blockedOnDate.has(date)) s.blockedOnDate.set(date, new Set());
  s.blockedOnDate.get(date)!.add(pid);
}
// FTE working-days credit wrapper. A no-op unless a budget is present — the
// no-budget path is byte-identical; the working-day filter + (provider, date)
// dedupe live in the shared creditWorkedDay ledger writer (workDays.ts).
export function creditWorkDay(s: SolveState, budget: WorkDayBudget | undefined, pid: string, date: string) {
  if (!budget) return;
  creditWorkedDay(s.creditedWorkDays, budget.workingDaySet, pid, date);
}
export function incBucket(s: SolveState, pid: string, dt: string, code: string) {
  const k = `${pid}|${dayTypeBucket(dt)}|${code}`;
  s.bucketAssigned.set(k, (s.bucketAssigned.get(k) || 0) + 1);
}
export function addCallDate(s: SolveState, pid: string, date: string) {
  const list = s.callDatesByProvider.get(pid) || [];
  if (list.includes(date)) return;
  list.push(date); list.sort();
  s.callDatesByProvider.set(pid, list);
}
export function daysSinceLastCall(s: SolveState, pid: string, date: string): number {
  const list = s.callDatesByProvider.get(pid) || [];
  let best = Infinity;
  for (const d of list) {
    if (d >= date) break;
    const gap = daysBetween(d, date);
    if (gap < best) best = gap;
  }
  return best;
}
// Did the provider have a call within `n` days BEFORE `date`? Generalizes the
// legacy "had a call exactly two days before" suppression check.
// NOTE: wider than legacy's exact-gap check (gap ∈ 1..n, not gap === n). Parity
// holds because classic uses this only on offset:-1 links where gap===1 is masked
// by the same-date guard — keep in mind for positive-offset links.
export function hadCallWithin(s: SolveState, pid: string, date: string, n: number): boolean {
  for (const d of s.callDatesByProvider.get(pid) || []) {
    const gap = daysBetween(d, date);
    if (gap > 0 && gap <= n) return true;
  }
  return false;
}
