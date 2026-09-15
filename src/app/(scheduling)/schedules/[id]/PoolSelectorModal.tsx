'use client';

/* ── Pool Selector overlay ───────────────────────────────────────────────────
 * DYNAMICALLY IMPORTED (next/dynamic, ssr: false) by the schedule grid page.
 * It renders only behind `showPoolModal`. Splitting it out also gets the
 * Block Targets tab off the critical path: BlockTargetsTab pulls in
 * lib/blockTargets, which imports BUCKET_KEYS from paoliBlock/manifest and so
 * drags ZOD into whatever bundle contains it. That cost now lands on the click
 * that opens this modal instead of on every grid paint.
 *
 * `ssr: false` is correct: a click-gated modal that fetches its own stored
 * limits and manifest on mount.
 *
 * Moved verbatim out of page.tsx — same props, same logic, same rendering.
 * ───────────────────────────────────────────────────────────────────────── */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
// Type-only: the grid route parses the site's active pattern server-side and
// ships the validated doc, so zod stays out of this bundle on that account.
import type { CallPatternDoc } from '@/lib/rulesEngine/callPattern';
// Provider limits (2026-07-22, patch34): the Limits tab edits
// schedules.provider_limits through the single-homed shape/parse/field
// helpers — the same parser the PATCH route enforces.
import {
  parseProviderLimits, fieldsFromEntry, entryFromFields, normalizeProviderLimits,
  isInvalidLimitInput, EMPTY_LIMIT_FIELDS,
  type ProviderLimits, type LimitFields,
} from '@/lib/providerLimits';
// Block Targets (2026-07-27): the third tab writes schedules.scenario_manifest
// — the per-provider, per-block call targets the engine's scenario layer
// already honors. Derivation, resolution, the linkage grammar and the manifest
// build are single-homed in blockTargets.ts; the panel's own view logic sits in
// blockTargetsPanel.ts with its test.
import {
  bucketSlotCounts, buildBlockManifest, statedProviders,
  type BlockSlot, type DerivationBasis,
} from '@/lib/blockTargets';
import {
  buildPanelRows, cellTextFromRows, invalidCellKeys, rowsWithCellText,
  strandedEdits, targetEditFingerprint, targetWritePlan,
  type PanelRow, type PoolMember,
} from '@/lib/blockTargetsPanel';
import { BlockTargetsTab } from './BlockTargetsTab';
import { Button } from '@/components/ui';
import { type Provider, type EmploymentProfile } from './gridShared';

/* ── Pool Selector Modal ─────────────────────────────────────────────────────
 * Lets the user hand-pick which providers are eligible for auto-generation
 * on this schedule. Saved on the schedule row as `included_provider_ids`.
 * Null / empty array = use the default rule-based pool (home-site call-
 * takers for call, home-site Day Docs for day shifts). A non-empty array
 * NARROWS both pools (Gabriel 2026-07-21): each engine intersects the list
 * with its role criterion (call_taker/partial for call gen; is_day_doc or a
 * live PTO sell-back covering the date for day gen) — only the home-site
 * gate is skipped. It never widens eligibility.
 * ───────────────────────────────────────────────────────────────────────── */
