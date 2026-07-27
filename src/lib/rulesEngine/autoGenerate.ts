// Orchestrator for physician call-schedule generation.
// Pipeline: load (genContext) -> solve (pure) -> commit (batched) -> validate.
// See ALGORITHM.md and docs/superpowers/specs/2026-06-11-scheduling-engine-optimization-design.md
import { loadGenerationContext } from './genContext';
import { solve } from './solve';
import { optimize } from './optimize';
import { solveMultiStart } from './multiStart';
import { computeScenarioReport } from './scenarioReport';
import type { ScenarioReport } from './scenarioReport';
import type { MultiStartResult } from './multiStart';
import { commitPlan, commitValidation, commitMetadata, hasGenerationMetadataColumn } from './commit';
import { scoreSolution } from './metrics';
import { computeRequestGrants, computeCallRequestGrants } from './requestGrants';
import { computeProviderCapSummary } from './providerCaps';
import type { ProviderCapSummary } from './providerCaps';
import { computeWorkDayReport } from './workDayReport';
import type { WorkDayReportRow } from './workDayReport';
import { computeNeuroReport, neuroShortfallWarnings } from './neuroWeekend';
import type { NeuroReportRow } from './neuroWeekend';
import type { RequestGrant, CallRequestGrant } from './requestGrants';
import type { OptimizeStats } from './optimize';
import type { SupabaseClient } from './shared';
import type { UnfilledSlot, PlannedAssignment, AssignmentExplanation, SolutionMetrics, PlacementSource, SkippedDerived, EvictedSeed, FillMode, AwaitingContinueSlot } from './genTypes';

export interface AutoGenerateOptions {
  overrideProviderIds?: string[];
  // The version's parent schedule id, when the caller already holds it (the
  // generate route's path param). Threaded to loadGenerationContext to skip
  // its redundant schedule_versions round trip; absent → looked up as before.
  parentScheduleId?: string;
  optimize?: boolean; // default true; set false to use raw greedy construction
  // Optimizer wall-clock budget (ms). Falls back to the
  // SCHEDULING_OPTIMIZE_WALL_MS env var, then the optimizer default (2000).
  wallClockMs?: number;
  // Generation fill mode (2026-07-17): 'all' (default) fills every fillable
  // call slot; 'obligatory' caps each provider at their rounded total
  // obligation and leaves the rest open ('obligation-cap'). See genTypes
  // FillMode. Obligatory mode never runs the optimizer: its objective
  // (fewer unfilled slots) fights deliberately-open cap slots, and its
  // 'call-no-quota' pin re-validation knows nothing of caps — a pinned
  // eviction could push a provider past their obligation. The deterministic
  // greedy plan IS the obligatory answer.
  //
  // 'weekend-only' (2026-07-21): staged weekend fill — Sat/Sun/Fri call slots
  // only (chains land wherever the pattern points); out-of-scope call slots
  // are reported in `awaitingContinue`, not `unfilled`. It never runs the
  // optimizer either: a deliberately partial plan must not be "improved"
  // against full-schedule objectives. The optimizer runs once, in the
  // Continue generation ('all') — where the committed weekend placements are
  // SEEDS, hence immovable: reviewed weekends stay locked, by design.
  fillMode?: FillMode;
  // Multi-start width for SCENARIO generations (2026-07-26): the number of
  // seeded tie-break rotations (seeds 0..K-1) the fill-all path explores
  // before keeping the lexicographically best spacing score. Ignored without
  // a scenario manifest (single-run engine, byte-identical) and outside
  // fill-all. Default DEFAULT_MULTI_START_K (8). NOTE: wallClockMs is the
  // PER-START optimizer budget, so worst-case wall is K × wallClockMs.
  multiStartK?: number;
}

// Pure: optimization is on by default; an explicit boolean overrides.
export function resolveOptimizeEnabled(flag: boolean | undefined): boolean {
  return flag !== false;
}

// Pure: only the exact strings 'obligatory' / 'weekend-only' opt in;
// everything else — absent, 'all', wrong case, wrong type — degrades to the
// default 'all'. Shared by the generate route's body parsing and the engine
// option resolution.
export function resolveFillMode(v: unknown): FillMode {
  return v === 'obligatory' || v === 'weekend-only' ? v : 'all';
}

