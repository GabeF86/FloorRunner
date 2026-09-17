/* ───────────────────────────────────────────────────────────────────────────
 * How many anaesthetists a site NEEDS on a day.
 *
 * Demand, not supply. The staffing board's "needed" column used to be the slot
 * census — it counted the positions the published schedule already contained,
 * which can only ever say "the schedule matches the schedule". A block built
 * two rooms light read as fully covered, because the missing rooms were never
 * slots to begin with.
 *
 * Demand comes from the OR schedule: how many anaesthetising sites are
 * actually running. Today a scheduler reads that out of Epic and counts it in
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

export type DemandSource = 'manual' | 'calculated';

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
