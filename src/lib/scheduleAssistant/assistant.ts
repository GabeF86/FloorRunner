// The schedule assistant — a thin adapter over the domain-generic tool loop
// (src/lib/assistantCore/loop.ts). This file owns only the SCHEDULING wiring:
// load the schedule context, build the executor map bound to (sb, ctx), the
// snapshot fn, the system prompt (frozen prompt + per-schedule context), then
// delegate the conversation mechanics to runAssistantLoop. The loop's safety
// properties (snapshot-before-first-mutation, is_error self-correction,
// max_tokens truncation notice) live there now and are pinned by both
// assistant.test.ts (this adapter, end-to-end) and assistantCore/loop.test.ts.
import fs from 'fs';
import path from 'path';
import {
  type AssistantClientLike,
  type AssistantMessageParam,
  type AssistantUsage,
} from './client';
import {
  assistantTools,
  createToolExecutors,
  loadScheduleCtx,
  MUTATING_TOOLS,
  type ToolExecutor,
  type ToolEngineDeps,
  type ToolOutcome,
} from './tools';
import { takeSnapshot } from './snapshot';
import {
  runAssistantLoop,
  MAX_ITERATIONS,
  type AssistantEvent,
} from '@/lib/assistantCore/loop';

// Re-exported so existing consumers that import these from this module keep
// working (the canonical homes are assistantCore/loop.ts for the event union +
// iteration bound). No import path breaks.
export { MAX_ITERATIONS };
export type { AssistantEvent };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

// ── Prompt loading (rulesNormalizer convention: __dirname + cwd fallback) ────

function candidatePromptPaths(): string[] {
  const candidates: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirname: string | undefined = typeof __dirname === 'string' ? __dirname : undefined;
  if (dirname) candidates.push(path.join(dirname, 'prompts', 'assistant.md'));
  candidates.push(path.join(process.cwd(), 'src', 'lib', 'scheduleAssistant', 'prompts', 'assistant.md'));
  return candidates;
}

let cachedSystemPrompt: string | null = null;
export function loadSystemPrompt(): string {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;
  const paths = candidatePromptPaths();
  for (const p of paths) {
    try {
      cachedSystemPrompt = fs.readFileSync(p, 'utf8');
      return cachedSystemPrompt;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Could not locate assistant.md prompt file. Tried: ${paths.join(', ')}`);
}

// ── Public API (signature/types unchanged) ───────────────────────────────────

export interface RunAssistantOptions {
  sb: SchedulingClient;
  client: AssistantClientLike;
  scheduleId: string;
  // Conversation history, oldest first; last entry is the new user message.
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  // Optional image, attached to the LAST user message before its text.
  image?: { media_type: string; data: string };
  model?: string;
  onEvent?: (event: AssistantEvent) => void;
  // Test seams.
  executorOverrides?: Partial<Record<string, ToolExecutor>>;
  engineDeps?: Partial<ToolEngineDeps>;
  maxIterations?: number;
}

export interface RunAssistantResult {
  messages: AssistantMessageParam[];
  changes: string[];
  actionId: string | null;
  usage: AssistantUsage;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildInitialMessages(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  image?: { media_type: string; data: string },
): AssistantMessageParam[] {
  const messages: AssistantMessageParam[] = history.map(m => ({
    role: m.role,
    content: m.content,
  }));
  if (image && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === 'user' && typeof last.content === 'string') {
      last.content = [
        { type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } },
        { type: 'text', text: last.content },
      ];
    }
  }
  return messages;
}

function snapshotSummaryFrom(history: Array<{ role: string; content: string }>): {
  summary: string;
  requestText: string | null;
} {
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  const requestText = lastUser?.content ?? null;
  const summary = requestText
    ? `Assistant: ${requestText.length > 180 ? `${requestText.slice(0, 180)}…` : requestText}`
    : 'Assistant edit';
  return { summary, requestText };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runAssistant(opts: RunAssistantOptions): Promise<RunAssistantResult> {
  const { sb, client, scheduleId } = opts;
  const onEvent = opts.onEvent ?? (() => undefined);

  const ctx = await loadScheduleCtx(sb, scheduleId);

  // Executor map (schedule-specific), then bind each to (sb, ctx) so the loop
  // only ever passes the model-supplied tool input.
  const executors: Record<string, ToolExecutor> = createToolExecutors(opts.engineDeps);
  for (const [name, fn] of Object.entries(opts.executorOverrides ?? {})) {
    if (fn) executors[name] = fn;
  }
  const boundExecutors: Record<string, (input: unknown) => Promise<ToolOutcome>> = {};
  for (const [name, fn] of Object.entries(executors)) {
    boundExecutors[name] = (input: unknown) => fn(sb, ctx, input);
  }

  // System = frozen prompt + per-schedule context (one block; the loop stamps
  // cache_control on it, so the whole prefix caches across the conversation's
  // turns exactly as before).
  const contextText = [
    `Current schedule: "${ctx.scheduleName}" (${ctx.dateStart} → ${ctx.dateEnd}).`,
    `schedule_id: ${ctx.scheduleId}; site_id: ${ctx.siteId}; version_id: ${ctx.versionId}.`,
    ctx.overrideProviderIds?.length
      ? `A custom provider pool override is set (${ctx.overrideProviderIds.length} providers).`
      : 'No provider pool override — generation uses the default site pool.',
  ].join('\n');
  const systemPrompt = `${loadSystemPrompt()}\n\n${contextText}`;

  // Snapshot fn: on the first mutating tool the loop calls this; a failed
  // snapshot resolves null so the loop refuses mutations (spec §7.3) instead of
  // running them un-undoably.
  const { summary: snapSummary, requestText } = snapshotSummaryFrom(opts.messages);
  const takeSnapshotFn = async (): Promise<string | null> => {
    try {
      return await takeSnapshot(sb, scheduleId, ctx.versionId, snapSummary, requestText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduleAssistant] snapshot failed — refusing mutations this turn: ${message}`);
      return null;
    }
  };

  return runAssistantLoop({
    client,
    systemPrompt,
    tools: assistantTools,
    executors: boundExecutors,
    mutatingTools: MUTATING_TOOLS,
    takeSnapshot: takeSnapshotFn,
    messages: buildInitialMessages(opts.messages, opts.image),
    onEvent,
    model: opts.model,
    maxIterations: opts.maxIterations,
  });
}
