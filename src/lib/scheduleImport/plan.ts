/* ───────────────────────────────────────────────────────────────────────────
 * Master-sheet cells + a code dictionary → a plan of database writes.
 *
 * Pure. It touches no database and performs no writes; it decides WHAT should
 * be written so that the decision can be reviewed, diffed and tested before
 * anything is inserted. The importer that executes a plan is a thin loop.
 *
 * ── THE CODE OWNS THE SITE, NOT THE ROW ────────────────────────────────────
 * A physician's row sits under their HOME section, but the work may be
 * somewhere else: `pRoth1` is a Rothman assignment and 0 of its 23 cells are
 * worked by a Rothman-homed physician; `OrthoMD2` is staffed almost entirely
 * off the Bryn Mawr roster. So the target site comes from the CODE's mapping,
 * and the row's section is kept only to cross-check the mapping and to report
 * where a physician is based. Reading the site off the row would file every
 * cross-site day at the wrong hospital — and cross-site double-booking is
 * clinical invariant 3.
 *
 * ── LEAVE IS A RUN, NOT 62 DAYS ────────────────────────────────────────────
 * The sheet writes `Vac` in every cell of a vacation. 668 of them describe
 * perhaps sixty actual absences. They are collapsed back into date RANGES,
 * because that is both what `provider_availability` stores and what a human
 * entered in the first place. A run is broken by a gap OR by a change of code,
 * never merged across the two.
 * ─────────────────────────────────────────────────────────────────────────── */

import type { MasterCell, MasterSheet } from './masterCsv';

/** What a sheet code means, once somebody has decided. */
export type CodeKind =
  /** A call assignment — becomes a slot + assignment on a call shift type. */
  | 'call'
  /** A clinical day assignment — slot + assignment on a regular shift type. */
  | 'day'
  /** The day after call. Whether this is a day OFF or a short WORKING shift is
   *  a per-site decision; `shiftCode` null means off, a code means it works. */
  | 'post_call'
  /** A scheduled non-working day that is part of the person's work pattern
   *  (a contracted Friday off). Not leave — it must not consume a balance. */
  | 'off'
  /** Approved absence — vacation, sick, jury duty. Becomes availability. */
  | 'unavailable'
  /** Known, deliberately not imported (e.g. a placeholder row's code). */
  | 'ignore';

export interface CodeMapping {
  code: string;
  kind: CodeKind;
  /** Site SHORT NAME the work happens at (not the row's section). Required for
   *  call/day/post_call-with-shift; ignored otherwise. */
  site?: string;
  /** Target `shift_types.code` at that site. Null on a post_call that is a
   *  plain day off. */
  shiftCode?: string | null;
  /** `provider_availability.availability_type` for leave, e.g. 'pto'. */
  availabilityType?: string;
  /** Free text carried into the written row, so the origin is traceable. */
  note?: string;
}

/** A provider row that is not a person. */
export interface PlanInput {
  sheet: MasterSheet;
  mappings: ReadonlyArray<CodeMapping>;
  /** CSV provider code → database provider id. A code absent here is reported,
   *  never guessed at. */
  providerIds: ReadonlyMap<string, string>;
  /** CSV provider codes that are OPEN-SLOT placeholders (`pBMOpen1`), not
   *  people. Their cells still create the SLOT — that is the point, the
   *  position existed and nobody filled it — but no assignment. */
  placeholders?: ReadonlySet<string>;
}

export interface PlannedAssignment {
  site: string;
  date: string;
  shiftCode: string;
  /** Null for an open position. */
  providerId: string | null;
  providerCode: string;
  /** The sheet cell this came from, for tracing a surprise back to a row. */
  sourceCode: string;
  starred: boolean;
  /** `call` positions are single-holder by nature; `day` codes routinely have
   *  several holders on one date because they are several ROOMS. Reports that
   *  do not distinguish the two flag eight rooms as a double-booking. */
  kind: CodeKind;
}

export interface PlannedAvailability {
  providerId: string;
  providerCode: string;
  availabilityType: string;
  startDate: string;
  endDate: string;
  sourceCode: string;
  /** Days actually written in the sheet inside this range. Equal to the span
   *  unless the run was collapsed across a gap — which it never is, so a
   *  mismatch here is a bug, and the importer asserts on it. */
  days: number;
}