// Pure: explicit param wins, then the env var; undefined lets optimize()
// apply its own default (2000 ms). Non-numeric / negative values are ignored.
export function resolveWallClockMs(
  param: number | undefined, env: string | undefined,
): number | undefined {
  if (param !== undefined && Number.isFinite(param) && param >= 0) return param;
  if (env !== undefined && env.trim() !== '') {
    const n = Number(env);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

export interface GenerationResult {
  filled: number;
  skipped: number;
  errors: string[];
  assignments: Array<{
    slot_id: string; slot_date: string; shift_type_code: string;
    provider_id: string; provider_name: string;
    source?: PlacementSource;
    explanation?: AssignmentExplanation;
  }>;
  unfilled: UnfilledSlot[];
  // Derived placements the solver suppressed (PTO/cross-site/occupied…) —
  // clinical invariant 4 says these are recorded, never silently dropped, so
  // the API surfaces them alongside unfilled.
  skippedDerived?: SkippedDerived[];
  // Stale pre-fill seeds evicted by post-call chain fills (2026-07-21, the
  // D1-overrides-pre-call rule applied to multi-pass seeds). Reported
  // alongside skippedDerived — the vacated slots stay OPEN and this list is
  // their report. Executed by commitPlan (revert-to-open before fills).
  evictions?: EvictedSeed[];
  // Load-time advisories (missing patch18 objects, unknown pattern codes, quota
  // shortfalls, unsupported multi-fill slots). Non-fatal; surfaced to the UI.
  warnings: string[];
  // No-call request grant report (2026-07-17): per provider with a live
  // no_call_request in the block — requested/granted/violated dates, computed
  // from the FINAL (post-optimize) plan. Empty when nobody requested. The UI
  // banner renders "N/M no-call requests honored" + the violated detail.
  requestGrants: RequestGrant[];
  // Call-request grant report (2026-07-22, mirror of requestGrants): per
  // provider with a live call_request in the block — requested dates split
  // into granted (a call landed there) / not_granted. Empty when nobody
  // requested. The UI banner renders "N/M call requests granted" + the
  // not-granted detail — never silent.
  callRequestGrants: CallRequestGrant[];
  // FTE working-days report (2026-07-17): per call-taker, the working-days
  // obligation vs credited-days accounting (fte / workingDays / pto / required /
  // credited breakdown / entitledOff / delta). Empty when ctx carries no
  // budget. Surfaced in the UI near the fairness/grant banner.
  workDayReport: WorkDayReportRow[];
  // Neuro weekend requirement audit (2026-07-27): per-provider owed vs
  // credited weekend units. ABSENT unless the site's pattern states a
  // neuroWeekend config — additive, so pre-change consumers see no new key.
  neuroReport?: NeuroReportRow[];
  // Weekend-only mode ONLY (absent otherwise): call slots the staged run
  // deliberately did not attempt, with a day-type breakdown. NOT failures and
  // NOT counted in `skipped` — the UI banner renders "N placed · M slots
  // awaiting Continue" and offers the Continue ('all') button.
  awaitingContinue?: { total: number; byDayType: Record<string, number> };
  // Provider call caps (2026-07-22, patch34): per stated (provider, code) cap,
  // placed-vs-cap from the FINAL plan + seeds, plus the count of slots left
  // open under caps ('provider-cap'). ABSENT unless the schedule states call
  // caps — additive, so pre-limits consumers see no new key.
  providerCapSummary?: ProviderCapSummary;
  // Scenario audit (2026-07-26, patch37): per-provider target-vs-placed
  // (exact fractions), prohibition violations (mandatory-retained seeds),
  // linkage satisfaction, spacing stats, and the multi-start scoreboard
  // (chosen seed + every start's score). ABSENT unless the schedule stores a
  // scenario manifest — additive.
  scenarioReport?: ScenarioReport;
  // Distinguishes a hard failure (no slots / empty pool / DB error) from a
  // legitimate partial fill. The route maps this to an HTTP status.
  ok: boolean;
  metrics?: SolutionMetrics;
  seedMetrics?: SolutionMetrics; // greedy baseline, for before/after comparison
  optimizeStats?: OptimizeStats; // resolves/gatedSkips/wallMs, when optimization ran
  perf?: {
    par_level: number; total_slots: number; call_slots: number;
    providers: number; elapsed_ms: number; db_queries: number;
  };
}

// Pure: plan.awaitingContinue -> the result summary (total + per-day-type
// counts). Weekend-only mode only; the full slot list stays on the plan.
export function summarizeAwaitingContinue(
  slots: AwaitingContinueSlot[],
): { total: number; byDayType: Record<string, number> } {
  const byDayType: Record<string, number> = {};
  for (const s of slots) byDayType[s.derived_day_type] = (byDayType[s.derived_day_type] || 0) + 1;
  return { total: slots.length, byDayType };
}

// Pure: planned assignment -> the API/UI assignment shape (now includes the
// placement source + explanation for the schedule UI's "why" view).
export function toResultAssignment(a: PlannedAssignment) {
  return {
    slot_id: a.slot_id, slot_date: a.slot_date, shift_type_code: a.shift_type_code,
    provider_id: a.provider_id, provider_name: a.provider_name,
    source: a.source, explanation: a.explanation,
  };
}

export async function autoGenerate(
  sb: SupabaseClient,
  scheduleVersionId: string,
  options: AutoGenerateOptions = {},
): Promise<GenerationResult> {
  const t0 = Date.now();
  const result: GenerationResult = {
    filled: 0, skipped: 0, errors: [], assignments: [], unfilled: [],
    warnings: [], requestGrants: [], callRequestGrants: [], workDayReport: [], ok: false,
  };

  const load = await loadGenerationContext(sb, scheduleVersionId, options);
  if (!load.ctx) {
    result.errors.push(load.error || 'Failed to load generation context');
    return result; // ok stays false -> route returns 4xx/5xx
  }
  const ctx = load.ctx;
  result.warnings = ctx.warnings ?? [];

  let plan;
  let commit;
  let seedMetrics;
  let multiStart: MultiStartResult | null = null;
  try {
    const fillMode = resolveFillMode(options.fillMode);
    if (ctx.scenario && fillMode === 'all') {
      // ── scenario multi-start (2026-07-26) ──
      // K seeded tie-break rotations of greedy+optimizer; keep the
      // lexicographically best spacing score (multiStart.ts). Seed 0 is
      // today's ordering, so K=1 degenerates to the single-run path.
      // Non-'all' scenario fills keep the single deterministic greedy below
      // (the optimizer never runs there anyway, and a partial/capped plan
      // must not be spacing-raced).
      multiStart = solveMultiStart(ctx, {
        k: options.multiStartK,
        fillMode,
        optimizeEnabled: resolveOptimizeEnabled(options.optimize),
        wallClockMs: resolveWallClockMs(options.wallClockMs, process.env.SCHEDULING_OPTIMIZE_WALL_MS),
      });
      plan = multiStart.plan;
      seedMetrics = multiStart.seedMetrics;
      if (multiStart.optimizeStats) result.optimizeStats = multiStart.optimizeStats;
    } else {
      const seedPlan = solve(ctx, { fillMode });
      seedMetrics = scoreSolution(seedPlan, ctx);
      // Only 'all' optimizes. Obligatory and weekend-only both return the
      // deterministic greedy plan — see the AutoGenerateOptions.fillMode note
      // for why the optimizer must not run in either.
      if (fillMode === 'all' && resolveOptimizeEnabled(options.optimize)) {
        const optimized = optimize(ctx, {
          wallClockMs: resolveWallClockMs(options.wallClockMs, process.env.SCHEDULING_OPTIMIZE_WALL_MS),
        });
        plan = optimized.plan;
        result.optimizeStats = optimized.stats;
      } else {
        plan = seedPlan;
      }
    }
    commit = await commitPlan(sb, plan);
  } catch (e: unknown) {
    result.errors.push(
      `Unexpected error during generation: ${e instanceof Error ? e.message : String(e)}`,
    );
    return result; // ok stays false
  }

  result.errors.push(...commit.errors);
  if (commit.errors.length > 0) {
    // Invariant 4: skip records must stay visible even when the commit fails —
    // the plan was solved, so its suppressed derived placements are known.
    // Evictions likewise (they may be exactly what partially executed).
    result.skippedDerived = plan.skippedDerived ?? [];
    result.evictions = plan.evictions ?? [];
    return result; // commit failure -> ok false (assignments not reliably written)
  }

  // Grant reports from the FINAL plan (post-optimize when it ran) — computed
  // after commit succeeds so they always describe what was actually written.
  result.requestGrants = computeRequestGrants(ctx, plan);
  result.callRequestGrants = computeCallRequestGrants(ctx, plan);
  // Contradictory-request advisories (call + no-call on one date — treated
  // as neither, warned once per provider by solve): surface with the load
  // warnings so they are never silent. New array — result.warnings may alias
  // ctx.warnings and pushing would mutate the context.
  if (plan.requestWarnings?.length) {
    result.warnings = [...result.warnings, ...plan.requestWarnings];
  }

  // Neuro requirement audit — same surfacing contract as requestWarnings: a
  // NEW array (result.warnings may alias ctx.warnings, so never push).
  //
  // CREDIT IS PLAN + SEEDS, like every sibling report (providerCaps'
  // tallyCallsByPidCode, workDayReport) — and, decisively, like the two
  // solver readers of this same vocabulary: the eligibility remainder gate
  // and the scoring tier both judge credit from state.callCodesByDate, which
  // seedSolveState populates from ctx.seedAssignments. Plan-only would break
  // the module's stated invariant that placement rules and the report never
  // drift, and would misfire on the live Paoli path: a Continue ('all') run
  // after a weekend-only run re-solves ONLY the open slots, so every already-
  // committed C3 is a seed and absent from plan.assignments — every 0.75 doc
  // would be reported short their whole weekend on the run that finalizes the
  // block. Double-counting is structurally impossible: creditedUnitsByProvider
  // folds a provider's weekend DATES into a Set before scoring units.
  const neuroCfg = ctx.callPattern?.neuroWeekend;
  if (neuroCfg) {
    const placements = [
      ...plan.assignments.map(a => ({
        provider_id: a.provider_id,
        slot_date: a.slot_date,
        code: a.shift_type_code,
      })),
      ...ctx.seedAssignments.map(s => ({
        provider_id: s.provider_id,
        slot_date: s.slot_date,
        code: s.shift_type_code,
      })),
    ];
    const rows = computeNeuroReport(
      ctx.providers.map(p => ({ id: p.id, fte_value: p.fte_value })), placements, neuroCfg);
    result.neuroReport = rows;
    const nameById = new Map(ctx.providers.map(p => [p.id, p.short_display_name]));
    result.warnings = [
      ...result.warnings,
      ...neuroShortfallWarnings(rows, id => nameById.get(id) ?? id),
    ];
  }

  // Validation is best-effort: the assignments are ALREADY committed at this
  // point, so a validation-pass failure must NOT flip the run to ok=false — it
  // only means validation_flags couldn't be written. Surface a soft note.
  let validationQueries = 0;
  try {
    const validation = await commitValidation(sb, ctx.siteId, ctx.scheduleVersionId);
    validationQueries = validation.dbQueries;
    // Soft notes (e.g. 'validation-unavailable' rows) — never flips ok.
    result.errors.push(...validation.errors);
  } catch (e: unknown) {
    result.errors.push(
      `Validation pass failed (assignments were still saved): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Persist per-assignment explanations, best-effort + graceful if the column
  // is absent (mirrors the call_par_level fallback). Never flips ok to false.
  let metadataQueries = 0;
  try {
    if (await hasGenerationMetadataColumn(sb)) {
      const meta = await commitMetadata(sb, plan.assignments);
      metadataQueries = meta.dbQueries;
      if (meta.errors.length > 0) {
        result.errors.push(`Some explanation metadata was not saved (${meta.errors.length} rows).`);
      }
    }
  } catch (e: unknown) {
    result.errors.push(
      `Explanation metadata pass failed (assignments were still saved): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Map plan -> the result shape (now with source + explanation per assignment).
  result.filled = commit.filled;
  result.skipped = plan.unfilled.length;
  result.assignments = plan.assignments.map(toResultAssignment);
  result.unfilled = plan.unfilled;
  result.skippedDerived = plan.skippedDerived ?? [];
  result.evictions = plan.evictions ?? [];
  // Weekend-only: deferred out-of-scope call slots (plan.awaitingContinue is
  // materialized only in that mode — present even when empty, so the UI can
  // always render the staged banner + Continue affordance).
  if (plan.awaitingContinue) result.awaitingContinue = summarizeAwaitingContinue(plan.awaitingContinue);
  // Provider call caps: placed-vs-cap summary from the FINAL plan (null when
  // the schedule states no call caps — the key stays absent).
  const capSummary = computeProviderCapSummary(ctx, plan);
  if (capSummary) result.providerCapSummary = capSummary;
  // Scenario audit from the FINAL plan (null without a manifest — absent key).
  const scenarioReport = computeScenarioReport(ctx, plan, multiStart);
  if (scenarioReport) result.scenarioReport = scenarioReport;
  result.metrics = scoreSolution(plan, ctx);
  result.seedMetrics = seedMetrics;
  // Working-days report from the FINAL (post-optimize) plan + seeds — describes
  // what was committed. Empty unless ctx carries a workDayBudget (production).
  result.workDayReport = computeWorkDayReport(ctx, plan);
  result.ok = true;
  result.perf = {
    par_level: ctx.parLevel,
    total_slots: load.totalSlots,
    call_slots: ctx.slotsToFill.length, // open (unfilled) call slots at generation time
    providers: ctx.providers.length,
    elapsed_ms: Date.now() - t0,
    db_queries: load.dbQueries + commit.dbQueries + validationQueries + metadataQueries,
  };
  return result;
}
