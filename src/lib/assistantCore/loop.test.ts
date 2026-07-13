// assistantCore/loop tests — the domain-generic tool loop, exercised with a
// fake Anthropic client (canned tool_use turns) and plain in-memory executors
// plus a snapshot stub (no supabase — the loop owns only conversation
// mechanics). These five behaviors mirror what scheduleAssistant/assistant.
// test.ts pins on the schedule adapter, but at the generic seam:
//   (a) the snapshot is taken exactly ONCE, before the first mutating tool;
//       its id lands in done.actionId; usage accumulates across turns
//   (b) takeSnapshot → null: mutating tools refuse (is_error) and never run,
//       while read tools still run
//   (c) an executor throw → is_error tool_result and the loop continues
//       (ToolInputError-named errors surface verbatim; others get a prefix)
//   (d) tool results longer than maxToolResultChars are truncated
//   (e) stop_reason 'max_tokens' appends the truncation-notice event
import { describe, it, expect, vi } from 'vitest';
import { runAssistantLoop, type AssistantEvent, type AssistantLoopDeps } from './loop';
import type {
  AssistantClientLike,
  AssistantFinalMessage,
  AssistantStreamParams,
  ContentBlock,
} from './client';

// ─── Fake Anthropic client (same shape as assistant.test.ts's) ───────────────

function makeFakeClient(turns: AssistantFinalMessage[]) {
  const calls: AssistantStreamParams[] = [];
  let i = 0;
  const client: AssistantClientLike = {
    stream(params: AssistantStreamParams) {
      calls.push(params);
      const msg = turns[Math.min(i, turns.length - 1)];
      i++;
      return { on: () => undefined, finalMessage: async () => msg };
    },
  };
  return { client, calls };
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: unknown): ContentBlock =>
  ({ type: 'tool_use', id, name, input });
