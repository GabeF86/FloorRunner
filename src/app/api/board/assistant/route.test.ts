// POST /api/board/assistant — the board copilot SSE route. Mirrors the
// scheduling route test conventions: sbBoardServer and the Anthropic client are
// both mocked via hoisted holders (the fake client emits canned tool_use turns,
// never the network); the fake supabase is the stateful in-memory board fake so
// the snapshot→actionRef wiring can be asserted end-to-end.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { makeStatefulSupabase } from '@/lib/boardAssistant/__fixtures__/statefulBoard';
import type {
  AssistantFinalMessage,
  AssistantStreamParams,
  ContentBlock,
} from '@/lib/assistantCore/client';

const holder = vi.hoisted(() => ({ sb: null as unknown, client: null as unknown }));

vi.mock('@/lib/supabaseBoard', () => ({
  sbBoardServer: () => holder.sb,
}));
// Partial mock: keep the real buildRequest / mapAssistantError / types (the loop
// imports buildRequest from this module and runs for real) — only swap the
// default client factory for our injected fake.
vi.mock('@/lib/assistantCore/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assistantCore/client')>();
  return { ...actual, buildDefaultAssistantClient: () => holder.client };
});

import { POST, maxDuration } from './route';

const DATE = '2026-07-12';

// ── Fake Anthropic client (assistant.test.ts pattern) ────────────────────────
function makeFakeClient(turns: AssistantFinalMessage[]) {
  const calls: AssistantStreamParams[] = [];
  let i = 0;
  const client = {
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeReq(body: unknown, opts: { malformed?: boolean } = {}): NextRequest {
  return {
    json: async () => {
      if (opts.malformed) throw new Error('not json');
      return body;
    },
  } as unknown as NextRequest;
}

// Parse the SSE body ("data: {json}\n\n" frames) into event objects.
function parseSSE(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data:\s?/, '')) as Record<string, unknown>);
}

function seedBoard() {
  return {
    staff: [{ id: 'md-a', name: 'Amy Ash', initials: 'AA', role: 'physician', hours: '8hr', hospital: null }],
    daily_active: [{ id: 'ac1', staff_id: 'md-a', board_date: DATE }],
    assignments: [{ id: 'a1', room_id: 'r1', staff_id: 'md-a', board_date: DATE }],
    daily_designations: [{ id: 'dg1', staff_id: 'md-a', board_date: DATE, designation: 'D1' }],
    daily_shifts: [] as Array<Record<string, unknown>>,
    breaks: [] as Array<Record<string, unknown>>,
    relief_log: [] as Array<Record<string, unknown>>,
    board_assistant_actions: [] as Array<Record<string, unknown>>,
  };
}

const OK_BODY = {
  boardDate: DATE,
  hospital: null,
  messages: [{ role: 'user', content: 'hello' }],
};

beforeEach(() => {
  holder.sb = null;
  holder.client = null;
  process.env.ANTHROPIC_API_KEY = 'test-key';
});
afterEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('POST /api/board/assistant', () => {
  it('exports maxDuration = 60', () => {
    expect(maxDuration).toBe(60);
  });

  it('400 when the body is not valid JSON', async () => {
    const res = await POST(makeReq(null, { malformed: true }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/valid JSON/i);
  });

  it('400 on a malformed body (bad date format)', async () => {
    const res = await POST(makeReq({ ...OK_BODY, boardDate: '07/12/2026' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid/i);
    expect(JSON.stringify(json.issues)).toMatch(/boardDate/);
  });

  it('400 on an invalid body (empty messages)', async () => {
    const res = await POST(makeReq({ ...OK_BODY, messages: [] }));
    expect(res.status).toBe(400);
  });

  it('400 on an invalid body (unknown extra key — strict)', async () => {
    const res = await POST(makeReq({ ...OK_BODY, scheduleId: 'nope' }));
    expect(res.status).toBe(400);
  });

  it('500 (plain JSON, no stream) when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await POST(makeReq(OK_BODY));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('happy path: streams a done event carrying usage', async () => {
    const { sb } = makeStatefulSupabase(seedBoard());
    holder.sb = sb;
    holder.client = makeFakeClient([endTurn([text('Hi — nothing to change.')])]).client;

    const res = await POST(makeReq(OK_BODY));
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const events = parseSSE(await res.text());

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeTruthy();
    expect(done!.actionId).toBeNull(); // read-only turn → no snapshot
    expect(done!.changes).toEqual([]);
    expect((done!.usage as { input_tokens: number }).input_tokens).toBe(10);
  });

  it('snapshot→actionRef wiring: a mutating tool records into the turn snapshot', async () => {
    const board = makeStatefulSupabase(seedBoard());
    holder.sb = board.sb;
    // The model relieves md-a: mark_relieved is a mutating tool, so the loop
    // snapshots first (the route stashes the id into actionRef), then the
    // executor reads actionRef.actionId to record its new relief_log row.
    holder.client = makeFakeClient([
      toolTurn([toolUse('t1', 'mark_relieved', { staff_id: 'md-a' })]),
      endTurn([text('Relieved Amy Ash — went home.')]),
    ]).client;

    const res = await POST(makeReq({
      boardDate: DATE,
      hospital: null,
      messages: [{ role: 'user', content: 'send amy home' }],
    }));
    const events = parseSSE(await res.text());

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeTruthy();
    // One mutating tool → one change chip and a real snapshot action id.
    expect(done!.changes).toHaveLength(1);
    const actionId = done!.actionId as string;
    expect(actionId).toBeTruthy();

    // The snapshot row exists and its id matches done.actionId.
    const actions = board.dump('board_assistant_actions');
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe(actionId);

    // Proof the executor SAW actionRef.actionId: the relief_log row it created
    // was recorded into that action's snapshot.reliefIds for targeted undo.
    const relief = board.dump('relief_log');
    expect(relief).toHaveLength(1);
    const reliefId = relief[0].id as string;
    const snapshot = actions[0].snapshot as { reliefIds: string[] };
    expect(snapshot.reliefIds).toContain(reliefId);
  });
});
