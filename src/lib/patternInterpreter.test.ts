/**
 * The text → edits step.
 *
 * Injected fake client, never the network — the house rule for LLM modules
 * here. What is worth testing is not "does the model work" but the boundary
 * around it: that a refusal is surfaced with its reason, that a malformed
 * response is not mistaken for an instruction, and that the prompt describes
 * the pattern the same way the reviewer will read it.
 */
import { describe, it, expect } from 'vitest';
import {
  interpretPatternRequest,
  buildInterpreterPrompt,
  PROPOSE_EDITS_TOOL,
} from './patternInterpreter';
import { applyPatternEdits, diffSchedulingLogic } from './patternEdit';
import { CLASSIC_PATTERN, type CallPatternDoc } from './rulesEngine/callPattern';
import type { AssistantClientLike, ContentBlock } from './assistantCore/client';

const PAOLI: CallPatternDoc = {
  ...CLASSIC_PATTERN,
  blocks: [
    {
      anchorDayType: 'saturday',
      chains: [
        { trigger: 'C1', links: [{ code: 'D2', offset: -1 }] },
        { trigger: 'C2', links: [{ code: 'C2', offset: -1 }, { code: 'C1', offset: 1 }] },
      ],
    },
    { anchorDayType: 'friday', chains: [{ trigger: 'C1', links: [{ code: 'C2', offset: 2 }] }] },
  ],
};

const INPUT = {
  request: 'Saturday C1 should also take C2 on Sunday',
  doc: PAOLI,
  shiftTypes: [
    { code: 'C1', category: 'call' },
    { code: 'C2', category: 'call' },
    { code: 'C3', category: 'call' },
    { code: 'D2', category: 'derived' },
  ],
  parLevel: 11,
  siteName: 'Paoli Hospital',
};

/** A client that replays whatever content blocks the test hands it. */
function fakeClient(content: ContentBlock[], opts: { throws?: Error } = {}): AssistantClientLike {
  return {
    stream() {
      if (opts.throws) throw opts.throws;
      return {
        on() { return undefined; },
        async finalMessage() { return { content }; },
      };
    },
  };
}

const toolCall = (input: unknown): ContentBlock =>
  ({ type: 'tool_use', id: 't1', name: PROPOSE_EDITS_TOOL.name, input });

describe('buildInterpreterPrompt', () => {
  it('describes the pattern in the same English the page shows', () => {
    // Feeding it raw JSON would make it fluent in a representation the
    // reviewer never sees, and its proposals would drift toward shapes that
    // read well as JSON rather than as call structure.
    const p = buildInterpreterPrompt(INPUT);
    expect(p).toContain('Saturday C1 — the same provider also takes D2 on Friday.');
    expect(p).toContain('Friday C1 — the same provider also takes C2 on Sunday.');
  });

  it('lists the codes that exist, so it cannot invent one', () => {
    expect(buildInterpreterPrompt(INPUT)).toContain('C1, C2, C3, D2');
  });

  it('states the offset convention explicitly', () => {
    expect(buildInterpreterPrompt(INPUT)).toContain('Friday is -1 and Sunday is +1');
  });

  it('carries the request verbatim', () => {
    expect(buildInterpreterPrompt(INPUT)).toContain('Saturday C1 should also take C2 on Sunday');
  });

  it('leaves out the invariants, which no edit can move', () => {
    expect(buildInterpreterPrompt(INPUT)).not.toContain('PENDING time off');
  });
});

describe('interpretPatternRequest', () => {
  it('returns the proposed edits', async () => {
    const client = fakeClient([toolCall({
      edits: [{ op: 'add_block_link', anchorDayType: 'saturday', trigger: 'C1', code: 'C2', offset: 1 }],
    })]);
    const r = await interpretPatternRequest(client, INPUT);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.edits).toHaveLength(1);
  });

  it('feeds straight into the deterministic pipeline', async () => {
    // The point of the whole design: what the model says is an input to code,
    // not an instruction to the database.
    const client = fakeClient([toolCall({
      edits: [{ op: 'add_block_link', anchorDayType: 'saturday', trigger: 'C1', code: 'C2', offset: 1 }],
    })]);
    const r = await interpretPatternRequest(client, INPUT);
    if (!r.ok) throw new Error('expected edits');
    const applied = applyPatternEdits(PAOLI, r.edits);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(diffSchedulingLogic(PAOLI, applied.doc, { shiftTypes: [], parLevel: 11 }).added).toEqual([
      'Saturday C1 — the same provider also takes D2 on Friday and C2 on Sunday.',
    ]);
  });

  it('surfaces a refusal WITH its reason rather than a blank failure', async () => {
    const client = fakeClient([toolCall({
      edits: [],
      unsupported: 'Rotating call fairly between two named people is not something the pattern can express.',
    })]);
    const r = await interpretPatternRequest(client, INPUT);
    expect(r).toMatchObject({ ok: false, kind: 'unsupported' });
    if (!r.ok) expect(r.message).toContain('not something the pattern can express');
  });

  it('does not treat a garbage proposal as an instruction', async () => {
    // A model that proposes an edit against a chain that does not exist must
    // be caught by the applier, not by hoping it never happens.
    const client = fakeClient([toolCall({
      edits: [{ op: 'add_block_link', anchorDayType: 'weekday', trigger: 'C9', code: 'C2', offset: 1 }],
    })]);
    const r = await interpretPatternRequest(client, INPUT);
    if (!r.ok) throw new Error('expected edits through');
    expect(applyPatternEdits(PAOLI, r.edits)).toMatchObject({ ok: false });
  });

  it('falls back to prose when no tool was called', async () => {
    const client = fakeClient([{ type: 'text', text: 'I need to know which site you mean.' }]);
    const r = await interpretPatternRequest(client, INPUT);
    expect(r).toMatchObject({ ok: false, kind: 'unsupported' });
    if (!r.ok) expect(r.message).toBe('I need to know which site you mean.');
  });

  it('reports a transport failure as an error, not as "unsupported"', async () => {
    // The two mean different things to the user: one is "rephrase that", the
    // other is "try again later". Collapsing them sends people to rewrite a
    // request that was perfectly fine.
    const client = fakeClient([], { throws: new Error('connection reset') });
    const r = await interpretPatternRequest(client, INPUT);
    expect(r).toMatchObject({ ok: false, kind: 'error' });
    if (!r.ok) expect(r.message).toContain('connection reset');
  });

  it('refuses an empty request without calling out at all', async () => {
    let called = false;
    const client: AssistantClientLike = {
      stream() { called = true; return { on() { return undefined; }, async finalMessage() { return { content: [] }; } }; },
    };
    const r = await interpretPatternRequest(client, { ...INPUT, request: '   ' });
    expect(r).toMatchObject({ ok: false, kind: 'error' });
    expect(called).toBe(false);
  });

  it('treats an empty edit list as unsupported, with a usable default message', async () => {
    const client = fakeClient([toolCall({ edits: [] })]);
    const r = await interpretPatternRequest(client, INPUT);
    expect(r).toMatchObject({ ok: false, kind: 'unsupported' });
    if (!r.ok) expect(r.message.length).toBeGreaterThan(20);
  });

  it('survives a malformed tool input without throwing', async () => {
    const client = fakeClient([toolCall({ edits: 'not an array' })]);
    const r = await interpretPatternRequest(client, INPUT);
    expect(r).toMatchObject({ ok: false });
  });
});
