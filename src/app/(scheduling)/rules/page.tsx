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
import { listRuleSets, listRuleDefinitions, listShiftTypes, readActiveCallPattern } from '@/lib/queries/config';
import RulesClient, { type RulesClientProps } from './RulesClient';
import SchedulingLogicCard from './SchedulingLogicCard';
import type { ShiftTypeFacts } from '@/lib/schedulingLogic';
import type { CallPatternDoc } from '@/lib/rulesEngine/callPattern';

// Never prerender — this reads per-request, per-user data.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function RulesPage(
  { searchParams }: { searchParams: Promise<{ site?: string }> },
) {
  const sb = sbSchedulingServer();
  const { site: siteParam } = await searchParams;

  let orgId = '';
  let ruleSets: RulesClientProps['initialRuleSets'] = [];
  let sites: RulesClientProps['initialSites'] = [];
  let loadError: string | null = null;

  let selectedSiteId: string | null = null;
  let selectedSiteName: string | null = null;
  let doc: CallPatternDoc | null = null;
  let usingFallback = false;
  let patternName: string | null = null;
  let shiftTypes: ShiftTypeFacts[] = [];
  let parLevel: number | null = null;
  let logicError: string | null = null;

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

      // ── The scheduling-logic view ──
      // Defaults to the first site rather than to nothing: a page whose main
      // content only appears after a click reads as broken.
      const siteList = sites.map(x => ({ id: x.id, name: x.name }));
      selectedSiteId = siteParam && siteList.some(x => x.id === siteParam)
        ? siteParam
        : (siteList[0]?.id ?? null);
      selectedSiteName = siteList.find(x => x.id === selectedSiteId)?.name ?? null;

      if (selectedSiteId) {
        const [pattern, types, siteRow] = await Promise.all([
          readActiveCallPattern(sb, selectedSiteId),
          listShiftTypes(sb, selectedSiteId),
          sb.from('sites').select('call_par_level').eq('id', selectedSiteId).maybeSingle(),
        ]);
        if (!pattern.ok) {
          logicError = pattern.error;
        } else {
          doc = pattern.doc;
          usingFallback = pattern.usingFallback;
          patternName = pattern.name;
        }
        // A failed shift-type read costs the post-call section only; the rest
        // of the description is still true and still worth showing.
        if (types.ok) shiftTypes = types.rows as unknown as ShiftTypeFacts[];
        const par = (siteRow.data as { call_par_level?: number } | null)?.call_par_level;
        parLevel = typeof par === 'number' ? par : null;
      }
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : 'Rule sets could not be loaded.';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      {/* The generation contract comes FIRST. The rule sets below check a
          finished schedule and are not consulted while one is built, so
          leading with them put the one thing the engine does not read at the
          top of the page called Rules. */}
      <SchedulingLogicCard
        sites={sites.map(s => ({ id: s.id, name: s.name }))}
        selectedSiteId={selectedSiteId}
        selectedSiteName={selectedSiteName}
        doc={doc}
        usingFallback={usingFallback}
        patternName={patternName}
        shiftTypes={shiftTypes}
        parLevel={parLevel}
        error={logicError}
      />
      <RulesClient
        initialRuleSets={ruleSets}
        initialSites={sites}
        orgId={orgId}
        loadError={loadError}
      />
    </div>
  );
}
