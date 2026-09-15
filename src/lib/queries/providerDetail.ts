// One provider, with their employment profile and site credentials.
//
// ── WHY THIS IS SEPARATE FROM THE ROUTE ────────────────────────────────────
// The GET at /api/scheduling/providers/[id] AUTO-HEALS: if a provider has no
// employment profile row, it inserts a default one. That exists for a real
// reason — a PostgREST join used to return an empty relationship array, the
// old code read that as "no profile", and it silently overwrote saved profiles
// — and it stays exactly where it is.
//
// But a server component must not perform that insert, because rendering a
// page is not a thing that should write to the database. So the server path
// READS, and supplies an unsaved default in memory when the row is missing.
//
// Nothing is lost by that: PATCH upserts on the UNIQUE (provider_id)
// constraint, so the first save creates the row regardless, and the route's
// heal still runs for every client-side reload. The UI cannot crash on a
// missing profile either way, which was the original point.

import type { QueryResult, SchedulingClient } from './roster';

/**
 * What a provider with no profile row looks like on screen.
 *
 * Deliberately carries NO `id` — it is not a database row and should not be
 * mistaken for one. Verified that nothing in the profile UI reads the
 * profile's id; it reads `provider_employment_profiles[0]` as a whole.
 */
export const UNSAVED_PROFILE_DEFAULTS = {
  employment_status: 'full_time',
  call_taker: false,
} as const;

export interface ProviderDetailRow extends Record<string, unknown> {
  provider_employment_profiles: Array<Record<string, unknown>>;
  provider_site_credentials: Array<Record<string, unknown>>;
}

/**
 * The three pieces, fetched separately rather than joined.
 *
 * Joining here was unreliable: PostgREST would intermittently return an empty
 * relationship array right after a write. That is the same reason the list
 * query attaches profiles in application code.
 */
export async function readProviderDetail(
  sb: SchedulingClient,
  id: string,
): Promise<QueryResult<ProviderDetailRow>> {
  const [providerRes, profileRes, credsRes] = await Promise.all([
    sb.from('providers').select('*').eq('id', id).single(),
    sb.from('provider_employment_profiles').select('*').eq('provider_id', id).maybeSingle(),
    sb
      .from('provider_site_credentials')
      .select('*, sites:site_id(id, name, short_name)')
      .eq('provider_id', id),
  ]);

  if (providerRes.error) {
    // PGRST116 is "no rows" for .single() — a missing provider is a 404, not a
    // server fault, and the page renders "not found" rather than an error.
    const status = providerRes.error.code === 'PGRST116' ? 404 : 500;
    return { ok: false, status, error: providerRes.error.message };
  }

  const profile = profileRes.data ?? { provider_id: id, ...UNSAVED_PROFILE_DEFAULTS };

  return {
    ok: true,
    rows: [{
      ...(providerRes.data as Record<string, unknown>),
      provider_employment_profiles: [profile as Record<string, unknown>],
      provider_site_credentials: (credsRes.data ?? []) as Array<Record<string, unknown>>,
    }],
  };
}
