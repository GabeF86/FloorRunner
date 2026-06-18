// Call burden + backup-call FTE allocator for the Anesthesia Coverage Grid
// Calculator. Owned by agent A8 (Call Burden) per PRD §11, §14.
//
// PURPOSE
// -------
// Given a roster of call-eligible providers, an annual primary-call slot
// budget, an annual backup-call slot budget, and per-provider leave profiles
// from A2, compute:
//
//   1) `primaryCallNights` per provider — a fair, FTE-weighted, min-max
//      distribution of primary-call nights. Same algorithmic family as
//      FloorRunner's `autoGenerate.ts` lifetime-ratio greedy: at each step,
//      hand the next call slot to the eligible provider with the lowest
//      (calls assigned so far) / FTE ratio. Tie-break by deterministic
//      provider id.
//   2) `backupCallFteShare` per provider — fractional share (0..1) of total
//      annual backup-call FTE demand each provider carries. Providers with
//      `backup_call_share_target` pinned are honored exactly; the remaining
//      share is distributed by FTE-weighted greedy, biased by the user's
//      `BackupCallPosture` toggle:
//        - `aggressive`     = many partial-FTE backups, each at smaller share
//        - `conservative`   = fewer providers carrying larger shares
//   3) A fairness `gini` coefficient on the integer primary-call counts
//      (0 = perfect equality, 1 = one provider takes everything). Surfaced
//      by the UI as a small chip per PRD §11.
//
// This is a pure module — no I/O, no FloorRunner imports, no Supabase calls.
// A7 (FTE simulator) is the primary caller and runs it once per simulated
// year. The UI's "Call fairness" sparkline reads the Gini from the most
// recent A7 run.
//
// ESCALATION (PRD §14, A8 charter)
// --------------------------------
// If the roster has zero call-eligible providers, return an empty
// distribution + a clear `violations` array. NEVER throw. A7 surfaces the
// violation to the UI so the user sees the problem instead of a stack trace.
//
// RELATIONSHIP TO `autoGenerate.ts`
// --------------------------------
// We STUDIED the lifetime-ratio fairness ranking — the heart of FloorRunner's
// call scheduler — and adapted the pattern universally. We do NOT import
// from `autoGenerate.ts`: it depends on Supabase, day-type buckets, and the
// FloorRunner schedule model, all of which would compromise the universality
// guarantee in PRD §2. The adaptation here keeps the (assigned / fte) ratio
// greedy plus deterministic tie-breaks, and reuses the "no provider runs
// more than 1 over their FTE-fair share unless forced" invariant.

import type { BackupCallPosture } from './types';
import type { ProviderLeaveProfile } from './providerProfile';
import { withProfileDefaults } from './providerProfile';

// ---------------------------------------------------------------------------
// Tunable constants (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Float tolerance used when comparing fractional shares (e.g. verifying that
 * the backup-call shares sum to ~1.0). Kept loose enough to absorb the
 * rounding in `roundShareToGrid` but tight enough to catch real mistakes.
 */
export const SHARE_FLOAT_TOLERANCE = 1e-6;

/**
 * Posture-driven cap on how much backup-call share any single un-pinned
 * provider can take in a single allocation step.
 *
 * - `aggressive` → 0.15: forces the engine to spread thin and pull in more
 *   providers, even those with smaller FTEs.
 * - `conservative` → 1.00: lets a single high-FTE provider absorb whatever
 *   FTE-proportional slice the math gives them in one go (so the load
 *   concentrates on the highest-FTE providers first).
 */
export const POSTURE_MAX_STEP_SHARE: Record<BackupCallPosture, number> = {
  aggressive: 0.15,
  conservative: 1.0,
};

/**
 * Minimum incremental share added per step. Smaller = finer-grained
 * distribution; larger = chunkier (fewer providers picked up).
 *
 * - `aggressive` → 0.02: tiny floor so partial-FTE providers land even on
 *   a sliver of demand.
 * - `conservative` → 0.34: each chunk is at least a third of total demand,
 *   so at most three providers ever carry backup. This is the load-
 *   concentration knob.
 */
