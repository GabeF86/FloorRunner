// Block Targets panel — pure data layer (2026-07-27).
//
// The load-bearing test here is the ROUND TRIP: build the manifest Gabriel's
// own words describe, prove it passes paoliBlockManifestSchema, then push it
// through projectScenario + buildScenarioCallCaps — the engine's real entry
// points — and assert the targets, linkages and CEILINGS that come out. A
// manifest that validates but projects wrong is the failure mode that matters;
// schema-only assertions cannot see it.
//
// The block fixture is the live Paoli one: 2026-08-10 (Monday) through
// 2026-10-25 (Sunday), 77 days = 11 weeks exactly, par 11, Labor Day
// (2026-09-07, a Monday) carried as 'major_holiday' so the holiday-folding
// rule is exercised by the same numbers he quoted (44 M–Th C1 → 4 for a 1.0
// FTE, not 43 → 3.909).
import { describe, it, expect } from 'vitest';
import {
  BLOCK_TARGETS_PANEL_STATE_VERSION,
  BLOCK_TARGETS_SOURCE_WORKBOOK,
  NEURO_BUCKET,
  bucketSlotCounts,
  buildBlockManifest,
  checkFeasibility,
  checkManifestFeasibility,
  derivedTargets,
  derivedTargetsFor,
  eitherOrLinkage,
  isPanelAuthored,
  linkageMember,
  parseLinkageMember,
  readPanelProviders,
  readPanelState,
  resolveTargets,
  splitTwelveHourLinkage,
  zeroBuckets,
  type BlockSlot,
  type BlockTargetsProvider,
  type DerivationBasis,
} from './blockTargets';
import { BUCKET_KEYS, paoliBlockManifestSchema } from './paoliBlock/manifest';
import { NEURO_KEY, projectScenario } from './rulesEngine/scenario';
import { buildScenarioCallCaps } from './rulesEngine/providerCaps';
import { WEEKEND_V2_PATTERN } from './rulesEngine/patterns/weekendV2';
import { addDays, dayOfWeekUTC } from './rulesEngine/shared';

// The LIVE Paoli neuro config — imported, never restated, so the panel's
// defaults and the engine's cannot drift apart in a fixture.
const NEURO = WEEKEND_V2_PATTERN.neuroWeekend!;

const BLOCK_START = '2026-08-10';
const BLOCK_END = '2026-10-25';

function blockDates(): string[] {
  const out: string[] = [];
  for (let d = BLOCK_START; d <= BLOCK_END; d = addDays(d, 1)) out.push(d);
  return out;
}

function callSlot(
  slot_date: string,
  code: string,
  over: Partial<BlockSlot['shift_types'] & object> = {},
  dayType?: string,
): BlockSlot {
  const dow = dayOfWeekUTC(slot_date);
  const derived = dayType
    ?? (dow === 6 ? 'saturday' : dow === 0 ? 'sunday' : dow === 5 ? 'friday' : 'weekday');
  return {
    slot_date,
    derived_day_type: derived,
    shift_types: { code, category: 'call', ...over },
  };
}

/** The block's call slots: C1 + C2 every day, C3 on Sat + Sun (the weekendV2
 * shape — Friday neuro has no slot), Labor Day typed as a major holiday. */
function paoliBlockSlots(): BlockSlot[] {
  const slots: BlockSlot[] = [];
  for (const d of blockDates()) {
    const holiday = d === '2026-09-07' ? 'major_holiday' : undefined;
    slots.push(callSlot(d, 'C1', {}, holiday));
    slots.push(callSlot(d, 'C2', {}, holiday));
    const dow = dayOfWeekUTC(d);
    if (dow === 6 || dow === 0) slots.push(callSlot(d, 'C3'));
  }
  return slots;
}

const PAOLI_BASIS: DerivationBasis = {
  slotCounts: bucketSlotCounts(paoliBlockSlots()),
  parLevel: 11,
  neuro: NEURO,
};

// ── slot counting ────────────────────────────────────────────────────────────

