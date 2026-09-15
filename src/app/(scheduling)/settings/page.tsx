// Organization settings — the provider custom-field definitions.
//
// This page used to be the client component that now lives in
// SettingsClient.tsx. The HTML arrived empty, the browser hydrated, fetched the
// organization list, and only THEN — gated behind that id — fetched the custom
// fields and the sites that scope them. Two serial round trips before a single
// row appeared, each one re-entering the auth gate on the way.
//
// Now the reads happen here, in the same request that renders the shell, using
// the service client directly: no HTTP hop, no second pass through the
// middleware, and the first response already contains the rows. The client
// component keeps every interactive path it had (the "show inactive" toggle,
// add/edit/delete and the reload after each) — it simply starts with data.
//
// Query logic is shared with /api/scheduling/custom-fields and
// /api/scheduling/sites via lib/queries, so the list rendered here and the list
// fetched after a toggle cannot disagree.

import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { firstOrg, listSites } from '@/lib/queries/roster';
import { listCustomFields } from '@/lib/queries/config';
import SettingsClient, { type SettingsClientProps } from './SettingsClient';

// Never prerender — this reads per-request, per-user data.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function SettingsPage() {
  const sb = sbSchedulingServer();

  let orgId = '';
  let customFields: SettingsClientProps['initialCustomFields'] = [];
  let sites: SettingsClientProps['initialSites'] = [];
  let loadError: string | null = null;

  try {
    // firstOrg rather than firstOrgId: the client distinguishes "create an
    // organization first" from a failed read, and only the first of those is a
    // successful empty result.
    const org = await firstOrg(sb);
    if (!org.ok) loadError = org.error;
    else orgId = org.rows[0]?.id ?? '';

    if (orgId) {
      // The two reads are independent, so they overlap rather than queue.
      const [cf, s] = await Promise.all([
        // includeInactive false mirrors the client's initial toggle — the
        // server must render the same list the client believes it is showing,
        // or ticking the box would appear to change something it did not.
        listCustomFields(sb, { orgId, includeInactive: false }),
        listSites(sb, orgId),
      ]);

      if (!cf.ok) loadError = cf.error;
      else customFields = cf.rows as unknown as SettingsClientProps['initialCustomFields'];

      // A failed SITES read only costs the "Scope — Sites" picker inside the
      // modal, so it must not blank the field list.
      if (s.ok) sites = s.rows as unknown as SettingsClientProps['initialSites'];
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'Settings could not be loaded.';
  }

  return (
    <SettingsClient
      initialCustomFields={customFields}
      initialSites={sites}
      orgId={orgId}
      loadError={loadError}
    />
  );
}
