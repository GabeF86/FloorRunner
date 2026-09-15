// One provider's profile.
//
// Converted from a client component: it used to fetch the provider on mount,
// then gate the site list behind `provider.organization_id` — two sequential
// round trips behind every click on a provider chip, each re-entering the auth
// gate. Both reads happen here now, in the request that renders the shell.
//
// The server path is READ-ONLY by design. The API route's GET auto-heals a
// missing employment profile by inserting a default, and that stays where it
// is — but rendering a page must not write to the database, so
// readProviderDetail supplies an unsaved default in memory instead. Nothing is
// lost: PATCH upserts on UNIQUE (provider_id), so the first save creates the
// row regardless. See lib/queries/providerDetail.ts.

import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { readProviderDetail } from '@/lib/queries/providerDetail';
import { listSites } from '@/lib/queries/roster';
import ProfileClient from './ProfileClient';

// Never prerender — per-request, per-user data.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = sbSchedulingServer();

  let provider: Record<string, unknown> | null = null;
  let sites: never[] = [];
  let loadError: string | null = null;

  try {
    const detail = await readProviderDetail(sb, id);
    if (!detail.ok) {
      // A 404 is left as a null provider with no error — the client already
      // renders "provider not found" for that, and calling a missing record a
      // failure would be wrong.
      if (detail.status !== 404) loadError = detail.error;
    } else {
      provider = detail.rows[0];
      const orgId = provider.organization_id as string | undefined;
      if (orgId) {
        // Sites were the second hop of the waterfall. A failure here costs the
        // dropdowns, not the profile, so it does not set loadError.
        const s = await listSites(sb, orgId);
        if (s.ok) sites = s.rows as never[];
      }
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'Provider could not be loaded.';
  }

  return (
    <ProfileClient
      id={id}
      // The client owns the ProviderDetail shape and normalizes jsonb columns
      // itself; this is the same payload its fetch used to receive.
      initialProvider={provider as never}
      initialSites={sites}
      initialLoadError={loadError}
    />
  );
}