describe('bucketSlotCounts', () => {
  it('counts the live 11-week Paoli block exactly as he states it', () => {
    const counts = bucketSlotCounts(paoliBlockSlots());
    expect(counts).toEqual({
      MTH_C1: 44, MTH_C2: 44,
      FRI_C1: 11, FRI_C2: 11,
      SAT_C1: 11, SAT_C2: 11,
      SUN_C1: 11, SUN_C2: 11,
      NEURO_FSS: 11, // one weekend unit per weekend (Sat+Sun pair)
    });
  });

  it('folds a HOLIDAY day type into its day-of-week bucket (Labor Day is a Monday)', () => {
    // The engine charges a Monday-holiday placement to MTH|C1 (scenarioBucketOf
    // is date-based), so the panel must budget for it in MTH. Dropping holidays
    // would make the block's MTH_C1 43 and his "4 Weekday C1" derive as 3.909.
    const laborDay = bucketSlotCounts([callSlot('2026-09-07', 'C1', {}, 'major_holiday')]);
    expect(laborDay.MTH_C1).toBe(1);
    // A federal-holiday FRIDAY still belongs to FRI, not MTH.
    const goodFriday = bucketSlotCounts([callSlot('2026-08-14', 'C1', {}, 'federal_holiday')]);
    expect(goodFriday.FRI_C1).toBe(1);
    expect(goodFriday.MTH_C1).toBe(0);
  });

  it('folds split segments under their PARENT code at their burden weight', () => {
    const sunday = '2026-08-16';
    const counts = bucketSlotCounts([
      callSlot(sunday, 'C1D12', { parent_call_code: 'C1', call_burden_weight: 0.5 }),
      callSlot(sunday, 'C1N12', { parent_call_code: 'C1', call_burden_weight: 0.5 }),
    ]);
    expect(counts.SUN_C1).toBe(1); // one call, not two
  });

  it('ignores non-call categories and call codes with no workbook bucket', () => {
    const counts = bucketSlotCounts([
      { slot_date: '2026-08-11', derived_day_type: 'weekday', shift_types: { code: 'D1', category: 'regular' } },
      callSlot('2026-08-11', 'CB'), // beeper — not C1/C2/NEURO
      { slot_date: '2026-08-11', derived_day_type: 'weekday', shift_types: null },
    ]);
    expect(counts).toEqual(zeroBuckets());
  });

  it('counts NEURO in weekend UNITS: a pair is 1, a lone day 0.5, Mon–Thu nothing', () => {
    const pair = bucketSlotCounts([callSlot('2026-08-15', 'C3'), callSlot('2026-08-16', 'C3')]);
    expect(pair.NEURO_FSS).toBe(1);
    const lone = bucketSlotCounts([callSlot('2026-08-15', 'C3')]);
    expect(lone.NEURO_FSS).toBe(0.5);
    const midweek = bucketSlotCounts([callSlot('2026-08-12', 'C3')]);
    expect(midweek.NEURO_FSS).toBe(0);
    // Friday + Saturday + Sunday neuro is still ONE weekend.
    const triple = bucketSlotCounts([
      callSlot('2026-08-14', 'C3'), callSlot('2026-08-15', 'C3'), callSlot('2026-08-16', 'C3'),
    ]);
    expect(triple.NEURO_FSS).toBe(1);
  });

  it('honors a non-default code map', () => {
    const counts = bucketSlotCounts(
      [callSlot('2026-08-15', 'PC1'), callSlot('2026-08-15', 'NEU')],
      { codeMap: { C1: 'PC1', C2: 'PC2', NEURO: 'NEU' } },
    );
    expect(counts.SAT_C1).toBe(1);
    expect(counts.NEURO_FSS).toBe(0.5);
  });
});

// ── derivation ───────────────────────────────────────────────────────────────

