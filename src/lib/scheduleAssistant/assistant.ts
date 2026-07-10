// The assistant tool-use loop (manual streaming loop per the claude-api
// reference): build messages (history + optional image block before the
// text), stream → finalMessage → execute tool_use blocks → feed tool_result
// blocks back in ONE user message → repeat, max 16 iterations.
//
// Safety properties enforced here (spec §7.3):
// - the FIRST mutating tool of a run triggers takeSnapshot BEFORE execution;
//   if the snapshot fails, mutating tools in that turn are refused (is_error)
//   rather than executed un-undoably;
// - invalid tool input becomes an is_error tool_result carrying the zod issue
//   text so the model self-corrects — nothing invalid is persisted;
// - stop_reason 'max_tokens' appends an explicit truncation notice.
import fs from 'fs';
import path from 'path';
import {
  buildRequest,
  type AssistantClientLike,
  type AssistantMessageParam,
  type AssistantUsage,
  type ContentBlock,
} from './client';
import {
  assistantTools,
  createToolExecutors,
  loadScheduleCtx,
  MUTATING_TOOLS,
  ToolInputError,
  type ToolExecutor,
  type ToolEngineDeps,
} from './tools';
import { takeSnapshot } from './snapshot';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

export const MAX_ITERATIONS = 16;
// Tool results are model input — cap runaway payloads (a month grid is fine;
// a full generation result with hundreds of rejections is not).
const MAX_TOOL_RESULT_CHARS = 40_000;

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

// ── Events (forwarded to the UI over SSE) ────────────────────────────────────

export type AssistantEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; tool: string }
  | { type: 'tool-done'; tool: string; ok: boolean; summary?: string; error?: string }
  | { type: 'done'; changes: string[]; actionId: string | null; usage: AssistantUsage };

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

function stringifyResult(result: unknown): string {
  let text: string;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    text = String(result);
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated — result exceeded ${MAX_TOOL_RESULT_CHARS} chars]`;
  }
  return text;
}

function addUsage(total: AssistantUsage, u?: Partial<AssistantUsage>): void {
  total.input_tokens += u?.input_tokens ?? 0;
  total.output_tokens += u?.output_tokens ?? 0;
  total.cache_creation_input_tokens =
    (total.cache_creation_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
  total.cache_read_input_tokens =
    (total.cache_read_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
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

// ── The loop ─────────────────────────────────────────────────────────────────

export async function runAssistant(opts: RunAssistantOptions): Promise<RunAssistantResult> {
  const { sb, client, scheduleId } = opts;
  const onEvent = opts.onEvent ?? (() => undefined);
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;

  const ctx = await loadScheduleCtx(sb, scheduleId);
  const executors: Record<string, ToolExecutor> = createToolExecutors(opts.engineDeps);
  for (const [name, fn] of Object.entries(opts.executorOverrides ?? {})) {
    if (fn) executors[name] = fn;
  }

  const system = [
    { text: loadSystemPrompt() },
    {
      text: [
        `Current schedule: "${ctx.scheduleName}" (${ctx.dateStart} → ${ctx.dateEnd}).`,
        `schedule_id: ${ctx.scheduleId}; site_id: ${ctx.siteId}; version_id: ${ctx.versionId}.`,
        ctx.overrideProviderIds?.length
          ? `A custom provider pool override is set (${ctx.overrideProviderIds.length} providers).`
          : 'No provider pool override — generation uses the default site pool.',
      ].join('\n'),
    },
  ];

  const messages = buildInitialMessages(opts.messages, opts.image);
  const changes: string[] = [];
  const usage: AssistantUsage = {
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  };
  let actionId: string | null = null;
  const { summary: snapSummary, requestText } = snapshotSummaryFrom(opts.messages);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const stream = client.stream(buildRequest({
      system,
      tools: assistantTools,
      // Snapshot copy: the params object must not alias the live array we
      // keep appending to (the SDK may read it lazily; tests inspect calls).
      messages: [...messages],
      model: opts.model,
    }));
    if (typeof stream.on === 'function') {
      stream.on('text', delta => onEvent({ type: 'text-delta', text: delta }));
    }
    const msg = await stream.finalMessage();
    addUsage(usage, msg.usage);
    messages.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason === 'max_tokens') {
      // Explicit truncation notice — never silently present a cut-off answer.
      // Also emitted through onEvent: the SSE consumer renders events only,
      // so a notice living solely in the returned messages array is unseen.
      const notice = '[Response truncated: the model hit its output token limit. Ask it to continue for the rest.]';
      messages.push({ role: 'assistant', content: notice });
      onEvent({ type: 'text-delta', text: `\n\n${notice}` });
      break;
    }

    const toolUses = msg.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (toolUses.length === 0) break; // end_turn — conversation is done

    // First mutating tool of the RUN → snapshot before anything executes.
    const hasMutation = toolUses.some(t => MUTATING_TOOLS.has(t.name));
    let snapshotError: string | null = null;
    if (hasMutation && actionId === null) {
      try {
        actionId = await takeSnapshot(sb, scheduleId, ctx.versionId, snapSummary, requestText);
      } catch (err) {
        snapshotError = err instanceof Error ? err.message : String(err);
        console.error(`[scheduleAssistant] snapshot failed — refusing mutations this turn: ${snapshotError}`);
      }
    }

    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      onEvent({ type: 'tool-start', tool: tu.name });
      const executor = executors[tu.name];

      if (!executor) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool: ${tu.name}`, is_error: true });
        onEvent({ type: 'tool-done', tool: tu.name, ok: false, error: 'unknown tool' });
        continue;
      }
      if (MUTATING_TOOLS.has(tu.name) && snapshotError !== null) {
        const message = `Mutation refused: pre-change snapshot failed (${snapshotError}). Nothing was changed.`;
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: message, is_error: true });
        onEvent({ type: 'tool-done', tool: tu.name, ok: false, error: message });
        continue;
      }

      try {
        const outcome = await executor(sb, ctx, tu.input);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: stringifyResult(outcome.result) });
        if (MUTATING_TOOLS.has(tu.name)) changes.push(outcome.summary);
        onEvent({ type: 'tool-done', tool: tu.name, ok: true, summary: outcome.summary });
      } catch (err) {
        // ToolInputError carries the zod issue text; other errors carry their
        // message. Both go back as is_error so the model can self-correct.
        const message = err instanceof ToolInputError
          ? err.message
          : `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: message, is_error: true });
        onEvent({ type: 'tool-done', tool: tu.name, ok: false, error: message });
      }
    }

    // All tool results in ONE user message (parallel tool-use contract).
    messages.push({ role: 'user', content: results });

    if (iteration === maxIterations - 1) {
      const notice = `[Stopped: reached the ${maxIterations}-iteration tool limit for one request. Changes so far are listed above; send a follow-up to continue.]`;
      messages.push({ role: 'assistant', content: notice });
      onEvent({ type: 'text-delta', text: `\n\n${notice}` });
    }
  }

  onEvent({ type: 'done', changes, actionId, usage });
  return { messages, changes, actionId, usage };
}
