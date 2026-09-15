/**
 * Editing the call pattern.
 *
 * This is the module that stands between a sentence somebody typed and the
 * structure the scheduler runs on, so its failure modes matter more than its
 * successes. The two that would do real damage:
 *   - applying a change that produces an invalid document, which the engine
 *     answers by silently falling back to the classic pattern;
 *   - quietly doing NOTHING, which a reviewer reads as "no change needed".
 * Both are tested harder than the happy path.
 */
import { describe, it, expect } from 'vitest';
import { applyPatternEdits, diffSchedulingLogic, type PatternEdit } from './patternEdit';
import { CLASSIC_PATTERN, type CallPatternDoc } from './rulesEngine/callPattern';

/** Paoli-shaped: a saturday block with three chains, plus a friday block. */
const PAOLI: CallPatternDoc = {
  ...CLASSIC_PATTERN,
  blocks: [
    {
      anchorDayType: 'saturday',
      chains: [
        { trigger: 'C3', links: [{ code: 'D4', offset: -1 }, { code: 'C3', offset: 1 }] },
        { trigger: 'C1', links: [{ code: 'D2', offset: -1 }] },
        { trigger: 'C2', links: [{ code: 'C2', offset: -1 }, { code: 'C1', offset: 1 }] },
      ],
    },
    { anchorDayType: 'friday', chains: [{ trigger: 'C1', links: [{ code: 'C2', offset: 2 }] }] },
  ],
};

const CTX = { shiftTypes: [], parLevel: 11 };
const ok = (r: ReturnType<typeof applyPatternEdits>) => {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r.doc;
};

describe('the changes Gabriel described', () => {
  it('links Saturday C1 to a Sunday C2', () => {
    const doc = ok(applyPatternEdits(PAOLI, [
      { op: 'add_block_link', anchorDayType: 'saturday', trigger: 'C1', code: 'C2', offset: 1 },
    ]));
    expect(diffSchedulingLogic(PAOLI, doc, CTX)).toMatchObject({
      removed: ['Saturday C1 — the same provider also takes D2 on Friday.'],
      added: ['Saturday C1 — the same provider also takes D2 on Friday and C2 on Sunday.'],
    });
  });

  it('gives Friday C1 the Saturday AND Sunday neuro call', () => {
    const doc = ok(applyPatternEdits(PAOLI, [
      { op: 'add_block_link', anchorDayType: 'friday', trigger: 'C1', code: 'C3', offset: 1 },
      { op: 'add_block_link', anchorDayType: 'friday', trigger: 'C1', code: 'C3', offset: 2 },
    ]));
    expect(diffSchedulingLogic(PAOLI, doc, CTX).added).toEqual([
      'Friday C1 — the same provider also takes C2 on Sunday, C3 on Saturday and C3 on Sunday.',
    ]);
  });
});