describe('derivedTargetsFor', () => {
  it('reproduces his stated obligation numbers on the live block (par 11)', () => {
    const full = derivedTargetsFor(1, PAOLI_BASIS);
    expect(full.MTH_C1).toBe(4);
    expect(full.MTH_C2).toBe(4);
    expect(full.FRI_C1).toBe(1);
    expect(full.SAT_C1).toBe(1);
    expect(full.SUN_C1).toBe(1);
  });

  it('scales by FTE, exactly and fractionally (never rounded)', () => {
    expect(derivedTargetsFor(0.75, PAOLI_BASIS).MTH_C1).toBe(3);
    expect(derivedTargetsFor(0.75, PAOLI_BASIS).SAT_C1).toBe(0.75);
    expect(derivedTargetsFor(0.5, PAOLI_BASIS).MTH_C1).toBe(2);
    expect(derivedTargetsFor(0.66, PAOLI_BASIS).MTH_C1).toBe(2.64);
    expect(derivedTargetsFor(0.66, PAOLI_BASIS).SUN_C2).toBe(0.66);
  });

  it('derives NEURO from the pattern bands, NOT the FTE formula', () => {
    // BOUNDARY MOVED 0.75 → 0.6 (Gabriel 2026-07-27, second revision). His rule
    // is "every call taker gets a neuro weekend call, EXCEPT for horan". At 0.75
    // the bands created a second exception nobody asked for: Hussain is 0.66
    // (a third of his time is ICU) and fell into the half band alongside Horan.
    // Bands are now: 0.6+ → 1 full weekend, below → 0.5 (one weekend DAY).
    expect(derivedTargetsFor(1, PAOLI_BASIS)[NEURO_BUCKET]).toBe(1);
    expect(derivedTargetsFor(0.75, PAOLI_BASIS)[NEURO_BUCKET]).toBe(1);
    expect(derivedTargetsFor(0.66, PAOLI_BASIS)[NEURO_BUCKET]).toBe(1); // Hussain — was 0.5
    expect(derivedTargetsFor(0.5, PAOLI_BASIS)[NEURO_BUCKET]).toBe(0.5); // Horan, the sole exception
    // Sharpest discriminator against the FTE formula: below the boundary the
    // formula would say 11/11 × 0.58 = 0.58, the band says half a weekend.
    expect(derivedTargetsFor(0.58, PAOLI_BASIS)[NEURO_BUCKET]).toBe(0.5);
    // The EFFECTIVE floor is 0.59, not 0.6: owedUnitsFor clears a band when
    // `fte + WEIGHT_EPSILON >= minFte`, and the house epsilon is 0.01. That is
    // deliberate (the same stored-fraction tolerance used across the engine),
    // and harmless here — real FTEs are quarters and thirds, nowhere near it.
    expect(derivedTargetsFor(0.59, PAOLI_BASIS)[NEURO_BUCKET]).toBe(1);
  });

  it('a site with no neuro requirement derives 0 units', () => {
    expect(derivedTargetsFor(1, { ...PAOLI_BASIS, neuro: null })[NEURO_BUCKET]).toBe(0);
  });

  it('a nonpositive par derives zeros rather than Infinity (fteWeightedTarget guard)', () => {
    expect(derivedTargetsFor(1, { ...PAOLI_BASIS, parLevel: 0 }).MTH_C1).toBe(0);
  });

  it('derivedTargets keys the whole roster by provider id', () => {
    const map = derivedTargets(
      [{ providerId: 'p1', fte: 1 }, { providerId: 'p2', fte: 0.5 }], PAOLI_BASIS,
    );
    expect(map.get('p1')!.MTH_C1).toBe(4);
    expect(map.get('p2')!.MTH_C1).toBe(2);
  });

  it('NEURO_BUCKET is the engine NEURO_KEY (rename pin)', () => {
    expect(NEURO_BUCKET).toBe(NEURO_KEY);
  });
});

// ── linkage grammar ──────────────────────────────────────────────────────────

