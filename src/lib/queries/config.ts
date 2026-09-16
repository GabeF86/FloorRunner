// Configuration reads — shift types, provider custom fields and the active
// call pattern — shared by the API routes and by the server components that
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
import { CallPatternDocSchema, CLASSIC_PATTERN, type CallPatternDoc } from '@/lib/rulesEngine/callPattern';

/** Shift types, optionally narrowed to one site, in display order. */
export async function listShiftTypes(
  sb: SchedulingClient,
  siteId?: string | null,
): Promise<QueryResult<Record<string, unknown>>> {
  // select('*') on purpose: this feeds both the site editor (which needs every
  // column) and the scheduling-logic view. Naming columns here would mean
  // remembering to add coverage_notes-style additions in two places.
  let query = sb.from('shift_types').select('*').order('display_order');
  if (siteId) query = query.eq('site_id', siteId);
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

/**
 * A site's ACTIVE call pattern, parsed.
 *
 * Returns the parsed doc plus whether the stored document failed validation.
 * That distinction is the whole point: the engine silently falls back to
 * CLASSIC_PATTERN when a doc does not satisfy the strict schema, so a site can
 * be running structure nobody intended while the stored JSON looks fine in the
 * editor. A page describing what the engine obeys has to say which of the two
 * it is describing.
 */
export async function readActiveCallPattern(
  sb: SchedulingClient,
  siteId: string,
): Promise<{
  ok: true; name: string | null; doc: CallPatternDoc | null; usingFallback: boolean;
} | { ok: false; status: number; error: string }> {
  const { data, error } = await sb
    .from('call_patterns')
    .select('name, definition')
    .eq('site_id', siteId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };

  const row = data as { name?: string; definition?: unknown } | null;
  if (!row) return { ok: true, name: null, doc: null, usingFallback: false };

  const parsed = CallPatternDocSchema.safeParse(row.definition);
  return parsed.success
    ? { ok: true, name: row.name ?? null, doc: parsed.data, usingFallback: false }
    // The engine would use CLASSIC here, so that is what gets described — and
    // the caller is told, because silently showing the fallback as if it were
    // the site's own pattern is the failure this flag exists to prevent.
    : { ok: true, name: row.name ?? null, doc: CLASSIC_PATTERN, usingFallback: true };
}
