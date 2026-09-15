// Configuration reads — shift types, rule sets, rule definitions and provider
// custom fields — shared by the API routes and by the server components that
// render the same data.
//
// Same rationale as lib/queries/roster.ts, which this sits beside: /sites,
// /rules and /settings used to arrive as empty HTML, hydrate, fetch the
// organization list to learn an id that never changes, and only THEN fetch the
// rows they exist to show. The reads now happen in the request that renders the
// page — but the routes below still serve every client-side reload (a filter
// toggle, a post-edit refresh), so the query has to live in exactly one place
// or the two copies drift. `include_inactive` on custom fields is precisely
// the kind of predicate that gets fixed in one copy and not the other.
//
// Returning a discriminated result rather than throwing lets the routes keep
// answering with the status codes they always have (400 for a missing org_id,
// 500 for a failed read) without this module knowing what HTTP is.
//
// Separate file from roster.ts only because these are not roster reads; the
// shared result/client types come from there.

import type { SchedulingClient, QueryResult } from './roster';

/** Shift types, optionally narrowed to one site, in display order. */
export async function listShiftTypes(
  sb: SchedulingClient,
  siteId?: string | null,
): Promise<QueryResult<Record<string, unknown>>> {
  let query = sb.from('shift_types').select('*').order('display_order');
  if (siteId) query = query.eq('site_id', siteId);
  const { data, error } = await query;
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, rows: (data ?? []) as Array<Record<string, unknown>> };
}

export interface RuleSetListFilters {
  orgId?: string | null;
  siteId?: string | null;
  status?: string | null;
}

/** Read the rule-set filters this module understands out of a query string. */
export function ruleSetFiltersFrom(searchParams: URLSearchParams): RuleSetListFilters {
  return {
    orgId: searchParams.get('org_id'),
    siteId: searchParams.get('site_id'),
    status: searchParams.get('status'),
  };
}

/**
 * Rule sets, newest first, with the owning site's name embedded.
 *
 * `sites(name)` is embedded rather than resolved client-side because the list
 * renders the site name in its own column and the rule set carries no other
 * handle on it.
 */
export async function listRuleSets(
  sb: SchedulingClient,
  f: RuleSetListFilters,
): Promise<QueryResult<Record<string, unknown>>> {
  let query = sb
    .from('rule_sets')
    .select('*, sites(name)')
    .order('created_at', { ascending: false });

  if (f.orgId) query = query.eq('organization_id', f.orgId);
  if (f.siteId) query = query.eq('site_id', f.siteId);
  if (f.status) query = query.eq('status', f.status);

  const { data, error } = await query;
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, rows: (data ?? []) as Array<Record<string, unknown>> };
}

/**
 * Rule definitions in evaluation order, optionally for one rule set.
 *
 * Called with no rule set by the /rules index, which needs every definition at
 * once to count them per rule set — one read instead of one per row.
 */
export async function listRuleDefinitions(
  sb: SchedulingClient,
  ruleSetId?: string | null,
): Promise<QueryResult<Record<string, unknown>>> {
  let query = sb
    .from('rule_definitions')
    .select('*')
    .order('priority_rank')
    .order('created_at');

  if (ruleSetId) query = query.eq('rule_set_id', ruleSetId);

  const { data, error } = await query;
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, rows: (data ?? []) as Array<Record<string, unknown>> };
}

export interface CustomFieldListFilters {
  orgId?: string | null;
  /** Default false — the list shows only active definitions unless asked. */
  includeInactive?: boolean;
}

/**
 * Provider custom-field definitions for one organization.
 *
 * org_id is REQUIRED (these are org-scoped by definition, and an unscoped read
 * would leak another group's field names), so a missing one is a 400 rather
 * than an unfiltered read.
 */
export async function listCustomFields(
  sb: SchedulingClient,
  f: CustomFieldListFilters,
): Promise<QueryResult<Record<string, unknown>>> {
  if (!f.orgId) return { ok: false, status: 400, error: 'org_id is required' };

  let query = sb
    .from('provider_custom_field_definitions')
    .select('*')
    .eq('organization_id', f.orgId)
    .order('display_order')
    .order('created_at');

  if (!f.includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, rows: (data ?? []) as Array<Record<string, unknown>> };
}