export const POSTURE_MIN_STEP_SHARE: Record<BackupCallPosture, number> = {
  aggressive: 0.02,
  conservative: 0.34,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal shape of one roster entry as A8 needs it. A7 (or the UI test
 * harness) is expected to assemble this from the underlying provider rows
 * + their employment profiles. We do NOT reuse solver.ts's `RosterProvider`
 * directly because we need call-eligibility flags that are orthogonal to the
 * single-day grid solver's concerns.
 *
 * The naming mirrors FloorRunner's existing `provider_employment_profiles`
 * (`call_taker`, `partial_call_taker`) for handoff convenience.
 */
export interface CallRosterEntry {
  /** Stable provider UUID. */
  id: string;
  /** FTE share, e.g. 0.5, 0.8, 1.0. */
  fte: number;
  /** Primary call eligibility. False → 0 primary calls. */
  call_taker: boolean;
  /**
   * Backup-call eligibility. Distinct from `call_taker`: a partial provider
   * may carry backup but not primary call. When false → 0 backup share.
   */
  backup_call_eligible: boolean;
}

export interface CallDistributionInput {
  /**
   * Call-eligible roster. Providers with `call_taker=false` AND
   * `backup_call_eligible=false` are skipped silently — they still show up
   * in the output with zero counts so downstream consumers can join by id
   * without dropping rows.
   */
  roster: CallRosterEntry[];
  /**
   * Total primary-call nights the year needs covered (e.g. 365 for a single
   * primary call line). A7 computes this from the calendar.
   */
  annualPrimarySlots: number;
  /**
   * Total backup-call FTE demand for the year, expressed as a normalized
   * share that must sum to 1.0 across providers. (A7 converts nights →
   * fractional demand before calling.)
   */
  annualBackupSlots: number;
  /** From the toggle bar — see `POSTURE_MAX_STEP_SHARE`. */
  posture: BackupCallPosture;
  /**
   * Per-provider leave profile, keyed by provider id. Missing entries fall
   * back to `withProfileDefaults({})` so a partially-onboarded roster still
   * computes.
   */
  providerLeaveProfiles: Record<string, Partial<ProviderLeaveProfile>>;
}

export interface ProviderCallBurden {
  providerId: string;
  /** Integer count of primary call nights assigned to this provider. */
  primaryCallNights: number;
  /**
   * Fractional share (0..1) of total backup-call demand carried by this
   * provider. Pinned providers report their pinned target verbatim.
   */
  backupCallFteShare: number;
}

export interface CallDistribution {
  perProvider: ProviderCallBurden[];
  /**
   * Gini coefficient on the integer primary-call counts. 0 = perfect
   * fairness; 1 = total inequality (one provider takes all). Computed only
   * over call-eligible providers (call_taker=true with non-zero FTE) — if
   * we included ineligible zeros, the metric would mechanically rise just
   * by adding ineligible providers, which is not what fairness means here.
   *
   * NaN when there are zero call-eligible providers OR when total primary
   * call nights distributed is zero (no meaningful fairness measurement).
   */
  gini: number;
  /**
   * Soft violations for A7 to surface. Examples:
   *   - "No call-eligible providers in roster"
   *   - "Pinned backup_call_share_target sums to >1.0 — clamped"
   * Never thrown; always returned.
   */
  violations: string[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compute the annual call distribution.
 *
 * Algorithm (mirrors PRD §11):
 *   1. Filter to call-eligible providers (call_taker=true, fte>0). If none,
 *      return an empty distribution + violation; do not throw.
 *   2. FTE-weighted greedy primary-call distribution: for each of
 *      `annualPrimarySlots` nights, pick the provider with the lowest
 *      `(assignedSoFar / fte)` ratio. Tie-break by deterministic provider
 *      id. Honor `max_consecutive_post_call_days` as a SOFT per-provider
 *      cap on total nights — a provider whose cap is e.g. 1 day off per
 *      call (the default) gets capped at `min(roundedFairShare + 1,
 *      annualPrimarySlots)` nights so they don't get hammered when others
 *      are unavailable. This bounds the worst-case run.
 *   3. Backup-call share distribution:
 *        a. Pin every provider with a non-null `backup_call_share_target`
 *           to that exact target. Clamp aggregate pinned share to ≤1.0.
 *        b. Remaining (1 - pinned_total) is distributed by FTE-weighted
 *           greedy among `backup_call_eligible=true` providers. Step size
 *           is clamped to `[POSTURE_MIN_STEP_SHARE, POSTURE_MAX_STEP_SHARE]`
 *           for the active posture. Aggressive posture's smaller max forces
 *           a fan-out; conservative's larger max concentrates the load.
 *   4. Compute Gini coefficient on the integer primary-call counts.
 */
export function distributeCall(input: CallDistributionInput): CallDistribution {
  const violations: string[] = [];

  // --- 1. Filter eligible pool ----------------------------------------------

  // Stable input order is preserved everywhere we iterate by id-sorted view
  // so callers get deterministic output. We also dedupe by id defensively;
  // a duplicate row would double-count someone's call share.
  const seen = new Set<string>();
  const roster = input.roster.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  const primaryPool = roster.filter((r) => r.call_taker && r.fte > 0);
  const backupPool = roster.filter((r) => r.backup_call_eligible && r.fte > 0);

  if (primaryPool.length === 0 && backupPool.length === 0) {
    violations.push('No call-eligible providers in roster');
    return {
      perProvider: roster.map((r) => ({
        providerId: r.id,
        primaryCallNights: 0,
        backupCallFteShare: 0,
      })),
      gini: Number.NaN,
      violations,
    };
  }

  // --- 2. Primary-call greedy distribution ----------------------------------

  const primaryByProvider = new Map<string, number>();
  for (const r of roster) primaryByProvider.set(r.id, 0);

  if (primaryPool.length > 0 && input.annualPrimarySlots > 0) {
    // Per-provider soft cap. Default rule: a provider's fair share + 1 night.
    // The `max_consecutive_post_call_days` field is consulted as the slack
    // budget — a provider who can take back-to-back calls (i.e. larger cap)
    // can absorb a little more overflow.
    const totalFte = primaryPool.reduce((acc, r) => acc + r.fte, 0);
    const softCap = new Map<string, number>();
    for (const r of primaryPool) {
      const profile = withProfileDefaults(input.providerLeaveProfiles[r.id] ?? {});
      const fairShare = (input.annualPrimarySlots * r.fte) / totalFte;
      const slack = Math.max(1, profile.max_consecutive_post_call_days);
      // round up so the cap doesn't artificially block someone at exactly
      // their fair share when the next-best alternative is much worse.
      softCap.set(r.id, Math.ceil(fairShare) + slack);
    }

    // Sort the pool deterministically before each scan: id-sorted is stable.
    const sortedPool = [...primaryPool].sort((a, b) => a.id.localeCompare(b.id));

    let forcedOverflow = false;
    for (let i = 0; i < input.annualPrimarySlots; i++) {
      // Greedy: lowest lifetime ratio first.
      let best: CallRosterEntry | null = null;
      let bestRatio = Infinity;
      // First pass: only consider providers under their soft cap.
      for (const r of sortedPool) {
        const assigned = primaryByProvider.get(r.id) ?? 0;
        if (assigned >= (softCap.get(r.id) ?? Infinity)) continue;
        const ratio = assigned / Math.max(r.fte, 0.01);
        if (ratio < bestRatio) {
          bestRatio = ratio;
          best = r;
        }
      }
      // Fallback: every provider hit their cap → ignore the cap. This
      // implements the PRD §11 invariant: caps are soft; coverage wins over
      // perfect fairness. We log it once via the violations array.
      if (!best) {
        if (!forcedOverflow) {
          violations.push(
            'Primary call demand exceeds soft per-provider caps; ' +
              'some providers carry above their FTE-fair share + max_consecutive_post_call_days slack',
          );
          forcedOverflow = true;
        }
        for (const r of sortedPool) {
          const assigned = primaryByProvider.get(r.id) ?? 0;
          const ratio = assigned / Math.max(r.fte, 0.01);
          if (ratio < bestRatio) {
            bestRatio = ratio;
            best = r;
          }
        }
      }
      if (!best) break; // shouldn't happen because sortedPool is non-empty
      primaryByProvider.set(best.id, (primaryByProvider.get(best.id) ?? 0) + 1);
    }
  }

  // --- 3. Backup-call share distribution ------------------------------------

  const backupByProvider = new Map<string, number>();
  for (const r of roster) backupByProvider.set(r.id, 0);

  let pinnedTotal = 0;
  const pinnedIds = new Set<string>();
  for (const r of roster) {
    const profile = withProfileDefaults(input.providerLeaveProfiles[r.id] ?? {});
    if (profile.backup_call_share_target !== null) {
      // A provider flagged backup-ineligible must NOT carry a pinned share —
      // honoring the pin here would silently bypass the eligibility flag and
      // leave the director with no signal that the pin contradicts the
      // roster row. Skip the pin and raise a violation so the conflict
      // surfaces in the UI ribbon.
      if (!r.backup_call_eligible) {
        violations.push(
          'Pinned target on backup-ineligible provider — pin ignored',
        );
        continue;
      }
      const t = profile.backup_call_share_target;
      backupByProvider.set(r.id, t);
      pinnedTotal += t;
      pinnedIds.add(r.id);
    }
  }

  if (pinnedTotal > 1 + SHARE_FLOAT_TOLERANCE) {
    // Defensive clamp: the user pinned more than 100% of backup share.
    // Scale every pinned target down so the sum is exactly 1.0 and there's
    // no remainder to distribute. A7 surfaces the violation.
    violations.push(
      `Pinned backup_call_share_target sums to ${pinnedTotal.toFixed(3)} (>1.0) — scaled down to 1.0`,
    );
    const scale = 1 / pinnedTotal;
    for (const id of pinnedIds) {
      backupByProvider.set(id, (backupByProvider.get(id) ?? 0) * scale);
    }
    pinnedTotal = 1;
  }

  const remaining = Math.max(0, 1 - pinnedTotal);
  const unpinnedBackup = backupPool.filter((r) => !pinnedIds.has(r.id));

  if (
    remaining > SHARE_FLOAT_TOLERANCE &&
    unpinnedBackup.length > 0 &&
    input.annualBackupSlots > 0
  ) {
    distributeRemainingBackupShare(
      unpinnedBackup,
      backupByProvider,
      remaining,
      input.posture,
    );
  } else if (remaining > SHARE_FLOAT_TOLERANCE && unpinnedBackup.length === 0) {
    // All pinned share < 1 but nobody left to absorb the remainder. Push the
    // remainder onto the pinned providers, FTE-weighted, so the final
    // distribution still sums to 1.0. This is a soft repair — the violation
    // is informational.
    if (pinnedIds.size > 0) {
      violations.push(
        `Pinned share sums to ${pinnedTotal.toFixed(3)} but no unpinned backup-eligible providers; ` +
          'redistributing remainder across pinned providers FTE-weighted',
      );
      const pinnedRoster = roster.filter((r) => pinnedIds.has(r.id));
      const totalFte = pinnedRoster.reduce((acc, r) => acc + r.fte, 0);
      if (totalFte > 0) {
        for (const r of pinnedRoster) {
          const extra = (r.fte / totalFte) * remaining;
          backupByProvider.set(r.id, (backupByProvider.get(r.id) ?? 0) + extra);
        }
      }
    }
  }

  // --- 4. Build output + Gini -----------------------------------------------

  const perProvider: ProviderCallBurden[] = roster.map((r) => ({
    providerId: r.id,
    primaryCallNights: primaryByProvider.get(r.id) ?? 0,
    backupCallFteShare: backupByProvider.get(r.id) ?? 0,
  }));

  const eligibleCounts = primaryPool.map((r) => primaryByProvider.get(r.id) ?? 0);
  const gini = giniCoefficient(eligibleCounts);

  return { perProvider, gini, violations };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * FTE-weighted greedy distribution of the remaining backup-call share.
 *
 * Step size is clamped to `[POSTURE_MIN_STEP_SHARE, POSTURE_MAX_STEP_SHARE]`
 * for the active posture:
 *   - aggressive  → small steps (0.05–0.20) → many providers touched
 *   - conservative → larger steps (0.10–0.50) → fewer providers touched
 *
 * At each iteration we pick the provider with the lowest
 * `(currentShare / fte)` ratio (same pattern as primary call), assign them
 * a step size proportional to their FTE share of the remaining demand,
 * and loop until the remaining share is below `SHARE_FLOAT_TOLERANCE`.
 */
function distributeRemainingBackupShare(
  pool: CallRosterEntry[],
  shareByProvider: Map<string, number>,
  remainingArg: number,
  posture: BackupCallPosture,
): void {
  const sortedPool = [...pool].sort((a, b) => a.id.localeCompare(b.id));
  const minStep = POSTURE_MIN_STEP_SHARE[posture];
  const maxStep = POSTURE_MAX_STEP_SHARE[posture];
  const totalFte = sortedPool.reduce((acc, r) => acc + r.fte, 0);

  let remaining = remainingArg;
  // Guard against pathological inputs (e.g. minStep > remaining at start).
  // We loop a bounded number of times (hard cap) so a bug can't spin.
  const HARD_LOOP_CAP = 10_000;
  let iter = 0;
  while (remaining > SHARE_FLOAT_TOLERANCE && iter < HARD_LOOP_CAP) {
    iter++;

    // Lowest ratio first (FTE-fair weighting).
    let best: CallRosterEntry | null = null;
    let bestRatio = Infinity;
    for (const r of sortedPool) {
      const current = shareByProvider.get(r.id) ?? 0;
      const ratio = current / Math.max(r.fte, 0.01);
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = r;
      }
    }
    if (!best) break;

    // Step = clamped FTE-proportional slice of the remaining demand.
    const proportional = (best.fte / Math.max(totalFte, 0.01)) * remaining;
    let step = Math.min(maxStep, Math.max(minStep, proportional));
    step = Math.min(step, remaining);

    shareByProvider.set(best.id, (shareByProvider.get(best.id) ?? 0) + step);
    remaining -= step;
  }

  // Stuff any tiny residual onto the provider with the smallest current
  // share so the totals sum cleanly to 1.0. Sub-tolerance noise only.
  if (remaining > 0 && sortedPool.length > 0) {
    const target = sortedPool.reduce(
      (acc, r) => {
        const s = shareByProvider.get(r.id) ?? 0;
        return s < acc.share ? { id: r.id, share: s } : acc;
      },
      { id: sortedPool[0].id, share: shareByProvider.get(sortedPool[0].id) ?? 0 },
    );
    shareByProvider.set(target.id, (shareByProvider.get(target.id) ?? 0) + remaining);
  }
}

/**
 * Standard Gini coefficient on a non-negative numeric distribution.
 *
 *   G = sum_i sum_j |x_i - x_j| / (2 * n * sum(x))
 *
 * Returns NaN for empty inputs or zero totals (fairness is undefined when
 * nobody got any calls). Always in [0, 1] otherwise.
 *
 * O(n^2). Fine for roster sizes ≤500; switch to the Lorenz-curve formula
 * above that.
 */
export function giniCoefficient(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const total = values.reduce((acc, v) => acc + v, 0);
  if (total <= 0) return Number.NaN;
  let absSum = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < values.length; j++) {
      absSum += Math.abs(values[i] - values[j]);
    }
  }
  return absSum / (2 * values.length * total);
}