describe('refusing rather than quietly doing nothing', () => {
  it('rejects a link that is already there', () => {
    // An empty diff reads as "no change needed", so the misunderstanding would
    // survive the review it was supposed to face.
    const r = applyPatternEdits(PAOLI, [
      { op: 'add_block_link', anchorDayType: 'saturday', trigger: 'C1', code: 'D2', offset: -1 },
    ]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('already places D2 at offset -1');
  });

  it('rejects an anchor the pattern does not have', () => {
    const r = applyPatternEdits(PAOLI, [
      { op: 'remove_block_chain', anchorDayType: 'weekday', trigger: 'C9' },
    ]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('no weekday block');
  });

  it('rejects a trigger the anchor does not have', () => {
    const r = applyPatternEdits(PAOLI, [
      { op: 'add_block_link', anchorDayType: 'friday', trigger: 'C7', code: 'C2', offset: 1 },
    ]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('no friday C7 chain');
  });

  it('rejects removing a link that is not there', () => {
    const r = applyPatternEdits(PAOLI, [
      { op: 'remove_block_link', anchorDayType: 'saturday', trigger: 'C1', code: 'C2', offset: 1 },
    ]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('does not place C2 at offset 1');
  });

  it('rejects an empty proposal', () => {
    expect(applyPatternEdits(PAOLI, [])).toMatchObject({ ok: false });
  });

  it('numbers the failing change when several were proposed', () => {
    const r = applyPatternEdits(PAOLI, [
      { op: 'add_block_link', anchorDayType: 'saturday', trigger: 'C1', code: 'C2', offset: 1 },
      { op: 'add_block_link', anchorDayType: 'saturday', trigger: 'C1', code: 'C2', offset: 1 },
    ]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/^Change 2:/);
  });
});

describe('structural edits', () => {
  it('adds a chain to an anchor that has none', () => {
    const doc = ok(applyPatternEdits(PAOLI, [
      { op: 'add_block_chain', anchorDayType: 'sunday', trigger: 'C1', links: [{ code: 'D1', offset: 1 }] },
    ]));
    expect(doc.blocks.find(b => b.anchorDayType === 'sunday')?.chains).toHaveLength(1);
  });

  it('refuses to create a chain that exists', () => {
    const r = applyPatternEdits(PAOLI, [
      { op: 'add_block_chain', anchorDayType: 'friday', trigger: 'C1', links: [{ code: 'D1', offset: 1 }] },
    ]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('already exists');
  });

  it('drops a block left with no chains, rather than leaving an empty one', () => {
    // An anchor with zero chains fails the schema, and the resulting error
    // would describe a shape nobody asked for.
    const doc = ok(applyPatternEdits(PAOLI, [
      { op: 'remove_block_chain', anchorDayType: 'friday', trigger: 'C1' },
    ]));
    expect(doc.blocks.map(b => b.anchorDayType)).toEqual(['saturday']);
  });

  it('refuses to strip a chain down to nothing via link removal', () => {
    const r = applyPatternEdits(PAOLI, [
      { op: 'remove_block_link', anchorDayType: 'friday', trigger: 'C1', code: 'C2', offset: 2 },
    ]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('Remove the whole chain instead');
  });

  it('sets and clears an FTE floor', () => {
    const raised = ok(applyPatternEdits(PAOLI, [
      { op: 'set_block_link_min_fte', anchorDayType: 'saturday', trigger: 'C3', code: 'C3', offset: 1, minFte: 0.5 },
    ]));
    expect(diffSchedulingLogic(PAOLI, raised, CTX).added[0]).toContain('0.5 FTE or above');

    const cleared = ok(applyPatternEdits(raised, [
      { op: 'set_block_link_min_fte', anchorDayType: 'saturday', trigger: 'C3', code: 'C3', offset: 1, minFte: null },
    ]));
    expect(diffSchedulingLogic(raised, cleared, CTX).added[0]).not.toContain('FTE');
  });
});

describe('the schema gate', () => {
  it('rejects a result the engine would not accept', () => {
    // The reason this gate exists: the engine does NOT error on an invalid
    // pattern, it silently falls back to CLASSIC_PATTERN. A bad write would
    // schedule something nobody asked for at a site that looks configured.
    const r = applyPatternEdits(PAOLI, [
      { op: 'add_block_link', anchorDayType: 'saturday', trigger: 'C1', code: 'C2', offset: 99 },
    ]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('would not be a valid call pattern');
  });

  it('rejects an empty code, which would name no shift at all', () => {
    const r = applyPatternEdits(PAOLI, [
      { op: 'add_block_link', anchorDayType: 'saturday', trigger: 'C1', code: '', offset: 1 },
    ]);
    expect(r).toMatchObject({ ok: false });
  });
});

describe('the original document', () => {
  it('is never mutated, even when an edit later fails', () => {
    // A half-applied edit surviving on the caller's object would be invisible
    // and would outlive the rejection.
    const before = JSON.stringify(PAOLI);
    applyPatternEdits(PAOLI, [
      { op: 'add_block_link', anchorDayType: 'saturday', trigger: 'C1', code: 'C2', offset: 1 },
      { op: 'add_block_link', anchorDayType: 'nowhere' as never, trigger: 'C1', code: 'X', offset: 1 },
    ]);
    expect(JSON.stringify(PAOLI)).toBe(before);
  });
});

describe('the diff', () => {
  it('reports no change when behaviour is unchanged', () => {
    expect(diffSchedulingLogic(PAOLI, PAOLI, CTX).identical).toBe(true);
  });

  it('ignores the hard-coded invariants, which no pattern edit can move', () => {
    const doc = ok(applyPatternEdits(PAOLI, [
      { op: 'add_block_link', anchorDayType: 'saturday', trigger: 'C1', code: 'C2', offset: 1 },
    ]));
    const d = diffSchedulingLogic(PAOLI, doc, CTX);
    expect([...d.added, ...d.removed].join(' ')).not.toContain('PENDING time off');
  });

  it('describes a removal as well as an addition', () => {
    const doc = ok(applyPatternEdits(PAOLI, [
      { op: 'remove_block_chain', anchorDayType: 'friday', trigger: 'C1' },
    ]));
    const d = diffSchedulingLogic(PAOLI, doc, CTX);
    expect(d.removed).toContain('Friday C1 — the same provider also takes C2 on Sunday.');
    expect(d.added).toEqual([]);
  });
});