export function PoolSelectorModal({
  scheduleId,
  scheduleSiteId,
  orgId,
  providers,
  profiles,
  initialSelection,
  blockSlots,
  parLevel,
  neuroWeekend,
  scheduleLabel,
  blockStartYear,
  onClose,
  onSaved,
}: {
  scheduleId: string;
  scheduleSiteId: string;
  orgId: string;
  providers: Provider[];
  profiles: EmploymentProfile[];
  initialSelection: string[] | null;
  // ── Block Targets tab inputs (the wiring the data layer specifies) ────────
  // The stored manifest is NOT in the grid payload — it is fetched below off
  // GET /schedules/:id, alongside provider_limits, in ONE request.
  blockSlots: BlockSlot[];
  parLevel: number;
  neuroWeekend: NonNullable<CallPatternDoc['neuroWeekend']> | null;
  scheduleLabel: string;
  blockStartYear: number;
  onClose: () => void;
  onSaved: (next: string[] | null) => void;
}) {
  // Sites are loaded lazily so the button-click latency stays low. Grouping
  // everyone by home_site_id requires site display names for the headings.
  const [sites, setSites] = useState<Array<{ id: string; name: string; short_name: string | null }>>([]);
  const [sitesLoaded, setSitesLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Limits tab (2026-07-22, patch34 provider_limits) ───────────────────────
  // Per-provider block limits: expected max of each call type (C1/C2/C3) and
  // EITHER expected working days OR expected days off (mutually exclusive —
  // filling one clears/disables the other). Blank everywhere = no limit (the
  // engine keeps its FTE-derived budget — Gabriel's verbatim rule). Stored on
  // the schedule row; fetched here lazily because the grid payload doesn't
  // carry the column (and pre-patch34 DBs simply omit the field — graceful).
  const [tab, setTab] = useState<'pool' | 'limits' | 'targets'>('pool');
  const [storedLimits, setStoredLimits] = useState<ProviderLimits>({});
  const [limitDrafts, setLimitDrafts] = useState<Record<string, LimitFields>>({});
  // 'loading' → inputs held; 'ready' → editable; 'failed' → tab shows the
  // error and SAVE OMITS the provider_limits key entirely (never clobber
  // stored limits with an empty map because a fetch failed).
  const [limitsState, setLimitsState] = useState<'loading' | 'ready' | 'failed'>('loading');

  // ── Block Targets tab (2026-07-27, patch37 scenario_manifest) ─────────────
  // Same load/save discipline as Limits: the stored artifact rides in on the
  // SAME GET, and a failed fetch means the save OMITS the key entirely rather
  // than clobbering a stored manifest with an empty one. Unlike Limits, the
  // key is written only when he actually edited in this tab (`targetsDirty`):
  // a manifest is a large artifact with real engine consequences, so changing
  // the pool and pressing Save must never silently rewrite one.
  const [manifestState, setManifestState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [storedManifest, setStoredManifest] = useState<unknown>(null);
  const [cellText, setCellText] = useState<Record<string, string>>({});
  const [linkageEdits, setLinkageEdits] = useState<Record<string, PanelRow['linkages']>>({});
  const [importAcknowledged, setImportAcknowledged] = useState(false);
  const [clearTargets, setClearTargets] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scheduling/schedules/${scheduleId}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(data => {
        if (cancelled) return;
        const parsed = parseProviderLimits((data as { provider_limits?: unknown })?.provider_limits);
        const lim = parsed.ok && parsed.value ? parsed.value : {};
        setStoredLimits(lim);
        const drafts: Record<string, LimitFields> = {};
        for (const [pid, entry] of Object.entries(lim)) drafts[pid] = fieldsFromEntry(entry);
        setLimitDrafts(drafts);
        setLimitsState('ready');
        setStoredManifest((data as { scenario_manifest?: unknown })?.scenario_manifest ?? null);
        setManifestState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setLimitsState('failed');
        setManifestState('failed');
      });
    return () => { cancelled = true; };
  }, [scheduleId]);

  const setLimitField = (pid: string, field: keyof LimitFields, value: string) => {
    setLimitDrafts(prev => {
      const cur = prev[pid] ?? EMPTY_LIMIT_FIELDS;
      const next: LimitFields = { ...cur, [field]: value };
      // Mutual exclusion: filling Working Days clears Days Off and vice versa.
      if (field === 'workingDays' && value.trim() !== '') next.daysOff = '';
      if (field === 'daysOff' && value.trim() !== '') next.workingDays = '';
      return { ...prev, [pid]: next };
    });
  };

  const hasInvalidLimit = Object.values(limitDrafts).some(f =>
    [f.c1, f.c2, f.c3, f.workingDays, f.daysOff].some(isInvalidLimitInput));

  // Rebuild the stored map from drafts (edited rows) + untouched stored
  // entries. Out-of-pool entries render inert below and round-trip unchanged.
  const buildLimitsPayload = (): ProviderLimits | null => {
    const out: ProviderLimits = {};
    const pids = new Set([...Object.keys(storedLimits), ...Object.keys(limitDrafts)]);
    for (const pid of pids) {
      const fields = limitDrafts[pid];
      const entry = fields ? entryFromFields(fields, storedLimits[pid]) : storedLimits[pid];
      if (entry) out[pid] = entry;
    }
    return normalizeProviderLimits(out);
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scheduling/sites?org_id=${orgId}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        setSites(Array.isArray(data) ? data : []);
        setSitesLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setSitesLoaded(true);
      });
    return () => { cancelled = true; };
  }, [orgId]);

  // Map provider_id → home_site_id for fast lookup during grouping.
  const homeSiteByPid = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of profiles) m.set(p.provider_id, p.home_site_id);
    return m;
  }, [profiles]);

  // Default-pool eligibility by provider — the SAME criterion the generation
  // engine's default path enforces (genContext.ts §3): a full OR partial call
  // taker who is NOT a day doc and NOT per-diem. Day docs and per-diem
  // providers are never auto-selected into a new schedule's pool (Gabriel
  // 2026-09-06); they can still be added by hand below (which builds a custom
  // override pool) or placed directly on the grid.
  const poolEligibleByPid = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const p of profiles) {
      const isCallTaker = !!p.call_taker || !!p.partial_call_taker;
      const excluded = p.is_day_doc === true || p.employment_status === 'per_diem';
      m.set(p.provider_id, isCallTaker && !excluded);
    }
    return m;
  }, [profiles]);

  // Default selection = exactly whatever the current auto-gen rules would
  // pick: home_site_id === this schedule's site_id AND default-pool eligible.
  // (Home-site alone is NOT the engine's default — matching it here keeps the
  // modal's "default"/"Reset to Default" from diverging from what generation
  // actually runs.) If initialSelection is null we start with this; if it's
  // set we start with whatever was saved.
  const defaultSelection = useMemo(() => {
    const ids = new Set<string>();
    for (const p of providers) {
      if (homeSiteByPid.get(p.id) === scheduleSiteId && poolEligibleByPid.get(p.id)) ids.add(p.id);
    }
    return ids;
  }, [providers, homeSiteByPid, poolEligibleByPid, scheduleSiteId]);

  const [checked, setChecked] = useState<Set<string>>(() => {
    if (initialSelection && initialSelection.length > 0) return new Set(initialSelection);
    return new Set(defaultSelection);
  });

  // Groups: map site_id (or '__none') → list of providers. Sorted by the
  // schedule's own site first (since it's the common case), then by site
  // short_name, then "Unassigned" last.
  const groups = useMemo(() => {
    const bySite = new Map<string, Provider[]>();
    for (const p of providers) {
      const site = homeSiteByPid.get(p.id) || '__none';
      const list = bySite.get(site) || [];
      list.push(p);
      bySite.set(site, list);
    }
    for (const list of bySite.values()) {
      list.sort((a, b) => a.last_name.localeCompare(b.last_name));
    }
    const siteName = (id: string): string => {
      if (id === '__none') return '(No home site)';
      const s = sites.find(x => x.id === id);
      return s ? (s.short_name || s.name) : '(Unknown site)';
    };
    const entries = Array.from(bySite.entries()).map(([siteId, list]) => ({
      siteId, siteName: siteName(siteId), providers: list,
    }));
    entries.sort((a, b) => {
      if (a.siteId === scheduleSiteId) return -1;
      if (b.siteId === scheduleSiteId) return 1;
      if (a.siteId === '__none') return 1;
      if (b.siteId === '__none') return -1;
      return a.siteName.localeCompare(b.siteName);
    });
    return entries;
  }, [providers, homeSiteByPid, sites, scheduleSiteId]);

  const toggle = (pid: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  };

  const toggleGroup = (groupIds: string[]) => {
    setChecked(prev => {
      const next = new Set(prev);
      const allSelected = groupIds.every(id => next.has(id));
      if (allSelected) groupIds.forEach(id => next.delete(id));
      else groupIds.forEach(id => next.add(id));
      return next;
    });
  };

  const resetToDefault = () => setChecked(new Set(defaultSelection));
  const clearAll = () => setChecked(new Set());

  // ── Block Targets derived state ──────────────────────────────────────────
  const profileByPid = useMemo(() => {
    const m = new Map<string, EmploymentProfile>();
    for (const p of profiles) m.set(p.provider_id, p);
    return m;
  }, [profiles]);

  // The CALL pool, which is what block targets are about: the pool selection
  // intersected with the call-taker criterion, exactly the way the engine
  // narrows it (pool selection NARROWS, never widens — 2026-07-21). Day docs
  // in the pool have no call targets and would only be noise here.
  const poolMembersFor = useCallback((ids: ReadonlySet<string>): PoolMember[] => providers
    .filter(p => ids.has(p.id))
    .filter(p => {
      const prof = profileByPid.get(p.id);
      return !!(prof?.call_taker || prof?.partial_call_taker);
    })
    .sort((a, b) => a.last_name.localeCompare(b.last_name))
    .map(p => ({
      providerId: p.id,
      displayName: p.last_name || p.short_display_name,
      // genContext's coercion (`fte_value || 1`), NOT the page's display `?? 1`:
      // this number is written as the manifest's scenarioFte, which OVERRIDES
      // fte_value for the generation. Coercing differently here would let a 0
      // or null profile FTE reach the engine as a real 0 and zero every target.
      profileFte: profileByPid.get(p.id)?.fte_value || 1,
    })), [providers, profileByPid]);

  const nameForPid = useCallback((pid: string): string | null => {
    const p = providers.find(x => x.id === pid);
    return p ? (p.last_name || p.short_display_name) : null;
  }, [providers]);

  const callPool: PoolMember[] = useMemo(
    () => poolMembersFor(checked), [poolMembersFor, checked]);

  // The wiring the data layer specifies: weighted per-bucket capacity from the
  // block's own slots, the STORED par (authoritative — never clamped to the
  // pool's ΣFTE), and the site pattern's neuro bands.
  const targetsBasis: DerivationBasis = useMemo(() => ({
    // The site's OWN neuro code, not the C1/C2/C3 default: a site whose
    // neuroWeekend.code is not 'C3' would otherwise have every neuro slot fall
    // out of the census, NEURO_FSS capacity read 0, and the feasibility strip
    // report a permanently over-constrained bucket on a perfectly feasible block.
    slotCounts: bucketSlotCounts(blockSlots, { neuroCode: neuroWeekend?.code }),
    parLevel,
    neuro: neuroWeekend,
  }), [blockSlots, parLevel, neuroWeekend]);

  const panelRows = useMemo(
    () => buildPanelRows({ pool: callPool, storedManifest, nameFor: nameForPid }),
    [callPool, storedManifest, nameForPid]);

  // The rows a save would write for an ARBITRARY pool selection. "Use Default
  // Pool" discards the current selection, so the manifest it writes must
  // describe the DEFAULT pool — not the one being thrown away.
  const liveRowsForSelection = useCallback((ids: ReadonlySet<string>): PanelRow[] => {
    const base = buildPanelRows({
      pool: poolMembersFor(ids), storedManifest, nameFor: nameForPid,
    });
    const withLinkages = base.rows.map(r => (linkageEdits[r.providerId]
      ? { ...r, linkages: linkageEdits[r.providerId] }
      : r));
    return rowsWithCellText(withLinkages, cellText);
  }, [poolMembersFor, storedManifest, nameForPid, linkageEdits, cellText]);

  // Rows are DERIVED (pool + stored manifest + his linkage edits) rather than
  // held in state, so toggling the pool on the Pool tab can never leave a
  // stale row behind. cellText is keyed by provider id and survives on its own.
  const targetRows: PanelRow[] = useMemo(
    () => panelRows.rows.map(r => (linkageEdits[r.providerId]
      ? { ...r, linkages: linkageEdits[r.providerId] }
      : r)),
    [panelRows, linkageEdits]);

  const liveTargetRows = useMemo(
    () => rowsWithCellText(targetRows, cellText), [targetRows, cellText]);

  // Seed the typed cells ONCE, when the stored manifest lands. Re-seeding on
  // every rebuild would overwrite whatever he is in the middle of typing. The
  // signature taken here is what "dirty" is measured against.
  const targetsSeeded = useRef(false);
  const seededFingerprint = useRef<string>('');
  useEffect(() => {
    if (manifestState !== 'ready' || targetsSeeded.current) return;
    targetsSeeded.current = true;
    const seeded = cellTextFromRows(panelRows.rows);
    seededFingerprint.current = targetEditFingerprint(panelRows.rows, seeded);
    setCellText(seeded);
  }, [manifestState, panelRows]);

  // Dirty by COMPARISON, never a latch: typing a value and deleting it again
  // must leave the panel disarmed, because writing a manifest states a hard
  // ceiling for every provider in it — not only the ones he touched.
  const targetsDirty = targetsSeeded.current
    && targetEditFingerprint(targetRows, cellText) !== seededFingerprint.current;

  // Only cells belonging to a RENDERED row can block the save — an invalid
  // cell for a provider who has since left the pool is nowhere to fix.
  const visibleTargetIds = useMemo(
    () => new Set(targetRows.map(r => r.providerId)), [targetRows]);
  const invalidTargetCells = useMemo(
    () => invalidCellKeys(cellText, visibleTargetIds), [cellText, visibleTargetIds]);

  // Edits the pool selection has stranded — reported, never dropped in silence.
  const strandedTargetEdits = useMemo(
    () => strandedEdits(targetRows, cellText), [targetRows, cellText]);

  // Built from exactly the rows the panel shows, so what he reviews is what
  // gets written (only `generatedAt` is refreshed at save time).
  const targetsManifestErrors = useMemo(() => {
    if (manifestState !== 'ready' || clearTargets) return [];
    return buildBlockManifest({
      providers: liveTargetRows, basis: targetsBasis,
      scheduleLabel, defaultYear: blockStartYear,
    }).errors;
  }, [manifestState, clearTargets, liveTargetRows, targetsBasis, scheduleLabel, blockStartYear]);

  // How many rows would actually be written — only the ones with something
  // stated (blockTargets.statedProviders). Zero means the save stores NOTHING
  // rather than an empty manifest.
  const statedTargetCount = useMemo(
    () => statedProviders(liveTargetRows).written.length, [liveTargetRows]);

  // The whole scenario_manifest decision, single-homed and tested.
  const targetPlan = targetWritePlan({
    manifestState,
    dirty: targetsDirty,
    clearRequested: clearTargets,
    imported: panelRows.imported,
    unreadable: panelRows.unreadable,
    importAcknowledged,
    invalidCellCount: invalidTargetCells.length,
    manifestErrors: targetsManifestErrors,
    statedProviderCount: statedTargetCount,
  });
  const wantsTargetWrite = targetPlan.write !== 'omit';
  const targetsBlocked = targetPlan.blocked !== null;

  const commitTargetRows = (next: PanelRow[]) => {
    const edits: Record<string, PanelRow['linkages']> = {};
    for (const r of next) edits[r.providerId] = r.linkages ?? [];
    setLinkageEdits(edits);
    setClearTargets(false);
  };
  const editCellText = (next: Record<string, string>) => {
    setCellText(next);
    setClearTargets(false);
  };

  const save = async (asDefault: boolean) => {
    setSaving(true); setError(null);
    try {
      // Passing null (not []) is the signal to the server/UI that the
      // default rules should apply. A stored empty array would be
      // indistinguishable from "you deselected everyone" — which is a
      // valid but nonsensical state we don't need to represent.
      const payload: string[] | null = asDefault ? null : Array.from(checked);
      // Limits ride along on BOTH saves (they are keyed to providers, not the
      // pool — resetting to the default pool keeps them; out-of-pool entries
      // render inert but survive). If the limits fetch failed the key is
      // OMITTED so a network blip can never clobber stored limits. It is ALSO
      // omitted for a null→null no-op (nothing stored, nothing entered):
      // pre-patch34 the provider_limits column doesn't exist, and riding a
      // no-op null along would 500 the WHOLE pool save on the missing column
      // (review fix 2026-07-22). Clearing previously-stored limits still
      // sends null (storedLimits non-empty then).
      const body: Record<string, unknown> = { included_provider_ids: payload };
      if (limitsState === 'ready') {
        const limitsPayload = buildLimitsPayload();
        if (limitsPayload !== null || Object.keys(storedLimits).length > 0) {
          body.provider_limits = limitsPayload;
        }
      }
      // Block targets ride along too, but ONLY when he edited them in the tab
      // (or asked to clear them). A manifest steers the whole generation, so a
      // pool-only save must leave a stored one exactly as it was. A failed
      // fetch omits the key for the same reason the limits one does.
      if (targetPlan.write === 'clear') {
        body.scenario_manifest = null;
      } else if (targetPlan.write === 'manifest') {
        const built = buildBlockManifest({
          providers: liveRowsForSelection(asDefault ? defaultSelection : checked),
          basis: targetsBasis,
          scheduleLabel,
          defaultYear: blockStartYear,
        });
        // The plan was computed from the CURRENT selection; "save as default"
        // rebuilds from a different one, which can leave nothing stated. An
        // empty providers[] steers nobody and reads back as unreadable, so
        // store null instead — the same thing targetWritePlan decides when it
        // can see the count.
        body.scenario_manifest = built.providers.length > 0 ? built : null;
      }
      const res = await fetch(`/api/scheduling/schedules/${scheduleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed (${res.status})`);
        return;
      }
      onSaved(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  const totalSelected = checked.size;
  const totalAvailable = providers.length;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'var(--bg-modal-backdrop)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
        animation: 'fr-backdrop-in var(--dur-fast) var(--ease-out)',
      }}
    >
      <div
        className="modal-box"
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-modal)',
          padding: 'var(--space-6)',
          // The targets grid carries up to nine numeric columns plus a name —
          // it cannot be read at the 560 the other two tabs use.
          width: tab === 'targets' ? 'min(940px, 96vw)' : 560,
          maxHeight: '85vh', display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-strong)' }}>Select Pool of Physicians</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Auto-Generate will consider only the checked providers.
              Eligibility filters (credentials, availability, weekday) still apply.
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {totalSelected} / {totalAvailable} selected
          </div>
        </div>

        {/* Tabs: Pool (the existing checkbox roster) | Limits (per-provider
            expected call counts + working days / days off for this block) |
            Block Targets (per-provider, per-bucket call targets → the engine's
            scenario manifest). */}
        {/* Tab strip. .fr-seg is the system's "row of buttons, one of them on":
            it holds the UNSELECTED look (transparent ground, muted text) in
            CSS, which is the only place a :hover can live — an inline
            `background: transparent` here would silently outrank the class and
            these tabs would have no hover at all, which is what they had.
            So the selected tab paints inline (and correctly keeps hover off
            itself) and the unselected ones say nothing and inherit. The
            `border: none` + `borderBottom` pair below still beats .fr-seg's
            border, which is intended — the underline IS the affordance. */}
        <div style={{ display: 'flex', gap: 4, marginTop: 8, borderBottom: '1px solid var(--border)' }}>
          {(['pool', 'limits', 'targets'] as const).map(t => (
            <button
              key={t}
              className="fr-seg"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              style={{
                padding: '7px 14px', fontSize: 'var(--fs-sm)', fontWeight: 700,
                borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
                border: 'none',
                borderBottom: tab === t ? '2px solid var(--blue)' : '2px solid transparent',
                ...(tab === t
                  ? { background: 'var(--tint-surface-faint)', color: 'var(--text-strong)' }
                  : null),
              }}
            >
              {t === 'pool' ? 'Pool' : t === 'limits' ? 'Limits' : 'Block Targets'}
              {t === 'targets' && targetsDirty && (
                <span
                  title="Unsaved block-target changes"
                  style={{
                    display: 'inline-block', width: 6, height: 6, borderRadius: 999,
                    background: 'var(--blue)', marginLeft: 6, verticalAlign: 'middle',
                  }}
                />
              )}
            </button>
          ))}
        </div>

        {tab === 'pool' && (
          <div style={{ display: 'flex', gap: 6, margin: '10px 0 12px' }}>
            <Button variant="secondary" size="sm" onClick={resetToDefault}
              style={{ padding: '7px 15px', fontWeight: 700 }}>Reset to Default</Button>
            <Button variant="secondary" size="sm" onClick={clearAll}
              style={{ padding: '7px 15px', fontWeight: 700 }}>Clear All</Button>
          </div>
        )}
        {tab === 'limits' && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 12px' }}>
            Expected maximums per provider for this block. Blank = no limit (the engine
            keeps its FTE-derived budget — the provider&rsquo;s working-days FTE, or their call
            FTE when they state none). A value here overrides that for this block only.
            Working Days and Days Off are mutually exclusive.
          </div>
        )}
        {tab === 'targets' && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 10px' }}>
            How many of each call each provider owes THIS block. Every cell shows the number
            the engine will get; blank cells are the formula
            (bucket slots ÷ par {parLevel} × FTE, neuro from the site pattern), and you only
            type the ones you are changing.
          </div>
        )}

        {error && (
          <div role="alert" style={{
            background: 'var(--danger-bg)',
            border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)',
            color: 'var(--danger)', padding: '8px 12px', borderRadius: 'var(--radius-md)',
            marginBottom: 10, fontSize: 12,
          }}>{error}</div>
        )}

        {tab === 'pool' && (
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          {!sitesLoaded ? (
            <div style={{ padding: 20, color: 'var(--text-dim)', fontSize: 13 }}>Loading sites...</div>
          ) : groups.length === 0 ? (
            <div style={{ padding: 20, color: 'var(--text-dim)', fontStyle: 'italic', fontSize: 13 }}>
              No physicians in this organization.
            </div>
          ) : (
            groups.map(group => {
              const groupIds = group.providers.map(p => p.id);
              const allSelected = groupIds.every(id => checked.has(id));
              const someSelected = !allSelected && groupIds.some(id => checked.has(id));
              return (
                <div key={group.siteId} style={{ borderBottom: '1px solid var(--border)' }}>
                  <div
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 12px', background: 'var(--tint-surface-faint)',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={el => { if (el) el.indeterminate = someSelected; }}
                        onChange={() => toggleGroup(groupIds)}
                        style={{ accentColor: 'var(--blue)', width: 15, height: 15, cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{group.siteName}</span>
                      {group.siteId === scheduleSiteId && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, color: 'var(--ok)',
                          background: 'var(--ok-bg)',
                          padding: '1px 6px', borderRadius: 4, letterSpacing: 0.5,
                        }}>
                          THIS SITE
                        </span>
                      )}
                    </label>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                      {groupIds.filter(id => checked.has(id)).length} / {groupIds.length}
                    </span>
                  </div>
                  {group.providers.map(p => {
                    const prof = profiles.find(x => x.provider_id === p.id);
                    const callLabel = prof?.call_taker ? 'Call'
                      : prof?.partial_call_taker ? 'Partial'
                      : 'Day Doc';
                    // Role tone, from the status scale rather than three loose
                    // hexes. Day Doc was #94a3b8, which is ~2.5:1 on this
                    // surface; --text-dim is the same neutral at ~4.8:1.
                    const callColor = prof?.call_taker ? 'var(--ok)'
                      : prof?.partial_call_taker ? 'var(--warn)'
                      : 'var(--text-dim)';
                    return (
                      // .fr-row: a roster of ~85 names is read down, and the
                      // whole label is the hit target. No inline background
                      // here, which is what lets the class :hover win.
                      <label key={p.id} className="fr-row" style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 12px 8px 34px', cursor: 'pointer',
                        transition: 'background var(--dur-fast) var(--ease-out)',
                      }}>
                        <input
                          type="checkbox"
                          checked={checked.has(p.id)}
                          onChange={() => toggle(p.id)}
                          style={{ accentColor: 'var(--blue)', width: 14, height: 14, cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>
                          {p.first_name} {p.last_name}
                        </span>
                        <span style={{
                          fontSize: 10, fontWeight: 700, color: callColor,
                          // color-mix, NOT `${callColor}15`: that trick only
                          // works on a literal hex, and would emit the
                          // uninterpretable `var(--ok)15` now these are tokens.
                          background: `color-mix(in srgb, ${callColor} 12%, transparent)`,
                          padding: '1px 6px', borderRadius: 4,
                          letterSpacing: 0.5, whiteSpace: 'nowrap',
                        }}>
                          {callLabel}
                        </span>
                      </label>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        )}

        {/* ── Limits tab: one row per provider in the current pool selection
            (default pool = the home-site roster when no custom pool is set);
            providers with stored limits no longer in the pool render inert
            below — their data is kept, never silently dropped. ── */}
        {tab === 'limits' && (
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
          {limitsState === 'loading' ? (
            <div style={{ padding: 20, color: 'var(--text-dim)', fontSize: 13 }}>Loading limits...</div>
          ) : limitsState === 'failed' ? (
            <div role="alert" style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>
              Could not load the stored limits — saving will leave them untouched.
              Close and reopen to retry.
            </div>
          ) : (() => {
            const inPool = providers
              .filter(p => checked.has(p.id))
              .sort((a, b) => a.last_name.localeCompare(b.last_name));
            const outOfPool = Object.keys(storedLimits)
              .filter(pid => !checked.has(pid))
              .map(pid => providers.find(p => p.id === pid)
                ?? ({ id: pid, first_name: '(unknown', last_name: 'provider)' } as Provider))
              .sort((a, b) => a.last_name.localeCompare(b.last_name));
            const COLS: Array<{ field: keyof LimitFields; label: string }> = [
              { field: 'c1', label: 'C1 max' },
              { field: 'c2', label: 'C2 max' },
              { field: 'c3', label: 'C3 max' },
              { field: 'workingDays', label: 'Working Days' },
              { field: 'daysOff', label: 'Days Off' },
            ];
            const limitRow = (p: Provider, inert: boolean) => {
              const fields = limitDrafts[p.id] ?? EMPTY_LIMIT_FIELDS;
              return (
                <div key={p.id} style={{
                  display: 'grid', gridTemplateColumns: '1fr repeat(5, 74px)',
                  gap: 6, alignItems: 'center', padding: '5px 12px',
                  borderBottom: '1px solid var(--border)',
                  opacity: inert ? 0.55 : 1,
                }}>
                  <span style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.first_name} {p.last_name}
                    {inert && (
                      <span style={{
                        fontSize: 9, fontWeight: 800, marginLeft: 6, padding: '1px 5px',
                        borderRadius: 4, background: 'var(--tint-surface-strong)', color: 'var(--text-dim)',
                        textTransform: 'uppercase', letterSpacing: 0.5,
                      }}>not in pool</span>
                    )}
                  </span>
                  {COLS.map(({ field }) => {
                    // Mutual exclusion: the sibling day field is disabled while
                    // this one holds a value.
                    const exclusiveOff =
                      (field === 'daysOff' && fields.workingDays.trim() !== '') ||
                      (field === 'workingDays' && fields.daysOff.trim() !== '');
                    const invalid = isInvalidLimitInput(fields[field]);
                    return (
                      <input
                        key={field}
                        // .fr-field = the system's input hover + keyboard ring.
                        // It beats the inline `border` shorthand below with
                        // !important, which is exactly why that class exists.
                        className="fr-field"
                        type="text"
                        inputMode="numeric"
                        value={fields[field]}
                        placeholder="—"
                        disabled={inert || exclusiveOff}
                        aria-invalid={invalid || undefined}
                        onChange={e => setLimitField(p.id, field, e.target.value)}
                        title={exclusiveOff ? 'Working Days and Days Off are mutually exclusive' : undefined}
                        style={{
                          width: '100%', padding: '4px 6px', fontSize: 12.5, textAlign: 'center',
                          borderRadius: 'var(--radius-sm)',
                          fontVariantNumeric: 'tabular-nums',
                          border: invalid ? '1px solid var(--danger)' : '1px solid var(--border)',
                          background: (inert || exclusiveOff) ? 'var(--tint-surface)' : 'var(--bg-surface)',
                          color: invalid ? 'var(--danger)' : 'var(--text)',
                        }}
                      />
                    );
                  })}
                </div>
              );
            };
            return (
              <div>
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr repeat(5, 74px)', gap: 6,
                  padding: '7px 12px', borderBottom: '1px solid var(--border)',
                  // Sticky over a scrolling list, so it needs an OPAQUE ground,
                  // not a 4%-alpha tint the rows scroll through.
                  background: 'var(--bg-deep)', position: 'sticky', top: 0, zIndex: 1,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>Provider</span>
                  {COLS.map(c => (
                    <span key={c.field} style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'center' }}>{c.label}</span>
                  ))}
                </div>
                {inPool.length === 0 ? (
                  <div style={{ padding: 20, color: 'var(--text-dim)', fontStyle: 'italic', fontSize: 13 }}>
                    No providers in the current pool selection.
                  </div>
                ) : inPool.map(p => limitRow(p, false))}
                {outOfPool.length > 0 && (
                  <div style={{ padding: '7px 12px 3px', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)' }}>
                    Stored limits for providers not in the pool (kept, not applied to generation):
                  </div>
                )}
                {outOfPool.map(p => limitRow(p, true))}
              </div>
            );
          })()}
        </div>
        )}

        {/* ── Block Targets tab: per-provider, per-bucket call targets for
            THIS block, written to schedules.scenario_manifest. Blank = the
            house formula; an either-or linkage owns the buckets it covers. ── */}
        {tab === 'targets' && (
          <BlockTargetsTab
            liveRows={liveTargetRows}
            rows={targetRows}
            basis={targetsBasis}
            cellText={cellText}
            setCellText={editCellText}
            commitRows={commitTargetRows}
            state={manifestState}
            imported={panelRows.imported}
            importAcknowledged={importAcknowledged}
            setImportAcknowledged={setImportAcknowledged}
            droppedUnidentified={panelRows.droppedUnidentified}
            unreadable={panelRows.unreadable}
            stranded={strandedTargetEdits}
            hasStoredManifest={panelRows.hasStoredManifest}
            dirty={targetsDirty}
            clearRequested={clearTargets}
            onClearAll={() => setClearTargets(true)}
            onCancelClear={() => setClearTargets(false)}
            manifestErrors={targetsManifestErrors}
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, gap: 8 }}>
          {/* Kit buttons throughout. The three neutral ones used gridShared's
              `smallBtn`, which sets background/colour/border INLINE — so they
              could never have had a hover, because an inline background
              outranks any class rule. .fr-btn-secondary keeps those three
              properties in CSS, which is what makes hover, :active and the
              focus ring possible at all. The Save button was a
              #0ea5e9→#6366f1 gradient: the DARK-theme blue on a light-default
              screen, plus a glow in a blue (#3882f6) that is in no palette. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => save(true)}
            disabled={saving || hasInvalidLimit || targetsBlocked}
            style={{ padding: '7px 15px', fontWeight: 700 }}
            title="Revert to the default rule-based pool (home-site call-takers / day docs). Limits are kept."
          >
            Use Default Pool
          </Button>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={onClose}
              style={{ padding: '7px 15px', fontWeight: 700 }}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => save(false)}
              disabled={saving || totalSelected === 0 || hasInvalidLimit || targetsBlocked}
              title={
                hasInvalidLimit ? 'Fix the highlighted limit values (whole numbers ≥ 0)'
                : targetPlan.blocked ?? undefined}
              style={{ padding: '7px 16px', fontWeight: 700 }}
            >
              {saving
                ? 'Saving...'
                : wantsTargetWrite
                  ? `Save Pool + Targets (${totalSelected})`
                  : `Save Pool (${totalSelected})`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