describe('linkage member grammar', () => {
  it('builds weekday- and date-scoped members', () => {
    expect(linkageMember('FRI', 'C1')).toBe('FRI:C1');
    expect(linkageMember('sun', 'ANY')).toBe('SUN:ANY');
    expect(linkageMember('2026-09-05', 'C2')).toBe('2026-09-05:C2');
    expect(linkageMember('SAT', 'NEURO')).toBe('SAT:NEURO');
  });

  it('throws on a scope or code the ENGINE could not parse', () => {
    expect(() => linkageMember('FRIDAY', 'C1')).toThrow(/weekday code/);
    expect(() => linkageMember('9/5', 'C1')).toThrow(/weekday code/);
    // @ts-expect-error deliberately invalid code
    expect(() => linkageMember('FRI', 'C4')).toThrow(/must be C1, C2, NEURO or ANY/);
  });

  it('parseLinkageMember agrees with the engine on what is parseable', () => {
    expect(parseLinkageMember('FRI:C1')).toEqual({ scope: 'FRI', code: 'C1', dow: 5, date: null });
    expect(parseLinkageMember('2026-09-05:C2'))
      .toEqual({ scope: '2026-09-05', code: 'C2', dow: null, date: '2026-09-05' });
    expect(parseLinkageMember('Horan')).toBeNull();       // a split-12h member
    expect(parseLinkageMember('FRIDAY:C1')).toBeNull();
  });

  it('eitherOrLinkage needs two members and emits the descriptor strings', () => {
    const l = eitherOrLinkage(
      [{ scope: 'FRI', code: 'C1' }, { scope: 'SUN', code: 'C1' }],
      { source: 'Hussain: one Friday or one Sunday call — engine’s choice' },
    );
    expect(l).toMatchObject({ kind: 'either-or', members: ['FRI:C1', 'SUN:C1'] });
    expect(() => eitherOrLinkage([{ scope: 'FRI', code: 'C1' }], { source: 'x' }))
      .toThrow(/at least two members/);
  });

  it('splitTwelveHourLinkage members are provider NAMES, self first, deduped', () => {
    const l = splitTwelveHourLinkage('Horan', ['Havildar', 'Havildar', 'Horan'], {
      source: 'Horan takes 12h of a Sunday C1', details: 'Sunday C1 12/12 split',
    });
    expect(l).toEqual({
      kind: 'split-12h',
      members: ['Horan', 'Havildar'],
      details: 'Sunday C1 12/12 split',
      source: 'Horan takes 12h of a Sunday C1',
    });
    expect(() => splitTwelveHourLinkage('Horan', ['Horan'], { source: 'x' }))
      .toThrow(/at least one partner/);
  });
});

// ── resolution: blank means derived ──────────────────────────────────────────

describe('resolveTargets', () => {
  const row = (over: Partial<BlockTargetsProvider> = {}): BlockTargetsProvider => ({
    providerId: 'p1', displayName: 'Test', fte: 1, ...over,
  });

  it('blank cells derive; typed cells win', () => {
    const r = resolveTargets(row({ overrides: { SAT_C1: 2 } }), PAOLI_BASIS);
    expect(r.targets.SAT_C1).toBe(2);
    expect(r.targets.MTH_C1).toBe(4);
    expect(r.overridden).toEqual(['SAT_C1']);
    expect(r.derived).toContain('MTH_C1');
    expect(r.derived).not.toContain('SAT_C1');
  });

  it('a typed ZERO is an override, not a blank', () => {
    const r = resolveTargets(row({ overrides: { FRI_C2: 0 } }), PAOLI_BASIS);
    expect(r.targets.FRI_C2).toBe(0);
    expect(r.overridden).toEqual(['FRI_C2']);
  });

  it('an either-or group ZEROES the derived cells it covers (the group ceiling governs)', () => {
    // Without this, a 0.66 FTE would carry FRI_C1 0.66 + SUN_C1 0.66 into the
    // group cap max(1, ceil(1.32)) = 2 and could take BOTH calls.
    const r = resolveTargets(row({
      fte: 0.66,
      linkages: [eitherOrLinkage(
        [{ scope: 'FRI', code: 'C1' }, { scope: 'SUN', code: 'C1' }], { source: 's' })],
    }), PAOLI_BASIS);
    expect(r.targets.FRI_C1).toBe(0);
    expect(r.targets.SUN_C1).toBe(0);
    expect(r.eitherOrCovered).toEqual(['FRI_C1', 'SUN_C1']);
    expect(r.targets.FRI_C2).toBe(0.66); // untouched — C2 is not covered
    expect(r.warnings).toEqual([]);
  });

  it('an ANY member covers both C1 and C2; a NEURO member covers nothing', () => {
    const r = resolveTargets(row({
      linkages: [eitherOrLinkage(
        [{ scope: 'SAT', code: 'ANY' }, { scope: 'SAT', code: 'NEURO' }], { source: 's' })],
    }), PAOLI_BASIS);
    expect(r.eitherOrCovered).toEqual(['SAT_C1', 'SAT_C2']);
    expect(r.targets[NEURO_BUCKET]).toBe(1); // the neuro obligation is untouched
  });

  it('an explicit value inside the group is KEPT, and a group summing past one warns', () => {
    const r = resolveTargets(row({
      overrides: { FRI_C1: 1, SUN_C1: 1 },
      linkages: [eitherOrLinkage(
        [{ scope: 'FRI', code: 'C1' }, { scope: 'SUN', code: 'C1' }], { source: 's' })],
    }), PAOLI_BASIS);
    expect(r.targets.FRI_C1).toBe(1);
    expect(r.targets.SUN_C1).toBe(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/ceiling for the group will be 2/);
  });

  it('an unparseable either-or member warns instead of silently covering nothing', () => {
    const r = resolveTargets(row({
      linkages: [{ kind: 'either-or', members: ['FRIDAY:C1', 'SUN:C1'], source: 's' }],
    }), PAOLI_BASIS);
    expect(r.warnings[0]).toMatch(/not a slot descriptor/);
    expect(r.targets.SUN_C1).toBe(0); // the parseable half still binds
  });
});

