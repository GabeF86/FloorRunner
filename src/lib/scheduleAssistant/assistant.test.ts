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

function makeFakeSb(
  seed: Record<string, Row[]>,
  opts?: { errorOn?: (op: { kind: Op['kind'] | 'select'; table: string }) => string | null },
) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map(r => ({ ...r }));
  const ops: Op[] = [];
  let idCounter = 0;

  function from(table: string) {
    const rowsOf = () => (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let rangeArgs: [number, number] | null = null;
    let action: { kind: Op['kind'] | 'select'; payload?: unknown; onConflict?: string } = { kind: 'select' };

    const matching = () => rowsOf().filter(r => filters.every(f => f(r)));

    const exec = async (): Promise<{ data: Row[]; error: null | { message: string }; count?: number | null }> => {
      const forced = opts?.errorOn?.({ kind: action.kind, table });
      if (forced) return { data: [], error: { message: forced }, count: null };
      if (action.kind === 'select') {
        let rs = matching().map(r => ({ ...r }));
        if (orderBy) {
          const { col, asc } = orderBy;
          rs.sort((a, b) => ((a[col] as number) < (b[col] as number) ? -1 : 1) * (asc ? 1 : -1));
        }
        // PostgREST count:'exact' semantics: total matching rows, computed
        // before limit/range windowing — the analysis tools' paginated reads
        // need it to know when all pages have arrived.
        const total = rs.length;
        if (limitN !== null) rs = rs.slice(0, limitN);
        if (rangeArgs) rs = rs.slice(rangeArgs[0], rangeArgs[1] + 1);
        return { data: rs, error: null, count: total };
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
      range: (from: number, to: number) => { rangeArgs = [from, to]; return builder; },
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

  it('takes NO snapshot on a read/analysis conversation using the Task-8 tools', async () => {
    const sb = makeFakeSb(baseTables());
    const { client, calls } = makeFakeClient([
      toolTurn([toolUse('tu1', 'get_coverage_summary', {}),
        toolUse('tu2', 'get_fairness_report', {})]),
      toolTurn([toolUse('tu3', 'find_unfilled', {}),
        toolUse('tu4', 'who_is_on', { date: '2026-07-04', window_days: 1 })]),
      endTurn([text('Coverage looks like this…')]),
    ]);

    const out = await runAssistant({
      sb, client, scheduleId: 'sched1',
      messages: [{ role: 'user', content: 'how does the week look? anything unfilled?' }],
    });

    // Every analysis tool succeeded (a failing/unknown tool would come back
    // is_error) — the loop never treated any of them as mutating.
    for (const call of calls.slice(1)) {
      const lastMsg = call.messages[call.messages.length - 1];
      const results = (lastMsg.content as ContentBlock[])
        .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.is_error, String(r.content)).not.toBe(true);
      }
    }
    // No snapshot, no action row, no change chips (assistant_actions never written).
    expect(sb.__tables.assistant_actions ?? []).toHaveLength(0);
    expect(sb.__ops.filter(o => o.table === 'assistant_actions')).toHaveLength(0);
    expect(out.actionId).toBeNull();
    expect(out.changes).toHaveLength(0);
  });

  it('refuses assign_provider on a slot from another schedule version (is_error, no write)', async () => {
    const tables = baseTables();
    tables.schedule_slots = [
      { id: 'slot-other', schedule_version_id: 'ver2', site_id: 'site1', slot_date: '2026-08-01' },
    ];
    const sb = makeFakeSb(tables);
    const { client, calls } = makeFakeClient([
      toolTurn([toolUse('tu1', 'assign_provider', { slot_id: 'slot-other', provider_id: 'p1' })]),
      endTurn([text('That slot is not in this schedule.')]),
    ]);

    const out = await runAssistant({
      sb, client, scheduleId: 'sched1',
      messages: [{ role: 'user', content: 'assign smith to slot-other' }],
    });

    const lastMsg = calls[1].messages[calls[1].messages.length - 1];
    const toolResult = (lastMsg.content as ContentBlock[])
      .find(b => b.type === 'tool_result') as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(toolResult.is_error).toBe(true);
    expect(String(toolResult.content)).toMatch(/version/i);
    // Nothing was written to assignments; no change chip recorded.
    expect(sb.__ops.filter(o => o.table === 'assignments')).toHaveLength(0);
    expect(out.changes).toHaveLength(0);
  });

  it('refuses clear_assignment on a slot from another schedule version (is_error, no write)', async () => {
    const tables = baseTables();
    tables.schedule_slots = [
      { id: 'slot-other', schedule_version_id: 'ver2', site_id: 'site1', slot_date: '2026-08-01' },
    ];
    tables.assignments = [
      { id: 'ax', schedule_slot_id: 'slot-other', provider_id: 'p1',
        assignment_status: 'assigned', source_type: 'manual' },
    ];
    const sb = makeFakeSb(tables);
    const { client, calls } = makeFakeClient([
      toolTurn([toolUse('tu1', 'clear_assignment', { slot_id: 'slot-other' })]),
      endTurn([text('That slot is not in this schedule.')]),
    ]);

    await runAssistant({
      sb, client, scheduleId: 'sched1',
      messages: [{ role: 'user', content: 'clear slot-other' }],
    });

    const lastMsg = calls[1].messages[calls[1].messages.length - 1];
    const toolResult = (lastMsg.content as ContentBlock[])
      .find(b => b.type === 'tool_result') as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(toolResult.is_error).toBe(true);
    expect(String(toolResult.content)).toMatch(/version/i);
    // The other-version assignment row is untouched.
    expect(sb.__tables.assignments.find(a => a.id === 'ax')!.assignment_status).toBe('assigned');
    expect(sb.__ops.filter(o => o.table === 'assignments')).toHaveLength(0);
  });

  it('emits the truncation notice through onEvent when stop_reason is max_tokens', async () => {
    const sb = makeFakeSb(baseTables());
    const { client } = makeFakeClient([
      { content: [text('Here is the start of a long answ')], stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 16000 } },
    ]);
    const events: Array<{ type: string; text?: string }> = [];

    const out = await runAssistant({
      sb, client, scheduleId: 'sched1',
      messages: [{ role: 'user', content: 'explain everything' }],
      onEvent: e => events.push(e as { type: string; text?: string }),
    });

    // The SSE consumer only renders events — the notice must reach it, not
    // just the returned messages array.
    const noticeEvent = events.find(e => e.type === 'text-delta' && /truncated/i.test(e.text ?? ''));
    expect(noticeEvent).toBeTruthy();
    const lastMsg = out.messages[out.messages.length - 1];
    expect(String(lastMsg.content)).toMatch(/truncated/i);
  });

  it('refuses mutations and never runs the executor when the snapshot insert fails', async () => {
    const sb = makeFakeSb(baseTables(), {
      errorOn: op => (op.kind === 'insert' && op.table === 'assistant_actions')
        ? 'forced snapshot failure' : null,
    });
    const spy = vi.fn(async () => ({ summary: 'should never run', result: { ok: true } }));
    const { client, calls } = makeFakeClient([
      toolTurn([toolUse('tu1', 'update_call_pattern', { definition: PROPOSED, name: 'Blocked' })]),
      endTurn([text('Could not change anything — snapshot failed.')]),
    ]);

    const out = await runAssistant({
      sb, client, scheduleId: 'sched1',
      messages: [{ role: 'user', content: 'replace the pattern' }],
      executorOverrides: { update_call_pattern: spy },
    });

    // Spec §7.3: no snapshot → no mutation. The executor never ran.
    expect(spy).not.toHaveBeenCalled();
    const lastMsg = calls[1].messages[calls[1].messages.length - 1];
    const toolResult = (lastMsg.content as ContentBlock[])
      .find(b => b.type === 'tool_result') as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(toolResult.is_error).toBe(true);
    expect(String(toolResult.content)).toMatch(/snapshot/i);
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

describe('runAssistant — intake workflow', () => {
  // Org-wired tables: record_availability's org guard and takeSnapshot's
  // org-availability read both walk sites.organization_id → providers, and the
  // profile write needs an existing employment-profile row to patch.
  function intakeTables(): Record<string, Row[]> {
    const t = baseTables();
    t.sites = [{ id: 'site1', name: 'Main OR', short_name: 'MAIN', organization_id: 'org1' }];
    t.providers = [
      { id: 'p1', last_name: 'Smith', short_display_name: 'Smith', provider_type: 'physician', organization_id: 'org1' },
      { id: 'p2', last_name: 'Jones', short_display_name: 'Jones', provider_type: 'physician', organization_id: 'org1' },
    ];
    t.provider_employment_profiles = [
      { id: 'ep2', provider_id: 'p2', home_site_id: 'site1', fte_value: 1.0,
        call_taker: true, partial_call_taker: false, is_day_doc: false },
    ];
    t.provider_availability = [];
    return t;
  }

  it('records availability + updates a profile in one turn: ONE snapshot before both writes, results fed back, final text', async () => {
    const sb = makeFakeSb(intakeTables());
    const { client, calls } = makeFakeClient([
      // Scheduler already confirmed the preview (prompt-enforced) → the model
      // fires both intake writers in a single mutating turn.
      toolTurn([
        text('Recording both facts.'),
        toolUse('tu1', 'record_availability', {
          provider_id: 'p1', availability_type: 'pto',
          start_date: '2026-07-06', end_date: '2026-07-10',
        }),
        toolUse('tu2', 'update_provider_profile', { provider_id: 'p2', fte_value: 0.6 }),
      ]),
      endTurn([text('Recorded Smith’s PTO (Jul 6–10) and set Jones to 0.6 FTE. One Undo reverts both.')]),
    ]);

    const out = await runAssistant({
      sb, client, scheduleId: 'sched1',
      messages: [{ role: 'user', content: 'Smith is on PTO the 6th–10th and Jones is now 0.6 FTE — go ahead' }],
    });

    // Both writes landed on the real live levers.
    const avail = sb.__tables.provider_availability;
    expect(avail).toHaveLength(1);
    expect(avail[0].provider_id).toBe('p1');
    expect(avail[0].availability_type).toBe('pto');
    // Mirrors POST /availability: approved + all-day, provenance 'assistant'.
    expect(avail[0].approval_status).toBe('approved');
    expect(avail[0].all_day).toBe(true);
    expect(avail[0].source).toBe('assistant');
    const prof = sb.__tables.provider_employment_profiles.find(p => p.provider_id === 'p2')!;
    expect(prof.fte_value).toBe(0.6);

    // Two mutating tools → exactly ONE snapshot for the whole intake turn,
    // inserted BEFORE either write.
    expect(sb.__tables.assistant_actions).toHaveLength(1);
    const snapIdx = opIndex(sb.__ops, o => o.table === 'assistant_actions' && o.kind === 'insert');
    const availIdx = opIndex(sb.__ops, o => o.table === 'provider_availability' && o.kind === 'insert');
    const profIdx = opIndex(sb.__ops, o => o.table === 'provider_employment_profiles' && o.kind === 'update');
    expect(snapIdx).toBeGreaterThanOrEqual(0);
    expect(availIdx).toBeGreaterThan(snapIdx);
    expect(profIdx).toBeGreaterThan(snapIdx);

    // Both tool results were fed back as non-error tool_results next turn.
    const followup = calls[1];
    const lastToolMsg = followup.messages[followup.messages.length - 1];
    const results = (lastToolMsg.content as ContentBlock[])
      .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.is_error, String(r.content)).not.toBe(true);

    // Two change chips; actionId points at the single snapshot; final text turn.
    expect(out.changes).toHaveLength(2);
    expect(out.actionId).toBeTruthy();
    const finalMsg = out.messages[out.messages.length - 1];
    expect(finalMsg.role).toBe('assistant');
    const finalText = Array.isArray(finalMsg.content)
      ? finalMsg.content
          .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
          .map(b => b.text).join(' ')
      : String(finalMsg.content);
    expect(finalText).toMatch(/Undo/i);
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

  it('restores mutated rule_definitions on revert', async () => {
    const tables = baseTables();
    tables.rule_sets = [{ id: 'rs1', site_id: 'site1', status: 'active' }];
    tables.rule_definitions = [{
      id: 'rd1', rule_set_id: 'rs1', rule_name: 'Rest after call',
      rule_category: 'rest', hard_constraint: true, is_active: true,
    }];
    const sb = makeFakeSb(tables);

    const actionId = await takeSnapshot(sb, 'sched1', 'ver1', 'rule snapshot', null);
    await sb.from('rule_definitions').update({ hard_constraint: false, is_active: false }).eq('id', 'rd1');

    const res = await revertAction(sb, actionId);
    expect(res.ok).toBe(true);
    const rd = sb.__tables.rule_definitions.find(r => r.id === 'rd1')!;
    expect(rd.hard_constraint).toBe(true);
    expect(rd.is_active).toBe(true);
  });

  it('re-opens version slots assigned after the snapshot but absent from assignments_before', async () => {
    const tables = baseTables();
    tables.schedule_slots = [
      { id: 'slot1', schedule_version_id: 'ver1', site_id: 'site1', slot_date: '2026-07-04' },
      { id: 'slot2', schedule_version_id: 'ver1', site_id: 'site1', slot_date: '2026-07-05' },
    ];
    // slot2 has NO assignment row at snapshot time (the rowless gap).
    tables.assignments = [
      { id: 'a1', schedule_slot_id: 'slot1', provider_id: 'p1',
        assignment_status: 'assigned', source_type: 'manual' },
    ];
    const sb = makeFakeSb(tables);

    const actionId = await takeSnapshot(sb, 'sched1', 'ver1', 'gap snapshot', null);
    // A later regenerate/auto-fill assigns the rowless slot.
    await sb.from('assignments').insert({
      id: 'a2', schedule_slot_id: 'slot2', provider_id: 'p2',
      assignment_status: 'assigned', source_type: 'auto_generated',
    });

    const res = await revertAction(sb, actionId);
    expect(res.ok).toBe(true);
    // Undo must not leave slot2 assigned — that provider was never there
    // when the snapshot was taken (possible cross-site double-book).
    const a2 = sb.__tables.assignments.find(r => r.schedule_slot_id === 'slot2')!;
    expect(a2.assignment_status).toBe('open');
    expect(a2.provider_id).toBeNull();
  });
});
