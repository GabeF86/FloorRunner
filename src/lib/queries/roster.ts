// Roster reads, shared by the API routes and by the server components that
// render the same data.
//
// ── WHY THIS MODULE EXISTS ─────────────────────────────────────────────────
// The list pages used to be client components: the HTML arrived empty, the
// browser hydrated, and only then did it fetch. Moving them to server
// components puts the data in the first response — but the query logic lives
// in the API routes, and those routes still exist for everything the client
// does afterwards (filtering, searching, reloading after an edit).
//
// Copying the query into the page would leave two implementations of "which
// providers count", and they would drift — the home-site filter, the
// credentialing filter and the PostgREST escaping below are exactly the kind
// of detail that gets fixed in one copy and not the other. So the query lives
// here once and both callers use it.
//
// Returning a discriminated result rather than throwing lets the route keep
// answering with the status codes it always has (400 for a bad filter value,
// 500 for a failed read) without this module knowing what HTTP is.

import { PROVIDER_STATUSES, PROVIDER_TYPES } from '@/lib/validation/providers';
import { loadLastActivity, withLastActivity, type ScheduleActivityRow } from '@/lib/scheduleActivity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SchedulingClient = any;

export interface ProviderListFilters {
  orgId?: string | null;
  status?: string | null;
  providerType?: string | null;
  search?: string | null;
  homeSiteId?: string | null;
  credentialedSiteId?: string | null;
}

export type QueryResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; status: number; error: string };

/** Read every filter this module understands out of a URL's query string. */
export function providerFiltersFrom(searchParams: URLSearchParams): ProviderListFilters {
  return {
    orgId: searchParams.get('org_id'),
    status: searchParams.get('status'),
    providerType: searchParams.get('provider_type'),
    search: searchParams.get('search'),
    homeSiteId: searchParams.get('home_site_id'),
    credentialedSiteId: searchParams.get('credentialed_site_id'),
  };
}

/**
 * Providers with their employment profile attached.
 *
 * The profile is fetched separately rather than joined: PostgREST join rows
 * come back empty intermittently right after a write, which made a provider's
 * FTE vanish from the list until a reload. That behaviour is preserved here
 * exactly — this module is a move, not a rewrite.
 */
export async function listProviders(
  sb: SchedulingClient,
  f: ProviderListFilters,
): Promise<QueryResult<Record<string, unknown>>> {
  let query = sb.from('providers').select('*').order('last_name');
  if (f.orgId) query = query.eq('organization_id', f.orgId);

  if (f.status) {
    if (!(PROVIDER_STATUSES as readonly string[]).includes(f.status)) {
      return { ok: false, status: 400, error: `status must be one of: ${PROVIDER_STATUSES.join(', ')}` };
    }
    query = query.eq('status', f.status);
  }

  if (f.providerType) {
    if (!(PROVIDER_TYPES as readonly string[]).includes(f.providerType)) {
      return { ok: false, status: 400, error: `provider_type must be one of: ${PROVIDER_TYPES.join(', ')}` };
    }
    query = query.eq('provider_type', f.providerType);
  }

  if (f.search) {
    // Escape PostgREST OR-filter reserved chars so a name with a comma or a
    // paren cannot break out of the filter expression.
    const safe = f.search.replace(/[,()%]/g, ' ').trim();
    if (safe) query = query.or(`first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`);
  }

  // Credentialing and home site are DIFFERENT questions and both are offered:
  // a provider is credentialed at several sites but homed at one, so "who
  // belongs to Paoli" and "who may work at Paoli" give different answers.
  // Both resolve to an id list first, because home_site_id lives on the
  // profile table that is deliberately not joined above.
  if (f.credentialedSiteId) {
    const { data, error } = await sb
      .from('provider_site_credentials')
      .select('provider_id')
      .eq('site_id', f.credentialedSiteId)
      .eq('is_active', true)
      .eq('credentialed', true);
    if (error) return { ok: false, status: 500, error: error.message };
    const ids = (data || []).map((r: { provider_id: string }) => r.provider_id);
    if (ids.length === 0) return { ok: true, rows: [] };
    query = query.in('id', ids);
  }

  if (f.homeSiteId) {
    const { data, error } = await sb
      .from('provider_employment_profiles')
      .select('provider_id')
      .eq('home_site_id', f.homeSiteId);
    if (error) return { ok: false, status: 500, error: error.message };
    const ids = (data || []).map((r: { provider_id: string }) => r.provider_id);
    if (ids.length === 0) return { ok: true, rows: [] };
    query = query.in('id', ids);
  }

  const { data: providers, error } = await query;
  if (error) return { ok: false, status: 500, error: error.message };
  if (!providers || providers.length === 0) return { ok: true, rows: [] };

  const providerIds = (providers as Array<{ id: string }>).map(p => p.id);
  const { data: profiles } = await sb
    .from('provider_employment_profiles')
    .select('*')
    .in('provider_id', providerIds);

  const profileByProvider = new Map<string, unknown>();
  for (const prof of (profiles || []) as Array<{ provider_id: string }>) {
    profileByProvider.set(prof.provider_id, prof);
  }

  return {
    ok: true,
    rows: (providers as Array<{ id: string }>).map(p => ({
      ...p,
      provider_employment_profiles: profileByProvider.has(p.id) ? [profileByProvider.get(p.id)] : [],
    })),
  };
}

