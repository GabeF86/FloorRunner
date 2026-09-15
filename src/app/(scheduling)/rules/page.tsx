// The rule-set index.
//
// This page used to be the client component that now lives in RulesClient.tsx.
// The HTML arrived empty, the browser hydrated, fetched the organization list,
// and only THEN — gated behind that id — fetched the rule sets and sites, and
// only after those had landed did it fetch the rule definitions it counts per
// row. Three serial round trips before a single rule set appeared.
//
// Now the reads happen here, in the same request that renders the shell, using
// the service client directly: no HTTP hop, no second pass through the
// middleware, and the first response already contains the rows. The client
// component keeps every interactive path it had (the status filter, creating a
// rule set, reloading afterwards) — it simply starts with data.
//
// Query logic is shared with /api/scheduling/rule-sets,
// /api/scheduling/rule-definitions and /api/scheduling/sites via lib/queries,
// so the list rendered here and the list fetched after a create cannot
// disagree.

import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { firstOrg, listSites } from '@/lib/queries/roster';
import { listRuleSets, listRuleDefinitions } from '@/lib/queries/config';
import RulesClient, { type RulesClientProps } from './RulesClient';

// Never prerender — this reads per-request, per-user data.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function RulesPage() {
  const sb = sbSchedulingServer();

  let orgId = '';
  let ruleSets: RulesClientProps['initialRuleSets'] = [];
  let sites: RulesClientProps['initialSites'] = [];
  let loadError: string | null = null;

  try {
    // firstOrg rather than firstOrgId: a failed organizations read must not
    // collapse into "this group has no rule sets", which is the view that
    // offers to create one.
    const org = await firstOrg(sb);
    if (!org.ok) loadError = org.error;
    else orgId = org.rows[0]?.id ?? '';

    if (orgId) {
      // Three independent reads, so they overlap rather than queue. No status
      // filter is passed: the client's filter chips start at 'all' and narrow
      // the list they already hold, so the server must send all of them.
      const [rs, s, defs] = await Promise.all([
        listRuleSets(sb, { orgId }),
        listSites(sb, orgId),
        // Every definition at once, bucketed per rule set below — one read
        // instead of one per row, exactly as the client did it.
        listRuleDefinitions(sb),
      ]);

      if (!rs.ok) {
        loadError = rs.error;
      } else {
        // A failed DEFINITIONS read leaves every count at zero, which is what
        // the client did too — the rule sets themselves still render.
        const allDefs = defs.ok
          ? (defs.rows as unknown as Array<{ id: string; rule_set_id: string }>)
          : [];
        ruleSets = (rs.rows as unknown as RulesClientProps['initialRuleSets']).map(r => ({
          ...r,
          rule_definitions: allDefs.filter(d => d.rule_set_id === r.id),
        }));
      }

      // A failed SITES read only costs the site column and the create modal's
      // picker, so it must not blank the rule sets.
      if (s.ok) sites = s.rows as unknown as RulesClientProps['initialSites'];
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'Rule sets could not be loaded.';
  }

  return (
    <RulesClient
      initialRuleSets={ruleSets}
      initialSites={sites}
      orgId={orgId}
      loadError={loadError}
    />
  );
}
