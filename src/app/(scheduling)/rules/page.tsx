// The scheduling-logic page.
//
// This used to be a rule-set index: a CRUD list over `rule_definitions`, plus
// the two things below it. The rule feature is gone — every definition was
// inactive and validation never loaded them — so what is left is the part that
// describes and edits the contract the generator actually obeys: the site's
// call pattern.
//
// The reads happen here, in the same request that renders the shell, using the
// service client directly: no HTTP hop, no second pass through the middleware,
// and the first response already contains the data. Query logic is shared with
// lib/queries so the page and the routes cannot disagree.

import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { firstOrg, listSites } from '@/lib/queries/roster';
import { listShiftTypes, readActiveCallPattern } from '@/lib/queries/config';
import SchedulingLogicCard from './SchedulingLogicCard';
import PatternEditor from './PatternEditor';
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

  let sites: Array<{ id: string; name: string }> = [];
  let selectedSiteId: string | null = null;
  let selectedSiteName: string | null = null;
  let doc: CallPatternDoc | null = null;
  let usingFallback = false;
  let patternName: string | null = null;
  let shiftTypes: ShiftTypeFacts[] = [];
  let parLevel: number | null = null;
  let previousPattern: { id: string; name: string | null; createdAt: string } | null = null;
  // One error channel, surfaced by the card. A failed org/site read must not
  // render as "this group has no sites" — an empty page that looks deliberate
  // is the failure mode this page exists to avoid.
  let logicError: string | null = null;

  // Read on the SERVER so the key itself never reaches the browser — only
  // whether one exists.
  const hasModelKey = (process.env.ANTHROPIC_API_KEY ?? '').trim().length > 0;

  try {
    // firstOrg rather than firstOrgId: a failed organizations read must be
    // reported, not collapsed into an empty site list.
    const org = await firstOrg(sb);
    if (!org.ok) logicError = org.error;
    const orgId = org.ok ? (org.rows[0]?.id ?? '') : '';

    if (orgId) {
      const s = await listSites(sb, orgId);
      if (!s.ok) logicError = s.error;
      else sites = (s.rows as unknown as Array<{ id: string; name: string }>)
        .map(x => ({ id: x.id, name: x.name }));

      // ── The scheduling-logic view ──
      // Defaults to the first site rather than to nothing: a page whose main
      // content only appears after a click reads as broken.
      selectedSiteId = siteParam && sites.some(x => x.id === siteParam)
        ? siteParam
        : (sites[0]?.id ?? null);
      selectedSiteName = sites.find(x => x.id === selectedSiteId)?.name ?? null;

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

        // The most recent archived pattern — what "go back" would restore.
        // replaceActivePattern archives on every write, so this exists as soon
        // as the site has been edited once, with no bespoke undo table.
        const { data: prior } = await sb
          .from('call_patterns')
          .select('id, name, created_at')
          .eq('site_id', selectedSiteId)
          .eq('status', 'archived')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const row = prior as { id: string; name: string | null; created_at: string } | null;
        previousPattern = row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
        const par = (siteRow.data as { call_par_level?: number } | null)?.call_par_level;
        parLevel = typeof par === 'number' ? par : null;
      }
    }
  } catch (e) {
    logicError = e instanceof Error ? e.message : 'The scheduling logic could not be loaded.';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      {/* The editor sits under the description on purpose: you read what the
          site does now, then change it. Reversing that order invites editing
          something you have not looked at. */}
      <SchedulingLogicCard
        sites={sites}
        selectedSiteId={selectedSiteId}
        selectedSiteName={selectedSiteName}
        doc={doc}
        usingFallback={usingFallback}
        patternName={patternName}
        shiftTypes={shiftTypes}
        parLevel={parLevel}
        error={logicError}
      />
      {selectedSiteId && selectedSiteName && !logicError && (
        <PatternEditor
          siteId={selectedSiteId}
          siteName={selectedSiteName}
          // What the page rendered. Apply compares this against what is live
          // and refuses if someone else changed the pattern in between, so a
          // change can never land on a document the reviewer never saw.
          baselineFingerprint={JSON.stringify(doc ?? null)}
          // The text box is hidden rather than shown-and-broken when the
          // deployment has no model key. A group without an LLM subscription
          // still gets everything else on this page.
          available={hasModelKey}
          previous={previousPattern}
        />
      )}
    </div>
  );
}
