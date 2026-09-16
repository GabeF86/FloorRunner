/* ───────────────────────────────────────────────────────────────────────────
 * Site call rules, par level and the roster behind them.
 *
 * One line per site: what call it runs, what par it is set to, and how much
 * call-taking FTE actually lives there. Everything is read from live config —
 * sites.call_par_level, the site's active CallPatternDoc, its call shift types
 * and the employment profiles — so the page cannot drift from what the
 * generator builds to.
 *
 * ── THE PAR GAP IS NOT AN ERROR ────────────────────────────────────────────
 * Par is AUTHORITATIVE (Gabriel 2026-07-24): it is the denominator the engine
 * divides by, and it is never reduced to the pool's summed FTE. When the pool
 * is smaller than the par, obligations deliberately under-cover the schedule
 * and the remainder is the PAID-PICKUP layer, taken after the schedule is
 * made. So this module reports the gap and says what it means; it does not
 * call it a misconfiguration. The value of surfacing it is that the size of
 * the pickup layer stops being a thing somebody notices mid-block.
 * ─────────────────────────────────────────────────────────────────────────── */

import type { CallPatternDoc } from './rulesEngine/callPattern';

export interface RuleSiteRow {
  id: string;
  name: string;
  short_name?: string | null;
  call_par_level?: number | null;
}

export interface RuleShiftTypeRow {
  site_id: string;
  code: string;
  category: string;
  call_rank?: number | null;
  is_active?: boolean | null;
  /** Set on a SPLIT SEGMENT (C1N12 under C1). Segments are pieces of a call,
   *  not calls of their own, and listing them would turn "C1 + C2" into a
   *  twelve-code wall. */
  parent_call_code?: string | null;
}

export interface RuleProfileRow {
  provider_id: string;
  home_site_id?: string | null;
  call_taker?: boolean | null;
  partial_call_taker?: boolean | null;
  fte_value?: number | string | null;
}

export interface SiteCallRule {
  siteId: string;
  siteName: string;
  shortName: string;
  /** Null when the site stores no par — shown as "not set", never as 0. */
  parLevel: number | null;
  /** Σ FTE of the home-site call pool. */
  poolFte: number;
  poolCount: number;
  /** "C1 + C2 + Sat/Sun C3 neuro", "No overnight call", or "Not configured". */
  structure: string;
  /** False when the site has NO shift types at all. The distinction is not
   *  cosmetic: Riddle runs call every night and has twelve call takers homed
   *  there — it simply has nothing entered yet, and printing "No overnight
   *  call" beside it would state the opposite of the truth as fact. */
  configured: boolean;
  /** par − poolFte, positive when par is the larger. Null without a par. */
  parGap: number | null;
  /** Worth a line of explanation on the page. */
  flagged: boolean;
  flagNote: string;
}

/** The engine's own coercion: a missing or unparseable FTE is 1.0, matching
 *  loadGenerationContext's profile load. Numerics arrive from PostgREST as
 *  strings or numbers depending on the driver — both are handled here rather
 *  than at each call site. */
function fteOf(v: number | string | null | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 1;
}

/** Under half an FTE either way is noise, not a staffing story. */
const GAP_TOLERANCE = 0.5;

/** NOT CONFIGURED and NO OVERNIGHT CALL are different claims. The first says
 *  nothing has been entered; the second asserts a clinical fact about the
 *  site. Six of the eight sites have zero shift types, and several of them
 *  plainly do run call, so conflating the two would print confident nonsense
 *  down most of the column. */
export const NOT_CONFIGURED = 'Not configured';
export const NO_CALL = 'No overnight call';

function describeStructure(
  codes: RuleShiftTypeRow[],
  doc: CallPatternDoc | null,
): string {
  if (codes.length === 0) return NOT_CONFIGURED;

  const neuro = doc?.neuroWeekend?.code;
  const base = codes
    .filter(c => c.category === 'call' && c.is_active !== false && !c.parent_call_code)
    .sort((a, b) => (a.call_rank ?? 99) - (b.call_rank ?? 99) || a.code.localeCompare(b.code));

  if (base.length === 0) return NO_CALL;

  const weekday = base.filter(c => c.code !== neuro).map(c => c.code);
  const parts = weekday.join(' + ');
  // The neuro tier is a weekend service, so it is named as one rather than
  // sitting in the list as if it ran Monday.
  return neuro && base.some(c => c.code === neuro)
    ? `${parts}${parts ? ' + ' : ''}Sat/Sun ${neuro} neuro`
    : parts;
}