export interface ImportPlan {
  assignments: PlannedAssignment[];
  availability: PlannedAvailability[];
  /** Per site, the dates that need slots — the union of assignment dates. */
  sites: Array<{ site: string; firstDate: string; lastDate: string; assignments: number }>;
  /** Codes in the sheet with no mapping. Non-empty = the plan is incomplete
   *  and must not be executed. */
  unmapped: Array<{ code: string; count: number; sections: string[] }>;
  /** Provider codes with no database id, and how many cells they would lose. */
  unknownProviders: Array<{ providerCode: string; section: string; cells: number }>;
  problems: string[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function nextDay(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function planImport(input: PlanInput): ImportPlan {
  const byCode = new Map<string, CodeMapping>();
  for (const m of input.mappings) byCode.set(m.code, m);
  const placeholders = input.placeholders ?? new Set<string>();

  const assignments: PlannedAssignment[] = [];
  const problems: string[] = [];
  const unmapped = new Map<string, { count: number; sections: Set<string> }>();
  const unknown = new Map<string, { section: string; cells: number }>();

  // Leave cells, gathered per (provider, code) then collapsed into runs.
  const leaveCells = new Map<string, MasterCell[]>();

  for (const cell of input.sheet.cells) {
    const mapping = byCode.get(cell.code);
    if (!mapping) {
      const acc = unmapped.get(cell.code) || { count: 0, sections: new Set<string>() };
      acc.count++;
      acc.sections.add(cell.section);
      unmapped.set(cell.code, acc);
      continue;
    }
    if (mapping.kind === 'ignore') continue;

    const isPlaceholder = placeholders.has(cell.providerCode);
    const providerId = isPlaceholder ? null : input.providerIds.get(cell.providerCode) ?? null;
    if (!isPlaceholder && !providerId) {
      const acc = unknown.get(cell.providerCode) || { section: cell.section, cells: 0 };
      acc.cells++;
      unknown.set(cell.providerCode, acc);
      continue;
    }

    if (mapping.kind === 'unavailable' || mapping.kind === 'off') {
      // A placeholder cannot be on leave — it is not a person. Recorded rather
      // than silently dropped, because it means the dictionary is wrong.
      if (!providerId) {
        problems.push(
          `${cell.providerCode} is an open-slot placeholder but carries the leave code `
          + `${cell.code} on ${cell.date}; ignored.`);
        continue;
      }
      // 'off' is a work-pattern day, not leave. It is collected the same way
      // and the caller decides whether to write it — see the `off` note on
      // CodeKind. Without an availabilityType there is nothing to write.
      if (!mapping.availabilityType) continue;
      const key = `${cell.providerCode}|${cell.code}`;
      const list = leaveCells.get(key);
      if (list) list.push(cell); else leaveCells.set(key, [cell]);
      continue;
    }

    // call / day / post_call
    const shiftCode = mapping.shiftCode ?? null;
    if (!shiftCode) {
      // A post-call day that is simply a day off creates nothing: the absence
      // of an assignment IS the day off, and inventing a zero-hour shift would
      // put a phantom row on the grid.
      continue;
    }
    if (!mapping.site) {
      problems.push(`Code ${cell.code} maps to shift ${shiftCode} but names no site; skipped.`);
      continue;
    }
    assignments.push({
      site: mapping.site,
      date: cell.date,
      shiftCode,
      providerId,
      providerCode: cell.providerCode,
      sourceCode: cell.code,
      starred: cell.starred,
      kind: mapping.kind,
    });
  }

  // ── Collapse leave into runs ─────────────────────────────────────────────
  const availability: PlannedAvailability[] = [];
  for (const [key, cells] of leaveCells) {
    const mapping = byCode.get(cells[0].code)!;
    const sorted = [...cells].sort((a, b) => a.date.localeCompare(b.date));
    let start = sorted[0].date;
    let prev = start;
    let days = 1;
    const flush = () => availability.push({
      providerId: input.providerIds.get(sorted[0].providerCode)!,
      providerCode: sorted[0].providerCode,
      availabilityType: mapping.availabilityType!,
      startDate: start,
      endDate: prev,
      sourceCode: mapping.code,
      days,
    });
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i].date;
      if (d === prev) continue;                 // same day twice (two rows)
      if (d === nextDay(prev)) { prev = d; days++; continue; }
      flush();
      start = d; prev = d; days = 1;
    }
    flush();
    if (!ISO.test(start)) problems.push(`Bad date in leave run ${key}.`);
  }
  availability.sort((a, b) =>
    a.providerCode.localeCompare(b.providerCode) || a.startDate.localeCompare(b.startDate));

  // ── Per-site date span ───────────────────────────────────────────────────
  const siteAcc = new Map<string, { first: string; last: string; n: number }>();
  for (const a of assignments) {
    const acc = siteAcc.get(a.site) || { first: a.date, last: a.date, n: 0 };
    if (a.date < acc.first) acc.first = a.date;
    if (a.date > acc.last) acc.last = a.date;
    acc.n++;
    siteAcc.set(a.site, acc);
  }

  return {
    assignments,
    availability,
    sites: [...siteAcc.entries()]
      .map(([site, v]) => ({ site, firstDate: v.first, lastDate: v.last, assignments: v.n }))
      .sort((a, b) => a.site.localeCompare(b.site)),
    unmapped: [...unmapped.entries()]
      .map(([code, v]) => ({ code, count: v.count, sections: [...v.sections].sort() }))
      .sort((a, b) => b.count - a.count),
    unknownProviders: [...unknown.entries()]
      .map(([providerCode, v]) => ({ providerCode, section: v.section, cells: v.cells }))
      .sort((a, b) => b.cells - a.cells),
    problems,
  };
}

/**
 * Two physicians holding the same CALL position on the same day.
 *
 * Call only, deliberately. A day code with eight holders is eight ROOMS and is
 * entirely normal; flagging it would bury the handful of real findings under
 * 150 false ones. A call tier with two holders is either a mid-weekend handoff
 * or a genuine double-booking, and the sheet contains both — so this REPORTS
 * rather than deduplicating. Importing both is correct; the grid shows the
 * double and somebody decides what it was.
 */
export function duplicatePositions(plan: ImportPlan): Array<{
  site: string; date: string; shiftCode: string; providers: string[];
}> {
  const seen = new Map<string, string[]>();
  for (const a of plan.assignments) {
    if (a.kind !== 'call') continue;
    const key = `${a.site}|${a.date}|${a.shiftCode}`;
    const list = seen.get(key);
    if (list) list.push(a.providerCode); else seen.set(key, [a.providerCode]);
  }
  return [...seen.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, providers]) => {
      const [site, date, shiftCode] = key.split('|');
      return { site, date, shiftCode, providers: providers.sort() };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.site.localeCompare(b.site));
}

