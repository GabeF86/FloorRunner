// Scenario report (Paoli phase 2, 2026-07-26): the audit surface phase 3
// renders — per-provider per-bucket target vs placed (EXACT fractions),
// prohibition violations (none expected except mandatory-retained seeds),
// linkage satisfaction, spacing stats, and the multi-start scoreboard.
// Pure over (ctx, plan) — computed from the FINAL plan + seeds.
import { daysBetween } from './shared';
import { parentCallCodeOf } from '@/lib/callBurden';
import { tallyCallsByPidCode } from './providerCaps';
import { computeCallBlocks, spacingScore, SPACING_SCORE_KEYS } from './spacingScore';
import {
  scenarioProhibits, weekendAnchorOf, memberMatches, NEURO_KEY,
} from './scenario';
import type { StartScore } from './multiStart';
import type { GenerationContext, SolutionPlan } from './genTypes';

export interface ScenarioBucketRow {
  key: string;        // 'MTH|C1' … 'SUN|C2'
  target: number;     // exact fractional
  placed: number;     // weighted usage (split segments at their weight)
  variance: number;   // placed − target (signed, exact)
}

export interface ScenarioProviderReport {
  provider_id: string;
  provider_name: string;
  scenarioFte: number;
  buckets: ScenarioBucketRow[];
  neuro: { target: number; placedUnits: number } | null;
  fixed: Array<{ date: string; code: string; satisfied: boolean }>;
  blocks: Array<{ start: string; end: string; dates: string[] }>;
  gaps: { min: number; avg: number; max: number } | null;
  consecutiveWeekends: number;
}

export interface ScenarioProhibitionViolation {
  provider_id: string;
  provider_name: string;
  date: string;
  code: string;
  source: 'seed' | 'generated';
  // Seeds standing against a prohibition are the import's documented
  // mandatory-retained resolution; a GENERATED violation would be an engine
  // bug (the eligibility gate makes it structurally impossible).
  mandatoryRetained: boolean;
}

export interface ScenarioLinkageReport {
  provider_id: string;
  provider_name: string;
  kind: string;
  members: string[];
  // true/false when decidable from realized placements; null for
  // informational kinds (split-12h) and never-realized linkages.
  satisfied: boolean | null;
  detail: string;
}

export interface ScenarioReport {
  providers: ScenarioProviderReport[];
  prohibitionViolations: ScenarioProhibitionViolation[];
  linkages: ScenarioLinkageReport[];
  spacing: {
    minGap: number | null;
    avgGap: number | null;
    maxGap: number | null;
    gapsLe2: number;
    consecutiveWeekends: number;
    rolling7MultiBlock: number;
  };
  score: number[];
  scoreKeys: string[];
  multiStart: {
    k: number;
    chosenSeed: number;
    starts: StartScore[];
  } | null;
}

