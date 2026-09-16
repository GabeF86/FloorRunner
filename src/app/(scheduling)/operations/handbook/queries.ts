/* ───────────────────────────────────────────────────────────────────────────
 * Group handbook — data layer.
 *
 * Seven reads. Six of them hit tables that ship EMPTY (patch58) and stay empty
 * until back office enters the real thing; the seventh — site call rules — is
 * live config that has been there all along.
 *
 * ── EMPTY IS NOT AN ERROR, AND AN ERROR IS NOT EMPTY ───────────────────────
 * The distinction matters more here than anywhere else in the app. "No rates
 * recorded yet" invites somebody to add one. "$0" or a silently missing row
 * tells them the group pays nothing. So each panel carries its own error and
 * the page renders the two states differently.
 * ─────────────────────────────────────────────────────────────────────────── */

import { readAllRows } from '@/lib/pagedRead';
import { embedArray } from '@/lib/embed';
import { firstOrg } from '@/lib/queries/roster';
import { CallPatternDocSchema, type CallPatternDoc } from '@/lib/rulesEngine/callPattern';
import {
  siteCallRules, type SiteCallRule,
  type RuleSiteRow, type RuleShiftTypeRow, type RuleProfileRow,
} from '@/lib/siteCallRules';
import {
  resolveRates, groupCandidates, splitMeetings, openActionCount,
  type RateRow, type RateLine, type CandidateRow, type MeetingRow,
  type PipelineStageGroup, type CandidateLine,
} from '@/lib/handbook';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

export interface LeadershipRow {
  id: string;
  title: string;
  person_name?: string | null;
  division?: string | null;
  display_order?: number | null;
}

export interface DocumentRow {
  id: string;
  title: string;
  category?: string | null;
  version_on?: string | null;
  rolling?: boolean | null;
  access_level?: string | null;
  url?: string | null;
}

/** Each panel reports its own failure, so one dead table cannot blank a page
 *  that is six-sevenths fine. */
export interface Panel<T> { data: T; error: string | null }

export interface HandbookData {
  today: string;
  siteRules: Panel<SiteCallRule[]>;
  rates: Panel<RateLine[]>;
  meetings: Panel<{ next: MeetingRow | null; past: MeetingRow[]; openActions: number }>;
  pipeline: Panel<{
    stages: PipelineStageGroup[]; active: number; needAttention: CandidateLine[];
  }>;
  leadership: Panel<LeadershipRow[]>;
  documents: Panel<DocumentRow[]>;
  /** Short name by site id, for the panels that name one. */
  siteNames: Record<string, string>;
}

const EMPTY_RULES: SiteCallRule[] = [];

export async function loadHandbookData(
  sb: SchedulingClient,
  opts: { today: string },
): Promise<HandbookData> {
  const today = opts.today;
  // firstOrg, not firstOrgId, precisely because those two cases render
  // differently here: a failed org read is NOT "no org". Flattened, every
  // scoped panel below would return zero rows and the page would read as an
  // empty handbook waiting to be filled in.
  const org = await firstOrg(sb);
  const orgId = org.ok ? (org.rows[0]?.id ?? null) : null;
  const orgError = !org.ok
    ? `organization: ${org.error}`
    : orgId ? null : 'No organization record was found.';

  const scoped = <T>(table: string, select: string, order: string) =>
    readAllRows<T>((f, t) => {
      const q = sb.from(table).select(select, { count: 'exact' }).order(order).range(f, t);
      return orgId ? q.eq('organization_id', orgId) : q;
    }, table.replace(/_/g, ' '));

  const [
    sitesRes, shiftTypesRes, profilesRes, patternsRes,
    ratesRes, meetingsRes, candidatesRes, leadershipRes, documentsRes,
  ] = await Promise.all([
    readAllRows<RuleSiteRow>((f, t) => sb.from('sites')
      .select('id, name, short_name, call_par_level, display_order', { count: 'exact' })
      .eq('is_active', true).order('display_order').order('name').range(f, t), 'sites'),

    readAllRows<RuleShiftTypeRow>((f, t) => sb.from('shift_types')
      .select('site_id, code, category, call_rank, is_active, parent_call_code',
        { count: 'exact' })
      .order('site_id').order('code').range(f, t), 'shift types'),

    readAllRows<RuleProfileRow>((f, t) => sb.from('provider_employment_profiles')
      .select('provider_id, home_site_id, call_taker, partial_call_taker, fte_value',
        { count: 'exact' })
      .order('provider_id').range(f, t), 'employment profiles'),

    readAllRows<{ site_id: string; definition: unknown }>((f, t) => sb.from('call_patterns')
      .select('site_id, definition', { count: 'exact' })
      .eq('status', 'active').order('site_id').range(f, t), 'call patterns'),

    scoped<RateRow>('pay_rates',
      'id, site_id, label, amount_cents, unit, effective_date, notes', 'label'),

    scoped<MeetingRow>('committee_meetings',
      'id, meets_on, meets_at, location, agenda_posted_on, minutes_status, topics,'
      + ' minutes_url, committee_action_items(id, description, owner_name, due_on, status)',
      'meets_on'),

    scoped<CandidateRow>('candidates',
      'id, initials, stage, stage_on, home_site_id, expires_on, note, status', 'stage_on'),

    scoped<LeadershipRow>('leadership_roles',
      'id, title, person_name, division, display_order', 'display_order'),

    scoped<DocumentRow>('documents',
      'id, title, category, version_on, rolling, access_level, url', 'title'),
  ]);

  // The site-rules panel needs four reads to agree; any one failing makes the
  // par comparison meaningless, so they share an error rather than rendering a
  // pool of 0 FTE against a real par.
  const rulesError = orgError
    ?? sitesRes.error ?? shiftTypesRes.error ?? profilesRes.error ?? patternsRes.error;

  const patterns = new Map<string, CallPatternDoc | null>();
  for (const row of patternsRes.rows) {
    // A doc that fails the schema is null, matching the engine, which silently
    // falls back to CLASSIC_PATTERN rather than erroring.
    const parsed = CallPatternDocSchema.safeParse(row.definition);
    patterns.set(row.site_id, parsed.success ? parsed.data : null);
  }

  const siteNames: Record<string, string> = {};
  for (const s of sitesRes.rows) siteNames[s.id] = s.short_name || s.name;

  const meetings = meetingsRes.rows.map(m => ({
    ...m,
    committee_action_items: embedArray(m.committee_action_items as never),
  }));
  const split = splitMeetings(meetings, today);

  return {
    today,
    siteRules: {
      data: rulesError ? EMPTY_RULES : siteCallRules({
        sites: sitesRes.rows,
        shiftTypes: shiftTypesRes.rows,
        profiles: profilesRes.rows,
        patterns,
      }),
      error: rulesError,
    },
    rates: {
      data: ratesRes.error ? [] : resolveRates(ratesRes.rows, today),
      error: orgError ?? ratesRes.error,
    },
    meetings: {
      data: { ...split, openActions: openActionCount(meetings) },
      error: orgError ?? meetingsRes.error,
    },
    pipeline: {
      data: groupCandidates(candidatesRes.error ? [] : candidatesRes.rows, today),
      error: orgError ?? candidatesRes.error,
    },
    leadership: {
      data: leadershipRes.error ? [] : leadershipRes.rows,
      error: orgError ?? leadershipRes.error,
    },
    documents: {
      data: documentsRes.error ? [] : documentsRes.rows,
      error: orgError ?? documentsRes.error,
    },
    siteNames,
  };
}