const endTurn = (blocks: ContentBlock[]): AssistantFinalMessage =>
  ({ content: blocks, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
const toolTurn = (blocks: ContentBlock[]): AssistantFinalMessage =>
  ({ content: blocks, stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } });

// Default deps with sensible no-ops; each test overrides what it exercises.
function baseDeps(client: AssistantClientLike, over: Partial<AssistantLoopDeps>): AssistantLoopDeps {
  return {
    client,
    systemPrompt: 'system prompt',
    tools: [],
    executors: {},
    mutatingTools: new Set<string>(),
    takeSnapshot: async () => 'action-default',
    messages: [{ role: 'user', content: 'hi' }],
    onEvent: () => undefined,
    ...over,
  };
}

function toolResultsOf(call: AssistantStreamParams) {
  const last = call.messages[call.messages.length - 1];
  return (last.content as ContentBlock[]).filter(
    (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runAssistantLoop', () => {
  it('(a) snapshots exactly once BEFORE the first mutating tool; id lands in done.actionId; usage accumulates', async () => {
    const order: string[] = [];
    const { client } = makeFakeClient([
      toolTurn([toolUse('r1', 'read', {}), toolUse('m1', 'edit', { x: 1 })]),
      toolTurn([toolUse('m2', 'edit', { x: 2 })]),
      endTurn([text('done')]),
    ]);
    const takeSnapshot = vi.fn(async () => { order.push('snapshot'); return 'act-1'; });
    const edit = vi.fn(async () => { order.push('edit'); return { result: { ok: true }, summary: 'edited' }; });
    const read = vi.fn(async () => { order.push('read'); return { result: 'data' }; });
    const events: AssistantEvent[] = [];

    const out = await runAssistantLoop(baseDeps(client, {
      executors: { read, edit },
      mutatingTools: new Set(['edit']),
      takeSnapshot,
      onEvent: e => events.push(e),
    }));

    // Snapshot taken once, and before any mutating executor ran.
    expect(takeSnapshot).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('snapshot');
    expect(order.indexOf('snapshot')).toBeLessThan(order.indexOf('edit'));
    // Its id is the returned + emitted action id.
    expect(out.actionId).toBe('act-1');
    // One change chip per successful mutating tool call.
    expect(out.changes).toEqual(['edited', 'edited']);
    // Usage summed across all three turns.
    expect(out.usage.input_tokens).toBe(30);
    expect(out.usage.output_tokens).toBe(15);
    // The terminal event is `done`, carrying the action id.
    const lastEvent = events[events.length - 1];
    expect(lastEvent).toMatchObject({ type: 'done', actionId: 'act-1' });
  });

  it('(b) refuses mutating tools (is_error) and never runs them when takeSnapshot resolves null; reads still run', async () => {
    const { client, calls } = makeFakeClient([
      toolTurn([toolUse('r1', 'read', {}), toolUse('m1', 'edit', {})]),
      endTurn([text('could not edit')]),
    ]);
    const edit = vi.fn(async () => ({ result: { ok: true }, summary: 'edited' }));
    const read = vi.fn(async () => ({ result: 'data' }));

    const out = await runAssistantLoop(baseDeps(client, {
      executors: { read, edit },
      mutatingTools: new Set(['edit']),
      takeSnapshot: async () => null,
    }));

    expect(edit).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);

    const results = toolResultsOf(calls[1]);
    const editResult = results.find(r => r.tool_use_id === 'm1')!;
    expect(editResult.is_error).toBe(true);
    expect(String(editResult.content)).toMatch(/snapshot/i);
    const readResult = results.find(r => r.tool_use_id === 'r1')!;
    expect(readResult.is_error).not.toBe(true);

    expect(out.actionId).toBeNull();
    expect(out.changes).toHaveLength(0);
  });

  it('(c) continues after an executor throw; ToolInputError surfaces verbatim, other errors get a prefix', async () => {
    const { client, calls } = makeFakeClient([
      toolTurn([toolUse('t1', 'boom', {}), toolUse('t2', 'badinput', {})]),
      endTurn([text('recovered')]),
    ]);
    const boom = vi.fn(async () => { throw new Error('kaboom'); });
    const badinput = vi.fn(async () => {
      const e = new Error('field x is required');
      e.name = 'ToolInputError';
      throw e;
    });

    const out = await runAssistantLoop(baseDeps(client, {
      executors: { boom, badinput },
    }));

    const results = toolResultsOf(calls[1]);
    const boomR = results.find(r => r.tool_use_id === 't1')!;
    expect(boomR.is_error).toBe(true);
    expect(String(boomR.content)).toBe('Tool failed: kaboom');
    const inputR = results.find(r => r.tool_use_id === 't2')!;
    expect(inputR.is_error).toBe(true);
    // Input-validation errors are shown to the model verbatim (self-correction).
    expect(String(inputR.content)).toBe('field x is required');

    // The loop made a second request and finished cleanly.
    expect(calls).toHaveLength(2);
    expect(out.changes).toHaveLength(0);
  });

  it('(d) truncates tool results longer than maxToolResultChars', async () => {
    const big = 'x'.repeat(500);
    const { client, calls } = makeFakeClient([
      toolTurn([toolUse('t1', 'big', {})]),
      endTurn([text('ok')]),
    ]);

    await runAssistantLoop(baseDeps(client, {
      executors: { big: async () => ({ result: big }) },
      maxToolResultChars: 50,
    }));

    const [r] = toolResultsOf(calls[1]);
    expect(String(r.content)).toMatch(/truncated/i);
    expect(String(r.content).length).toBeLessThan(big.length);
    expect(String(r.content).startsWith('xxxxx')).toBe(true);
  });

  it('(e) appends a truncation-notice event when stop_reason is max_tokens', async () => {
    const { client } = makeFakeClient([
      { content: [text('partial answer')], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 16000 } },
    ]);
    const events: AssistantEvent[] = [];

    const out = await runAssistantLoop(baseDeps(client, {
      onEvent: e => events.push(e),
    }));

    const notice = events.find(
      e => e.type === 'text-delta' && /truncated/i.test((e as { text: string }).text),
    );
    expect(notice).toBeTruthy();
    const lastMsg = out.messages[out.messages.length - 1];
    expect(String(lastMsg.content)).toMatch(/truncated/i);
    expect(out.actionId).toBeNull();
  });
});