/** Sites for an organization, in display order. */
export async function listSites(
  sb: SchedulingClient,
  orgId?: string | null,
): Promise<QueryResult<Record<string, unknown>>> {
  let query = sb.from('sites').select('*').order('display_order');
  if (orgId) query = query.eq('organization_id', orgId);
  const { data, error } = await query;
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, rows: (data ?? []) as Array<Record<string, unknown>> };
}

/**
 * The one organization this deployment serves.
 *
 * Five pages used to fetch the org list over HTTP and gate their real query
 * behind it, which is a round trip to learn an id that never changes. A server
 * component resolves it in the same request as everything else.
 *
 * The result form matters here: "no organization yet" and "the organizations
 * read failed" render very differently — the first invites the user to CREATE
 * an organization (or, on /sites, to add the hospitals), so a transient failure
 * collapsed into an empty list is how a group ends up with every site entered
 * twice. Callers that need to tell them apart use this; `firstOrgId` below is
 * the convenience form for callers that do not.
 */
export async function firstOrg(sb: SchedulingClient): Promise<QueryResult<{ id: string }>> {
  const { data, error } = await sb.from('organizations').select('id').order('created_at').limit(1);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, rows: (data ?? []) as Array<{ id: string }> };
}

/** `firstOrg` flattened to an id; a failed read is indistinguishable from none. */
export async function firstOrgId(sb: SchedulingClient): Promise<string | null> {
  const result = await firstOrg(sb);
  if (!result.ok) return null;
  return result.rows[0]?.id ?? null;
}

// ── Schedules ──────────────────────────────────────────────────────────────

export interface ScheduleListFilters {
  orgId?: string | null;
  siteId?: string | null;
  status?: string | null;
  scheduleType?: string | null;
  providerGroup?: string | null;
  /** The recycle view. Off by default so EVERY existing caller excludes
   *  deleted rows without being changed — a soft delete that has to be
   *  remembered at each call site is one that eventually is not. Permission to
   *  use it is enforced separately (canSeeDeleted); this flag only asks. */
  includeDeleted?: boolean;
  /** Only the deleted ones — the recycle view proper. */
  onlyDeleted?: boolean;
}

export function scheduleFiltersFrom(searchParams: URLSearchParams): ScheduleListFilters {
  return {
    orgId: searchParams.get('org_id'),
    siteId: searchParams.get('site_id'),
    status: searchParams.get('status'),
    scheduleType: searchParams.get('schedule_type'),
    providerGroup: searchParams.get('provider_group'),
  };
}

/**
 * Schedules with `last_activity_at` folded in.
 *
 * That column is emphatically NOT `schedules.updated_at`, which only moves
 * when the row itself does — generation and grid edits write assignments. The
 * patch39 RPC folds all four sources in Postgres because this project has
 * PostgREST aggregates disabled, and it degrades to the schedule row (with a
 * warning) if the function is missing, so the list always renders.
 *
 * `warnings` is returned rather than logged here: the API route console.warns
 * them, and a server component can surface them instead of silently dropping
 * them into a log nobody reads.
 */
export async function listSchedules(
  sb: SchedulingClient,
  f: ScheduleListFilters,
): Promise<QueryResult<Record<string, unknown>> & { warnings?: string[] }> {
  let query = sb
    .from('schedules')
    .select('*, sites(name, short_name)')
    .order('date_start', { ascending: false });

  // Soft-deleted schedules are out of every list unless explicitly asked for.
  // Applied HERE, in the shared query, so the server component and the API
  // route that both render this list cannot drift from each other.
  if (f.onlyDeleted) query = query.not('deleted_at', 'is', null);
  else if (!f.includeDeleted) query = query.is('deleted_at', null);

  if (f.orgId) query = query.eq('organization_id', f.orgId);
  if (f.siteId) query = query.eq('site_id', f.siteId);
  if (f.status) query = query.eq('status', f.status);
  if (f.scheduleType) query = query.eq('schedule_type', f.scheduleType);
  if (f.providerGroup) query = query.eq('provider_group', f.providerGroup);

  const { data, error } = await query;
  if (error) return { ok: false, status: 500, error: error.message };

  const rows = (data as ScheduleActivityRow[]) || [];
  const { lastActivityById, warnings } = await loadLastActivity(sb, rows);
  return {
    ok: true,
    rows: withLastActivity(rows, lastActivityById) as unknown as Array<Record<string, unknown>>,
    warnings,
  };
}
