/* ───────────────────────────────────────────────────────────────────────────
 * How many anaesthetists a site NEEDS on a day.
 *
 * Demand, not supply. The staffing board's "needed" column used to be the slot
 * census — it counted the positions the published schedule already contained,
 * which can only ever say "the schedule matches the schedule". A block built
 * two positions light read as fully covered, because the missing positions
 * were never slots to begin with.
 *
 * Demand comes from the OR schedule in Epic: how many anaesthetising sites are
 * actually running. That is the ONLY half of this picture that knows about
 * rooms — FloorRunner's own schedule holds people and their shift or call
 * status, never a room assignment, which is made on the day on the floor. Today a scheduler reads that out of Epic and counts it in
 * by hand. Later the staffing calculator will derive it. Both land in the same
 * table under different `source` values, and this module decides which one
 * wins.
 *
 * ── MANUAL BEATS CALCULATED ────────────────────────────────────────────────
 * A person who has looked at the OR schedule outranks a model of it. Both rows
 * are KEPT, though — an override that destroyed the calculated figure would
 * also destroy the only evidence that the calculator was wrong.
 *
 * ── AND A MISSING ROW IS NOT ZERO ──────────────────────────────────────────
 * Nobody has said what an uncounted day needs, so it reads N/A. Defaulting to
 * zero would paint it green and report an unstaffed hospital as covered, which
 * is the precise failure this replaces.
 * ─────────────────────────────────────────────────────────────────────────── */

export type DemandSource =
  /** A scheduler counted the OR schedule. Outranks everything. */
  | 'manual'
  /** The staffing calculator derived it (not yet built). */
  | 'calculated'
  /** The site's standing weekend call complement — the positions that must be
   *  covered every Saturday and Sunday whatever the OR is doing. Weekend call
   *  is structural, so it should not need typing in week after week. */
  | 'weekend_call';

/** A site's standing weekend call complement, from `sites.weekend_staffing`. */
export interface WeekendCall {
  md: number | null;
  crna: number | null;
}

/** Read `sites.weekend_staffing`, which is loose jsonb. Anything that is not a
 *  usable count reads as null — "not configured" — rather than zero. */
export function parseWeekendCall(raw: unknown): WeekendCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const md = normalise(rec.md as never);
  const crna = normalise(rec.crna as never);
  return md === null && crna === null ? null : { md, crna };
}

export interface DemandRow {
  site_id: string;
  demand_date: string;
  /** Null = not stated. Zero = genuinely none needed. Never conflate them. */
  md_needed?: number | null;
  crna_needed?: number | null;
  source?: string | null;
  notes?: string | null;
}

export interface ResolvedDemand {
  md: number | null;
  crna: number | null;
  source: DemandSource;
  notes: string | null;
}

/** `${siteId}|${date}` — the key the board joins demand to coverage on. */
export function demandKey(siteId: string, date: string): string {
  return `${siteId}|${date}`;
}

/**
 * Collapse the demand rows to one per site-day, manual winning.
 *
 * A row whose `md_needed` and `crna_needed` are BOTH null states nothing and
 * is dropped: it is an empty cell somebody tabbed through, and keeping it
 * would let it mask a real calculated row underneath.
 */
export function resolveDemand(rows: ReadonlyArray<DemandRow>): Map<string, ResolvedDemand> {
  const out = new Map<string, ResolvedDemand>();
  for (const r of rows) {
    const md = normalise(r.md_needed);
    const crna = normalise(r.crna_needed);
    if (md === null && crna === null) continue;

    const source: DemandSource = r.source === 'calculated' ? 'calculated' : 'manual';
    const key = demandKey(r.site_id, r.demand_date);
    const existing = out.get(key);
    // Manual outranks calculated. Between two rows of the same source the
    // last one wins, which cannot happen through the API — the table's unique
    // key is (site, date, source) — but a caller passing duplicates should get
    // a defined answer rather than a coin toss.
    if (existing && existing.source === 'manual' && source === 'calculated') continue;
    out.set(key, { md, crna, source, notes: r.notes ?? null });
  }
  return out;
}

/**
 * The demand for one site-day, applying the whole precedence chain:
 *
 *     manual  >  calculated  >  weekend call complement  >  nothing
 *
 * The weekend default sits LAST because it is a standing rule rather than an
 * observation: a scheduler who has counted this particular Saturday, or a
 * calculator that has modelled it, both know something the standing complement
 * does not. It applies on Saturdays and Sundays only.
 */
export function demandFor(input: {
  siteId: string;
  date: string;
  resolved: ReadonlyMap<string, ResolvedDemand>;
  weekendCall?: ReadonlyMap<string, WeekendCall>;
  /** 0 = Sunday … 6 = Saturday, from the caller's own date maths. */
  dayOfWeek: number;
}): ResolvedDemand | null {
  const stated = input.resolved.get(demandKey(input.siteId, input.date));
  if (stated) return stated;

  const isWeekend = input.dayOfWeek === 0 || input.dayOfWeek === 6;
  if (!isWeekend) return null;

  const wc = input.weekendCall?.get(input.siteId);
  if (!wc || (wc.md === null && wc.crna === null)) return null;
  return { md: wc.md, crna: wc.crna, source: 'weekend_call', notes: null };
}

function normalise(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * One cell of the entry grid, as typed.
 *
 * Returns the value to store, or `'invalid'` so the editor can refuse it
 * rather than silently writing a 0 for "3x" or dropping a negative.
 */
export function parseDemandInput(raw: string): number | null | 'invalid' {
  const t = raw.trim();
  if (t === '') return null;                 // cleared — back to not stated
  if (!/^\d{1,3}$/.test(t)) return 'invalid';
  return Number(t);
}