/**
 * A physician assigned at two DIFFERENT sites on the same day.
 *
 * Clinical invariant 3 in its rawest form. The sheet can legitimately contain
 * it (a morning at one hospital, an evening list at another), so this reports
 * rather than blocks — but it is the first thing to look at before publishing
 * an imported block, because a published cross-site double-booking is exactly
 * what the engine is built to prevent.
 */
export function crossSiteSameDay(plan: ImportPlan): Array<{
  providerCode: string; date: string; sites: string[];
}> {
  const byPidDate = new Map<string, Set<string>>();
  for (const a of plan.assignments) {
    if (!a.providerId) continue;
    const key = `${a.providerCode}|${a.date}`;
    const set = byPidDate.get(key) ?? new Set<string>();
    set.add(a.site);
    byPidDate.set(key, set);
  }
  return [...byPidDate.entries()]
    .filter(([, sites]) => sites.size > 1)
    .map(([key, sites]) => {
      const [providerCode, date] = key.split('|');
      return { providerCode, date, sites: [...sites].sort() };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.providerCode.localeCompare(b.providerCode));
}

/**
 * Leave that overlaps an assignment — the same physician on vacation and
 * scheduled on the same day.
 *
 * The sheet contains these deliberately (a starred shift inside a vacation
 * block, on the reading that the star means "worked during scheduled leave"),
 * so this is a REPORT, not a rejection. It is also the single best evidence
 * for what the asterisk means, so the report carries the flag.
 */
export function leaveConflicts(plan: ImportPlan): Array<{
  providerCode: string; date: string; shiftCode: string; leaveCode: string; starred: boolean;
}> {
  const out: Array<{
    providerCode: string; date: string; shiftCode: string; leaveCode: string; starred: boolean;
  }> = [];
  const byProvider = new Map<string, PlannedAvailability[]>();
  for (const av of plan.availability) {
    const list = byProvider.get(av.providerCode);
    if (list) list.push(av); else byProvider.set(av.providerCode, [av]);
  }
  for (const a of plan.assignments) {
    for (const av of byProvider.get(a.providerCode) || []) {
      if (a.date >= av.startDate && a.date <= av.endDate) {
        out.push({
          providerCode: a.providerCode,
          date: a.date,
          shiftCode: a.shiftCode,
          leaveCode: av.sourceCode,
          starred: a.starred,
        });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.providerCode.localeCompare(b.providerCode));
}