// ── the scenario in his own words ────────────────────────────────────────────
// Horan 0.5   — 1 Saturday C1, and 12 hrs of a Sunday C1 (daytime).
// Havildar/Simon 0.75 — 1 Friday C1 and 1 Saturday C1 each; Havildar takes the
//                       other 12 hrs of Horan's Sunday.
// Hussain 0.66 — 2 weekend calls: one Saturday C1, the other EITHER a Friday
//                or a Sunday call ("engine's choice").
// Everyone else — untouched, therefore derived.

const SPLIT_SOURCE = 'Horan takes 12h daytime of a Sunday C1; Havildar takes the other 12h';
const EITHER_OR_SOURCE = "Hussain: the second weekend call is a Friday or a Sunday C1 — engine's choice";

function paoliPanelProviders(): BlockTargetsProvider[] {
  return [
    {
      providerId: 'prov-horan', displayName: 'Horan', fte: 0.5,
      overrides: { SAT_C1: 1, SUN_C1: 0.5 },
      linkages: [splitTwelveHourLinkage('Horan', ['Havildar'], {
        source: SPLIT_SOURCE, details: 'Sunday C1 12/12 — Horan days, Havildar nights',
      })],
    },
    {
      providerId: 'prov-havildar', displayName: 'Havildar', fte: 0.75,
      overrides: { FRI_C1: 1, SAT_C1: 1, SUN_C1: 0.5 },
    },
    {
      providerId: 'prov-simon', displayName: 'Simon', fte: 0.75,
      overrides: { FRI_C1: 1, SAT_C1: 1 },
    },
    {
      providerId: 'prov-hussain', displayName: 'Hussain', fte: 0.66,
      overrides: { SAT_C1: 1 },
      linkages: [eitherOrLinkage(
        [{ scope: 'FRI', code: 'C1' }, { scope: 'SUN', code: 'C1' }],
        { source: EITHER_OR_SOURCE },
      )],
    },
    // Everyone he did not touch — every cell derives.
    { providerId: 'prov-amusa', displayName: 'Amusa', fte: 1 },
    { providerId: 'prov-farkas', displayName: 'Gabriel Farkas', fte: 1 },
    { providerId: 'prov-kalawadia', displayName: 'Kalawadia', fte: 1 },
    { providerId: 'prov-mojica', displayName: 'Mojica', fte: 1 },
    { providerId: 'prov-lin', displayName: 'Lin', fte: 1 },
    { providerId: 'prov-jones', displayName: 'Jones', fte: 1 },
  ];
}

function paoliManifest() {
  return buildBlockManifest({
    providers: paoliPanelProviders(),
    basis: PAOLI_BASIS,
    scheduleLabel: 'Paoli 8/10–10/25',
    defaultYear: 2026,
    generatedAt: '2026-07-27T12:00:00.000Z',
  });
}