export function siteCallRules(input: {
  sites: ReadonlyArray<RuleSiteRow>;
  shiftTypes: ReadonlyArray<RuleShiftTypeRow>;
  profiles: ReadonlyArray<RuleProfileRow>;
  /** site id → its active pattern, or null where none parsed. */
  patterns: ReadonlyMap<string, CallPatternDoc | null>;
}): SiteCallRule[] {
  const typesBySite = new Map<string, RuleShiftTypeRow[]>();
  for (const st of input.shiftTypes) {
    const list = typesBySite.get(st.site_id);
    if (list) list.push(st); else typesBySite.set(st.site_id, [st]);
  }

  const poolBySite = new Map<string, { fte: number; count: number }>();
  for (const p of input.profiles) {
    // The generator's pool rule (loadGenerationContext §3): a call taker or
    // partial call taker whose HOME site this is. A day doc owes no call and
    // must not inflate the roster this par is compared against.
    if (!p.home_site_id) continue;
    if (!p.call_taker && !p.partial_call_taker) continue;
    const acc = poolBySite.get(p.home_site_id) || { fte: 0, count: 0 };
    acc.fte += fteOf(p.fte_value);
    acc.count += 1;
    poolBySite.set(p.home_site_id, acc);
  }

  return input.sites.map(site => {
    const pool = poolBySite.get(site.id) || { fte: 0, count: 0 };
    const par = typeof site.call_par_level === 'number' ? site.call_par_level : null;
    const structure = describeStructure(
      typesBySite.get(site.id) || [], input.patterns.get(site.id) ?? null);
    const configured = structure !== NOT_CONFIGURED;
    const runsCall = configured && structure !== NO_CALL;
    // Rounded to two places before comparing: 8.7000000000000002 − 8.7 is not
    // a staffing gap.
    const gap = par == null ? null : Math.round((par - pool.fte) * 100) / 100;

    let flagged = false;
    let flagNote = '';
    // ORDER MATTERS. An empty pool also produces a large gap, and reporting it
    // as a pickup layer would describe a data problem as a staffing plan —
    // there is nobody to take those pickups. The more specific cause wins.
    if (!configured && pool.count > 0) {
      flagged = true;
      flagNote = `${pool.count} call ${pool.count === 1 ? 'taker is' : 'takers are'} homed here `
        + `(${pool.fte.toFixed(2)} FTE), but the site has no shift types entered, so nothing `
        + 'can be scheduled for it yet.';
    } else if (runsCall && pool.count === 0) {
      flagged = true;
      flagNote = 'This site runs call but no provider lists it as their home site, '
        + 'so it has no call roster to measure the par against.';
    } else if (runsCall && par == null) {
      flagged = true;
      flagNote = 'No call par level is set, so the engine falls back to its default of 12.';
    } else if (par != null && runsCall && gap != null && Math.abs(gap) >= GAP_TOLERANCE) {
      flagged = true;
      flagNote = gap > 0
        ? `Par ${par} against a home roster of ${pool.fte.toFixed(2)} FTE. `
          + `Obligations cover ${gap.toFixed(2)} FTE less than the schedule by design — `
          + 'that difference is the paid-pickup layer.'
        : `Par ${par} against a home roster of ${pool.fte.toFixed(2)} FTE. `
          + `The roster is ${Math.abs(gap).toFixed(2)} FTE LARGER than the par, so stated `
          + 'obligations add up to more call than the schedule contains.';
    }

    return {
      siteId: site.id,
      siteName: site.name,
      shortName: site.short_name || site.name.slice(0, 4).toUpperCase(),
      parLevel: par,
      poolFte: Math.round(pool.fte * 100) / 100,
      poolCount: pool.count,
      structure,
      configured,
      parGap: gap,
      flagged,
      flagNote,
    };
  });
}
