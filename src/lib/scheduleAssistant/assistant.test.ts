// Assistant tool-use loop tests — fake Anthropic client emitting canned
// tool_use sequences + fake supabase client (LLM testing convention: injected
// fakes, never the network). Covers the five plan-mandated scenarios:
//   1. NL structure change → update_call_pattern + regenerate, snapshot FIRST
//   2. invalid tool input → is_error tool_result fed back, corrected call lands
//   3. read-only conversation takes NO snapshot
//   4. snapshot round-trip: revertAction restores pattern + assignments
//   5. image block passes through to the request payload verbatim
import { describe, it, expect, vi } from 'vitest';
import { runAssistant } from './assistant';
import { takeSnapshot, revertAction } from './snapshot';
import { CLASSIC_PATTERN } from '@/lib/rulesEngine/callPattern';
import type { CallPatternDoc } from '@/lib/rulesEngine/callPattern';
import type {
  AssistantClientLike,
  AssistantFinalMessage,
  AssistantStreamParams,
  ContentBlock,
} from './client';

// ─── Fake Anthropic client ───────────────────────────────────────────────────

function makeFakeClient(turns: AssistantFinalMessage[]) {
  const calls: AssistantStreamParams[] = [];
  let i = 0;
  const client: AssistantClientLike = {
    stream(params: AssistantStreamParams) {
      calls.push(params);
      const msg = turns[Math.min(i, turns.length - 1)];
      i++;
      return {
        on: () => undefined,
        finalMessage: async () => msg,
      };
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

// ─── Fake supabase client ────────────────────────────────────────────────────

type Row = Record<string, unknown>;
interface Op { kind: 'insert' | 'upsert' | 'update' | 'delete'; table: string; payload: unknown }

function makeFakeSb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map(r => ({ ...r }));
  const ops: Op[] = [];
  let idCounter = 0;

  function from(table: string) {
    const rowsOf = () => (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let action: { kind: Op['kind'] | 'select'; payload?: unknown; onConflict?: string } = { kind: 'select' };

    const matching = () => rowsOf().filter(r => filters.every(f => f(r)));

    const exec = async (): Promise<{ data: Row[]; error: null | { message: string } }> => {
      if (action.kind === 'select') {
        let rs = matching().map(r => ({ ...r }));
        if (orderBy) {
          const { col, asc } = orderBy;
          rs.sort((a, b) => ((a[col] as number) < (b[col] as number) ? -1 : 1) * (asc ? 1 : -1));
        }
        if (limitN !== null) rs = rs.slice(0, limitN);
        return { data: rs, error: null };
      }
      if (action.kind === 'insert') {
        const rows = (Array.isArray(action.payload) ? action.payload : [action.payload]) as Row[];
        const inserted = rows.map(r => ({ id: r.id ?? `gen-${++idCounter}`, ...r }));
        rowsOf().push(...inserted);
        ops.push({ kind: 'insert', table, payload: inserted });
        return { data: inserted.map(r => ({ ...r })), error: null };
      }
      if (action.kind === 'upsert') {
        const rows = (Array.isArray(action.payload) ? action.payload : [action.payload]) as Row[];
        const key = action.onConflict ?? 'id';
        const out: Row[] = [];
        for (const r of rows) {
          const existing = rowsOf().find(x => x[key] !== undefined && x[key] === r[key]);
          if (existing) { Object.assign(existing, r); out.push({ ...existing }); }
          else { const row = { id: r.id ?? `gen-${++idCounter}`, ...r }; rowsOf().push(row); out.push({ ...row }); }
        }
        ops.push({ kind: 'upsert', table, payload: rows });
        return { data: out, error: null };
      }
      if (action.kind === 'update') {
        const rs = matching();
        for (const r of rs) Object.assign(r, action.payload as Row);
        ops.push({ kind: 'update', table, payload: { fields: action.payload, count: rs.length } });
        return { data: rs.map(r => ({ ...r })), error: null };
      }
      // delete
      const doomed = matching();
      tables[table] = rowsOf().filter(r => !doomed.includes(r));
      ops.push({ kind: 'delete', table, payload: doomed });
      return { data: doomed.map(r => ({ ...r })), error: null };
    };

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const builder: any = {
      select: () => builder,
      insert: (payload: unknown) => { action = { kind: 'insert', payload }; return builder; },
      upsert: (payload: unknown, opts?: { onConflict?: string }) => {
        action = { kind: 'upsert', payload, onConflict: opts?.onConflict }; return builder;
      },
      update: (payload: unknown) => { action = { kind: 'update', payload }; return builder; },
      delete: () => { action = { kind: 'delete' }; return builder; },
      eq: (col: string, val: unknown) => { filters.push(r => r[col] === val); return builder; },
      neq: (col: string, val: unknown) => { filters.push(r => r[col] !== val); return builder; },
      in: (col: string, vals: unknown[]) => { filters.push(r => vals.includes(r[col])); return builder; },
      gte: (col: string, val: unknown) => { filters.push(r => (r[col] as string) >= (val as string)); return builder; },
      lte: (col: string, val: unknown) => { filters.push(r => (r[col] as string) <= (val as string)); return builder; },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderBy = { col, asc: opts?.ascending !== false }; return builder;
      },
      limit: (n: number) => { limitN = n; return builder; },
      maybeSingle: async () => {
        const { data, error } = await exec();
        return { data: data[0] ?? null, error };
      },
      single: async () => {
        const { data, error } = await exec();
        if (error) return { data: null, error };
        return data.length > 0
          ? { data: data[0], error: null }
          : { data: null, error: { message: `no rows in ${table}` } };
      },
      then: (res: any, rej: any) => exec().then(res, rej),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return builder;
  }

  return { from, __tables: tables, __ops: ops };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Spec §5.3 proposed weekend structure (+ required optimizerMovableDayTypes).
const PROPOSED: CallPatternDoc = {
  version: 1,
  blocks: [{ anchorDayType: 'friday', chains: [
    { trigger: 'C1', links: [{ offset: 2, code: 'C2' }] },
    { trigger: 'C2', links: [{ offset: 1, code: 'C2' }] },
  ] }],
  dayChains: [
    { trigger: 'C1', dayTypes: ['friday', 'saturday', 'sunday'], blocks: [{ offset: 1 }] },
    { trigger: 'C2', dayTypes: ['sunday'], links: [{ offset: 1, code: 'D1' }] },
  ],
  spans: [{ code: 'NB', anchorDayType: 'friday', offsets: [0, 1, 2] }],
  placementPasses: [],
  reliefPass: { enabled: true, dayTypes: ['weekday'] },
  optimizerMovableDayTypes: ['weekday'],
};

function baseTables(): Record<string, Row[]> {
  return {
    schedules: [{
      id: 'sched1', site_id: 'site1', schedule_name: 'July 2026',
      date_start: '2026-07-01', date_end: '2026-07-31', status: 'draft',
      included_provider_ids: null,
    }],
    schedule_versions: [{ id: 'ver1', schedule_id: 'sched1', version_number: 1 }],
    sites: [{ id: 'site1', name: 'Main OR', short_name: 'MAIN' }],
    call_patterns: [{
      id: 'cp1', site_id: 'site1', name: 'Classic', status: 'active',
      source: 'seed', definition: CLASSIC_PATTERN,
    }],
    shift_types: [
      { id: 'st1', site_id: 'site1', code: 'C1', name: 'Call 1', category: 'call',
        call_rank: 0, relief_rank: null, is_overlay: false, generation_engine: 'call',
        requires_post_call_rule: true, start_time: null, end_time: null },
    ],
    rule_sets: [],
    rule_definitions: [],
    providers: [
      { id: 'p1', last_name: 'Smith', short_display_name: 'Smith', provider_type: 'physician' },
      { id: 'p2', last_name: 'Jones', short_display_name: 'Jones', provider_type: 'physician' },
    ],
    schedule_slots: [],
    assignments: [],
  };
}

function opIndex(ops: Op[], pred: (o: Op) => boolean): number {
  return ops.findIndex(pred);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runAssistant — tool-use loop', () => {
  it('executes update_call_pattern with a valid doc, snapshots FIRST, regenerates after, records 2 changes', async () => {
    const sb = makeFakeSb(baseTables());
    const { client } = makeFakeClient([
      toolTurn([text('Switching the weekend structure.'),
        toolUse('tu1', 'update_call_pattern', { definition: PROPOSED, name: 'Proposed weekend' })]),
      toolTurn([toolUse('tu2', 'regenerate_schedule', {})]),
      endTurn([text('Done — weekend structure replaced and schedule regenerated.')]),
    ]);
    const regenerate = vi.fn(async () => ({ summary: 'Regenerated: 10 filled, 0 unfilled', result: { filled: 10 } }));

    const out = await runAssistant({
      sb, client, scheduleId: 'sched1',
      messages: [{ role: 'user', content: 'make weekends the proposed structure' }],
      executorOverrides: { regenerate_schedule: regenerate },
    });

    // Pattern replaced: old archived, new active with the exact proposed doc.
    const patterns = sb.__tables.call_patterns;
    const active = patterns.find(p => p.status === 'active');
    expect(active).toBeTruthy();
    expect(active!.definition).toEqual(PROPOSED);
    expect(active!.source).toBe('assistant');
    expect(patterns.find(p => p.id === 'cp1')!.status).toBe('archived');

    // Snapshot inserted BEFORE the pattern mutation.
    const snapIdx = opIndex(sb.__ops, o => o.table === 'assistant_actions' && o.kind === 'insert');
    const patternIdx = opIndex(sb.__ops, o => o.table === 'call_patterns' && o.kind !== 'select' as never);
    expect(snapIdx).toBeGreaterThanOrEqual(0);
    expect(patternIdx).toBeGreaterThan(snapIdx);

    // Regenerate ran after the pattern write.
    expect(regenerate).toHaveBeenCalledTimes(1);

    // Two mutating tools → two change chips; actionId points at the snapshot.
    expect(out.changes).toHaveLength(2);
    expect(out.actionId).toBeTruthy();
    expect(sb.__tables.assistant_actions).toHaveLength(1);
    const action = sb.__tables.assistant_actions[0] as Row;
    expect(action.schedule_id).toBe('sched1');
    expect(action.schedule_version_id).toBe('ver1');
    // config_before captured the classic pattern, not the new one.
    const cfg = action.config_before as { call_pattern: { definition: CallPatternDoc } };
    expect(cfg.call_pattern.definition).toEqual(CLASSIC_PATTERN);
  });

  it('feeds zod issues back as is_error tool_result; corrected second call succeeds', async () => {
    const sb = makeFakeSb(baseTables());
    const bad = { ...PROPOSED, version: 2 }; // fails CallPatternDocSchema (version literal 1)
    const { client, calls } = makeFakeClient([
      toolTurn([toolUse('tu1', 'update_call_pattern', { definition: bad, name: 'Broken' })]),
      toolTurn([toolUse('tu2', 'update_call_pattern', { definition: PROPOSED, name: 'Fixed' })]),
      endTurn([text('Applied on the second attempt.')]),
    ]);

    const out = await runAssistant({
      sb, client, scheduleId: 'sched1',
      messages: [{ role: 'user', content: 'apply my structure' }],
    });

    // The second request carries a tool_result with is_error + issue text.
    const secondCall = calls[1];
    const lastMsg = secondCall.messages[secondCall.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    const blocks = lastMsg.content as ContentBlock[];
    const toolResult = blocks.find(b => b.type === 'tool_result') as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(toolResult).toBeTruthy();
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.tool_use_id).toBe('tu1');
    expect(String(toolResult.content)).toMatch(/version/);

    // Only the corrected doc landed; exactly one successful change.
    const active = sb.__tables.call_patterns.find(p => p.status === 'active');
    expect(active!.definition).toEqual(PROPOSED);
    expect(active!.name).toBe('Fixed');
    expect(out.changes).toHaveLength(1);
  });

  it('takes NO snapshot on a read-only conversation', async () => {
    const sb = makeFakeSb(baseTables());
    const { client } = makeFakeClient([
      toolTurn([toolUse('tu1', 'get_schedule_context', {})]),
      endTurn([text('Here is the current setup.')]),
    ]);

    const out = await runAssistant({
      sb, client, scheduleId: 'sched1',
      messages: [{ role: 'user', content: 'what does the schedule look like?' }],
    });

    expect(sb.__tables.assistant_actions ?? []).toHaveLength(0);
    expect(out.actionId).toBeNull();
    expect(out.changes).toHaveLength(0);
  });

  it('passes the image block through to the request payload verbatim, before the text', async () => {
    const sb = makeFakeSb(baseTables());
    const { client, calls } = makeFakeClient([
      endTurn([text('That image shows a Friday-anchored weekend block.')]),
    ]);

    await runAssistant({
      sb, client, scheduleId: 'sched1',
      messages: [{ role: 'user', content: 'what structure is in this image?' }],
      image: { media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
    });

    const lastMsg = calls[0].messages[calls[0].messages.length - 1];
    expect(lastMsg.role).toBe('user');
    const blocks = lastMsg.content as ContentBlock[];
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
    });
    expect(blocks[1]).toEqual({ type: 'text', text: 'what structure is in this image?' });
  });
});

describe('snapshot round-trip', () => {
  it('revertAction restores pattern, shift types and assignments, re-snapshots, stamps reverted_at', async () => {
    const tables = baseTables();
    tables.schedule_slots = [
      { id: 'slot1', schedule_version_id: 'ver1', site_id: 'site1', slot_date: '2026-07-04' },
    ];
    tables.assignments = [
      { id: 'a1', schedule_slot_id: 'slot1', provider_id: 'p1',
        assignment_status: 'assigned', source_type: 'manual' },
    ];
    const sb = makeFakeSb(tables);

    const actionId = await takeSnapshot(sb, 'sched1', 'ver1', 'test snapshot', 'undo me');
    expect(actionId).toBeTruthy();

    // Mutate everything the snapshot covers.
    await sb.from('call_patterns').update({ status: 'archived' }).eq('id', 'cp1');
    await sb.from('call_patterns').insert({
      id: 'cp2', site_id: 'site1', name: 'Mutated', status: 'active',
      source: 'assistant', definition: PROPOSED,
    });
    await sb.from('shift_types').update({ name: 'RENAMED' }).eq('id', 'st1');
    await sb.from('assignments').update({ provider_id: 'p2' }).eq('id', 'a1');

    const res = await revertAction(sb, actionId);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    // Undo-of-undo: the revert itself snapshotted the mutated state first.
    expect(res.revertActionId).toBeTruthy();
    expect(sb.__tables.assistant_actions).toHaveLength(2);

    // Pattern restored: active row carries the classic definition again.
    const active = sb.__tables.call_patterns.filter(p => p.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].definition).toEqual(CLASSIC_PATTERN);

    // Shift type restored via upsert.
    expect(sb.__tables.shift_types.find(s => s.id === 'st1')!.name).toBe('Call 1');

    // Assignment restored (upsert keyed on schedule_slot_id).
    const a = sb.__tables.assignments.find(r => r.schedule_slot_id === 'slot1')!;
    expect(a.provider_id).toBe('p1');
    expect(a.assignment_status).toBe('assigned');

    // Original action stamped reverted.
    const original = sb.__tables.assistant_actions.find(r => r.id === actionId)!;
    expect(original.reverted_at).toBeTruthy();
  });
});