describe('buildBlockManifest', () => {
  it('produces a manifest that PASSES paoliBlockManifestSchema', () => {
    const parsed = paoliBlockManifestSchema.safeParse(paoliManifest());
    expect(parsed.success ? [] : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`))
      .toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it('names the PANEL as the producer, so a reader can tell it from an import', () => {
    const m = paoliManifest();
    expect(m.source.workbook).toBe(BLOCK_TARGETS_SOURCE_WORKBOOK);
    expect(m.source.workbook).toMatch(/panel/i);
    expect(isPanelAuthored(m)).toBe(true);
    expect(isPanelAuthored({ source: { workbook: 'Paoli block 2026.xlsx' } })).toBe(false);
  });

  it('states all nine buckets for every provider (zod 4 records are exhaustive)', () => {
    for (const p of paoliManifest().providers) {
      expect(Object.keys(p.targets).sort()).toEqual([...BUCKET_KEYS].sort());
    }
  });

  it('computes its own checksums with nothing to compare against', () => {
    const { checksums } = paoliManifest();
    expect(checksums.expected).toBeNull();
    expect(checksums.ok).toBeNull();
    expect(checksums.computed.providerRows).toBe(10);
    expect(checksums.computed.totalFte).toBe(8.66);
    // 6 × 4 derived + 3 + 3 + 2 + 2.64 = 34.64 M–Th C1 across the roster.
    expect(checksums.computed.targets.MTH_C1).toBe(34.64);
  });

  it('records a blank provider id as an ERROR (the engine would drop the row)', () => {
    const m = buildBlockManifest({
      providers: [{ providerId: '  ', displayName: 'Nobody', fte: 1 }],
      basis: PAOLI_BASIS,
    });
    expect(m.errors[0]).toMatch(/no provider id/);
    expect(m.providers[0].providerId).toBeNull();
    expect(paoliBlockManifestSchema.safeParse(m).success).toBe(true);
  });

  it('flags a duplicated provider id', () => {
    const m = buildBlockManifest({
      providers: [
        { providerId: 'p1', displayName: 'A', fte: 1 },
        { providerId: 'p1', displayName: 'B', fte: 1 },
      ],
      basis: PAOLI_BASIS,
    });
    expect(m.errors[0]).toMatch(/duplicate provider id/);
  });
});

// ── derived-vs-overridden memory ─────────────────────────────────────────────

describe('panel state (blank means derived, across a save/reopen)', () => {
  it('stores the typed KEYS only — never a second copy of the numbers', () => {
    const state = readPanelState(paoliManifest())!;
    expect(state.version).toBe(BLOCK_TARGETS_PANEL_STATE_VERSION);
    expect(state.overrides).toEqual({
      'prov-horan': ['SAT_C1', 'SUN_C1'],
      'prov-havildar': ['FRI_C1', 'SAT_C1', 'SUN_C1'],
      'prov-simon': ['FRI_C1', 'SAT_C1'],
      'prov-hussain': ['SAT_C1'],
    });
    expect(state.basis.parLevel).toBe(11);
    expect(state.basis.slotCounts.MTH_C1).toBe(44);
    expect(JSON.stringify(state)).not.toContain('2.64'); // no number lives twice
  });

  it('re-opening does NOT freeze derived cells: they re-derive against a NEW basis', () => {
    const stored = paoliManifest();
    const reopened = readPanelProviders(stored);
    // A slot was added to the block since the save (one more M–Th C1).
    const newBasis: DerivationBasis = {
      ...PAOLI_BASIS,
      slotCounts: { ...PAOLI_BASIS.slotCounts, MTH_C1: 55 },
    };
    const rebuilt = buildBlockManifest({ providers: reopened, basis: newBasis });
    const amusa = rebuilt.providers.find(p => p.providerId === 'prov-amusa')!;
    expect(amusa.targets.MTH_C1).toBe(5); // 55 ÷ 11 × 1.0 — followed the block
    const horan = rebuilt.providers.find(p => p.providerId === 'prov-horan')!;
    expect(horan.targets.MTH_C1).toBe(2.5); // derived, followed the block
    expect(horan.targets.SAT_C1).toBe(1);   // TYPED — held
    expect(horan.targets.SUN_C1).toBe(0.5); // TYPED — held
  });

  it('a save/reopen/save cycle on the SAME basis is a fixed point', () => {
    const first = paoliManifest();
    const second = buildBlockManifest({
      providers: readPanelProviders(first),
      basis: PAOLI_BASIS,
      scheduleLabel: 'Paoli 8/10–10/25',
      defaultYear: 2026,
      generatedAt: '2026-07-27T12:00:00.000Z',
    });
    expect(second).toEqual(first);
  });

  it('an IMPORTED manifest (no sidecar) treats every stated number as typed', () => {
    const imported = { ...paoliManifest(), blockTargets: undefined };
    expect(readPanelState(imported)).toBeNull();
    const rows = readPanelProviders(imported);
    const amusa = rows.find(r => r.providerId === 'prov-amusa')!;
    expect(amusa.overrides!.MTH_C1).toBe(4); // a workbook cell is an author's number
  });

  it('readPanelState is defensive about junk jsonb', () => {
    expect(readPanelState(null)).toBeNull();
    expect(readPanelState({ blockTargets: 'nope' })).toBeNull();
    expect(readPanelState({ blockTargets: { version: 99, overrides: {} } })).toBeNull();
    const salvaged = readPanelState({
      blockTargets: { version: 1, overrides: { p1: ['SAT_C1', 'BOGUS'] }, basis: {}, savedAt: 1 },
    })!;
    expect(salvaged.overrides).toEqual({ p1: ['SAT_C1'] });
    expect(salvaged.basis.slotCounts).toEqual(zeroBuckets());
  });
});

// ── the round trip: manifest → projectScenario → engine ceilings ─────────────

describe('round trip: the panel manifest through the ENGINE', () => {
  const manifest = paoliManifest();
  const knownProviderIds = new Set(paoliPanelProviders().map(p => p.providerId));
  const projected = projectScenario(manifest, { knownProviderIds });

  it('projects cleanly — every provider matched, no warnings', () => {
    expect(projected.warnings).toEqual([]);
    expect(projected.scenario).not.toBeNull();
    expect(projected.scenario!.providers.size).toBe(10);
    expect(projected.scenario!.neuroCode).toBe('C3');
  });

  it('untouched providers arrive at the engine with the FORMULA numbers', () => {
    const amusa = projected.scenario!.providers.get('prov-amusa')!;
    expect(Object.fromEntries(amusa.targets)).toEqual({
      'MTH|C1': 4, 'MTH|C2': 4,
      'FRI|C1': 1, 'FRI|C2': 1,
      'SAT|C1': 1, 'SAT|C2': 1,
      'SUN|C1': 1, 'SUN|C2': 1,
    });
    expect(amusa.neuroTarget).toBe(1);
    expect(amusa.scenarioFte).toBe(1);
  });

  it("Horan: one Saturday C1, half a Sunday C1, one neuro weekend DAY", () => {
    const horan = projected.scenario!.providers.get('prov-horan')!;
    expect(horan.targets.get('SAT|C1')).toBe(1);
    expect(horan.targets.get('SUN|C1')).toBe(0.5); // the 12h daytime portion
    expect(horan.targets.get('MTH|C1')).toBe(2);   // derived, 44 ÷ 11 × 0.5
    expect(horan.neuroTarget).toBe(0.5);
    const split = horan.linkages.find(l => l.kind === 'split-12h')!;
    expect(split.rawMembers).toEqual(['Horan', 'Havildar']);
    expect(split.members).toEqual([]); // provider names never parse as slots
    expect(split.source).toBe(SPLIT_SOURCE);
  });

  it('Havildar and Simon: a Friday C1 and a Saturday C1 each; Havildar holds Horan’s other 12h', () => {
    const hav = projected.scenario!.providers.get('prov-havildar')!;
    const simon = projected.scenario!.providers.get('prov-simon')!;
    for (const p of [hav, simon]) {
      expect(p.targets.get('FRI|C1')).toBe(1);
      expect(p.targets.get('SAT|C1')).toBe(1);
      expect(p.targets.get('MTH|C1')).toBe(3); // derived, 44 ÷ 11 × 0.75
      expect(p.neuroTarget).toBe(1);
    }
    expect(hav.targets.get('SUN|C1')).toBe(0.5);   // the other half of the split
    expect(simon.targets.get('SUN|C1')).toBe(0.75); // untouched → derived
  });

  it("Hussain: a Saturday C1 plus ONE of Friday/Sunday — the engine picks", () => {
    const h = projected.scenario!.providers.get('prov-hussain')!;
    expect(h.targets.get('SAT|C1')).toBe(1);
    expect(h.targets.get('FRI|C1')).toBe(0); // owned by the either-or group
    expect(h.targets.get('SUN|C1')).toBe(0);
    expect(h.targets.get('MTH|C1')).toBe(2.64); // derived, 44 ÷ 11 × 0.66
    const eo = h.linkages.find(l => l.kind === 'either-or')!;
    expect(eo.rawMembers).toEqual(['FRI:C1', 'SUN:C1']);
    expect(eo.members).toEqual([
      { dow: 5, date: null, code: 'C1' },
      { dow: 0, date: null, code: 'C1' },
    ]);
    expect(eo.source).toBe(EITHER_OR_SOURCE);
  });

  it('the ENGINE CEILINGS come out right — the either-or admits exactly one call', () => {
    const caps = buildScenarioCallCaps(projected.scenario)!;
    const hussain = caps.get('prov-hussain')!;
    // The group cap is the whole point: FRI|C1 and SUN|C1 are FOLDED into it
    // (no individual keys), and it admits ONE.
    expect(hussain.get('S:EO#0')).toBe(1);
    expect(hussain.has('S:FRI|C1')).toBe(false);
    expect(hussain.has('S:SUN|C1')).toBe(false);
    expect(hussain.get('S:SAT|C1')).toBe(1);
    expect(hussain.get('S:NEURO_FSS')).toBe(1); // ceil(0.5) — one weekend day
    // Horan's half-Sunday admits one whole placement (or a 0.5 segment).
    expect(caps.get('prov-horan')!.get('S:SUN|C1')).toBe(1);
    expect(caps.get('prov-amusa')!.get('S:MTH|C1')).toBe(4);
  });

  it('projectScenario would DROP an unmatched row — the builder never emits one', () => {
    // Guard on the guard: prove the warning path exists, so the clean run above
    // means something.
    const bad = buildBlockManifest({
      providers: [{ providerId: '', displayName: 'Ghost', fte: 1 }], basis: PAOLI_BASIS,
    });
    const res = projectScenario(bad, {});
    expect(res.warnings[0]).toMatch(/unmatched/);
    expect(res.scenario!.providers.size).toBe(0);
  });
});

// ── feasibility ──────────────────────────────────────────────────────────────

describe('checkFeasibility', () => {
  it('reports the paid-pickup remainder as UNDER, never as an error', () => {
    const rows = checkManifestFeasibility(paoliManifest(), PAOLI_BASIS.slotCounts);
    const mth = rows.find(r => r.bucket === 'MTH_C1')!;
    expect(mth).toMatchObject({ slots: 44, stated: 34.64, delta: -9.36, status: 'under' });
    expect(rows.every(r => !r.overConstrained)).toBe(true);
    // ΣFTE 8.66 under a par of 11 — under-covering is the design, not a fault.
    expect(rows.filter(r => r.status === 'over')).toEqual([]);
  });

  it('flags a bucket whose stated targets EXCEED the slots that exist', () => {
    const counts = { ...zeroBuckets(), SAT_C1: 11 };
    const rows = checkFeasibility(
      Array.from({ length: 12 }, () => ({ ...zeroBuckets(), SAT_C1: 1 })), counts,
    );
    const sat = rows.find(r => r.bucket === 'SAT_C1')!;
    expect(sat).toMatchObject({ slots: 11, stated: 12, delta: 1, status: 'over', overConstrained: true });
  });

  it('exact is exact, and fraction noise never reads as over', () => {
    const counts = { ...zeroBuckets(), SUN_C1: 1 };
    const thirds = checkFeasibility(
      [0.3333, 0.3333, 0.3333].map(v => ({ ...zeroBuckets(), SUN_C1: v })), counts,
    );
    expect(thirds.find(r => r.bucket === 'SUN_C1')!.status).toBe('exact');
    const exact = checkFeasibility([{ ...zeroBuckets(), SUN_C1: 1 }], counts);
    expect(exact.find(r => r.bucket === 'SUN_C1')!.status).toBe('exact');
  });

  it('covers the neuro bucket in weekend units', () => {
    const rows = checkManifestFeasibility(paoliManifest(), PAOLI_BASIS.slotCounts);
    const neuro = rows.find(r => r.bucket === NEURO_BUCKET)!;
    // 9 docs at 1.0 unit + Horan 0.5 = 9.5 against 11 weekends. Hussain moved
    // from 0.5 to 1.0 when the band boundary went 0.75 → 0.6 (2026-07-27) —
    // Horan is now the only doc owing half a neuro weekend, which is the rule.
    expect(neuro).toMatchObject({ slots: 11, stated: 9.5, status: 'under' });
  });

  it('returns one row per bucket, in BUCKET_KEYS order', () => {
    expect(checkFeasibility([], zeroBuckets()).map(r => r.bucket)).toEqual([...BUCKET_KEYS]);
  });
});