export function computeScenarioReport(
  ctx: GenerationContext,
  plan: SolutionPlan,
  multiStart?: { chosenSeed: number; startScores: StartScore[] } | null,
): ScenarioReport | null {
  const scenario = ctx.scenario;
  if (!scenario) return null;
  const nameByPid = new Map(ctx.providers.map(p => [p.id, p.short_display_name]));
  const tally = tallyCallsByPidCode(plan.assignments, ctx.seedAssignments, ctx.shiftTypes, scenario);
  const blocksByPid = computeCallBlocks(ctx, plan);

  // Realized call events per provider (parent-mapped), split by origin so
  // prohibition rows can name their source.
  const events = new Map<string, Array<{ date: string; code: string; source: 'seed' | 'generated' }>>();
  const push = (pid: string, date: string, code: string, source: 'seed' | 'generated') => {
    const parent = parentCallCodeOf(code, ctx.shiftTypes?.get(code));
    const list = events.get(pid) ?? [];
    list.push({ date, code: parent, source });
    events.set(pid, list);
  };
  for (const a of plan.assignments) {
    if (a.shift_type_category === 'call') push(a.provider_id, a.slot_date, a.shift_type_code, 'generated');
  }
  for (const s of ctx.seedAssignments) {
    if (s.shift_type_category === 'call') push(s.provider_id, s.slot_date, s.shift_type_code, 'seed');
  }

  const providers: ScenarioProviderReport[] = [];
  const prohibitionViolations: ScenarioProhibitionViolation[] = [];
  const linkages: ScenarioLinkageReport[] = [];
  let gapsLe2 = 0;
  let consecutiveWeekendsTotal = 0;
  let rolling7 = 0;
  const allGaps: number[] = [];

  for (const sp of [...scenario.providers.values()].sort((a, b) => a.provider_id.localeCompare(b.provider_id))) {
    const pid = sp.provider_id;
    const name = nameByPid.get(pid) ?? sp.sourceName;
    const own = events.get(pid) ?? [];

    const buckets: ScenarioBucketRow[] = [...sp.targets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, target]) => {
        const placed = tally.get(`${pid}|S:${key}`) || 0;
        return { key, target, placed, variance: placed - target };
      });

    const neuro = sp.neuroTarget != null
      ? { target: sp.neuroTarget, placedUnits: tally.get(`${pid}|S:${NEURO_KEY}`) || 0 }
      : null;

    const fixed = sp.fixedAssignments.map(f => ({
      date: f.date, code: f.code,
      satisfied: own.some(e => e.date === f.date && e.code === f.code),
    }));

    for (const e of own) {
      if (scenarioProhibits(sp, e.date, e.code)) {
        prohibitionViolations.push({
          provider_id: pid, provider_name: name, date: e.date, code: e.code,
          source: e.source, mandatoryRetained: e.source === 'seed',
        });
      }
    }

    for (const l of sp.linkages) {
      if (l.kind === 'split-12h' || l.members.length === 0) {
        linkages.push({
          provider_id: pid, provider_name: name, kind: l.kind,
          members: l.rawMembers, satisfied: null,
          detail: l.kind === 'split-12h'
            ? 'executed via split segments + seeds; segment weights counted toward targets'
            : 'unparsed members — reporting only',
        });
        continue;
      }
      const realizedPerMember = l.members.map(m =>
        own.filter(e => memberMatches(m, e.date, e.code, scenario.neuroCode)));
      const anyRealized = realizedPerMember.some(r => r.length > 0);
      if (l.kind === 'either-or') {
        const usage = new Set(realizedPerMember.flat().map(e => `${e.date}|${e.code}`)).size;
        linkages.push({
          provider_id: pid, provider_name: name, kind: l.kind,
          members: l.rawMembers, satisfied: usage >= 1,
          detail: `${usage} member call(s) realized (need exactly one)`,
        });
        continue;
      }
      if (!anyRealized) {
        linkages.push({
          provider_id: pid, provider_name: name, kind: l.kind,
          members: l.rawMembers, satisfied: null, detail: 'no member realized',
        });
        continue;
      }
      const allRealized = realizedPerMember.every(r => r.length > 0);
      const scopes = new Set(realizedPerMember.flat().map(e =>
        l.kind === 'same-date' ? e.date : (weekendAnchorOf(e.date) ?? e.date)));
      const satisfied = allRealized && scopes.size === 1;
      linkages.push({
        provider_id: pid, provider_name: name, kind: l.kind,
        members: l.rawMembers, satisfied,
        detail: allRealized
          ? (satisfied ? `all members in ${[...scopes][0]}` : `members span ${[...scopes].sort().join(', ')}`)
          : `unrealized member(s): ${l.rawMembers.filter((_, i) => realizedPerMember[i].length === 0).join(', ')}`,
      });
    }

    const blocks = blocksByPid.get(pid) ?? [];
    const gaps: number[] = [];
    for (let i = 1; i < blocks.length; i++) {
      const g = daysBetween(blocks[i - 1].end, blocks[i].start);
      gaps.push(g);
      if (g <= 2) gapsLe2++;
      if (g < 7) rolling7++;
    }
    allGaps.push(...gaps);
    const weekendAnchors = [...new Set(own.map(e => weekendAnchorOf(e.date)).filter((w): w is string => w != null))].sort();
    let consecutiveWeekends = 0;
    for (let i = 1; i < weekendAnchors.length; i++) {
      if (daysBetween(weekendAnchors[i - 1], weekendAnchors[i]) === 7) consecutiveWeekends++;
    }
    consecutiveWeekendsTotal += consecutiveWeekends;

    providers.push({
      provider_id: pid, provider_name: name, scenarioFte: sp.scenarioFte,
      buckets, neuro, fixed,
      blocks: blocks.map(b => ({ start: b.start, end: b.end, dates: b.dates })),
      gaps: gaps.length > 0
        ? {
            min: Math.min(...gaps),
            avg: gaps.reduce((s, g) => s + g, 0) / gaps.length,
            max: Math.max(...gaps),
          }
        : null,
      consecutiveWeekends,
    });
  }

  return {
    providers,
    prohibitionViolations,
    linkages,
    spacing: {
      minGap: allGaps.length > 0 ? Math.min(...allGaps) : null,
      avgGap: allGaps.length > 0 ? allGaps.reduce((s, g) => s + g, 0) / allGaps.length : null,
      maxGap: allGaps.length > 0 ? Math.max(...allGaps) : null,
      gapsLe2,
      consecutiveWeekends: consecutiveWeekendsTotal,
      rolling7MultiBlock: rolling7,
    },
    score: spacingScore(ctx, plan),
    scoreKeys: [...SPACING_SCORE_KEYS],
    multiStart: multiStart
      ? { k: multiStart.startScores.length, chosenSeed: multiStart.chosenSeed, starts: multiStart.startScores }
      : null,
  };
}
