// Domain-generic streaming tool loop (manual streaming loop per the claude-api
// reference): build the request → stream → finalMessage → execute tool_use
// blocks → feed tool_result blocks back in ONE user message → repeat, bounded
// by maxIterations.
//
// This file owns ONLY the conversation mechanics. The domain (schedule / board)
// injects its own systemPrompt, tools, executors, mutatingTools set and
// takeSnapshot fn; the extracted body is byte-for-byte the schedule assistant's
// previous loop (its pinned suite is the contract). Safety properties kept here
// (spec §7.3):
// - the FIRST mutating tool of a run triggers takeSnapshot BEFORE execution; if
//   the snapshot fails (resolves null) the mutating tools in that turn are
//   refused (is_error) instead of executed un-undoably;
// - invalid tool input becomes an is_error tool_result carrying the executor's
//   error text so the model self-corrects — nothing invalid is persisted; an
//   input-validation error (an Error whose name is 'ToolInputError', the shared
//   convention across domain executors) is surfaced verbatim, any other throw
//   is an execution failure and gets a "Tool failed:" prefix;
// - stop_reason 'max_tokens' appends an explicit truncation notice.
import {
  buildRequest,
  type AssistantClientLike,
  type AssistantMessageParam,
  type AssistantToolDef,
  type AssistantUsage,
  type ContentBlock,
} from './client';

export const MAX_ITERATIONS = 16;
// Tool results are model input — cap runaway payloads (a month grid is fine; a
// full generation result with hundreds of rejections is not).
export const MAX_TOOL_RESULT_CHARS = 40_000;

// ── Events (forwarded to the UI over SSE) ────────────────────────────────────

export type AssistantEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; tool: string }
  | { type: 'tool-done'; tool: string; ok: boolean; summary?: string; error?: string }
  | { type: 'done'; changes: string[]; actionId: string | null; usage: AssistantUsage };

// A single tool execution's outcome. `summary` is only meaningful for mutating
// tools (it becomes a UI change chip); read tools may omit it.
export interface LoopToolOutcome {
  // Sent back to the model as the tool_result content (JSON-stringified).
  result: unknown;
  // One-line description for the UI change chips (mutating tools only).
  summary?: string;
}

export interface AssistantLoopDeps {
  client: AssistantClientLike;
  // The full system prompt for this run (frozen prompt + any per-run context,
  // assembled by the domain adapter). Rides in a single system block.
  systemPrompt: string;
  tools: AssistantToolDef[];
  // Bound executors — the adapter closes over its (sb, ctx) so the loop only
  // ever passes the model-supplied tool input.
  executors: Record<string, (input: unknown) => Promise<LoopToolOutcome>>;
  mutatingTools: ReadonlySet<string>;
  // Called at most once per run, before the first mutating tool executes.
  // Returns the persisted action id, or null on failure (mutations then refuse
  // rather than run un-undoably).
  takeSnapshot: () => Promise<string | null>;
  // Conversation so far (oldest first, last entry the new user turn). The loop
  // appends assistant/tool-result turns to THIS array and returns it.
  messages: AssistantMessageParam[];
  onEvent: (ev: AssistantEvent) => void;
  model?: string;
  maxIterations?: number;
  maxToolResultChars?: number;
}

export interface AssistantLoopResult {
  messages: AssistantMessageParam[];
  changes: string[];
  actionId: string | null;
  usage: AssistantUsage;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stringifyResult(result: unknown, maxChars: number): string {
  let text: string;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    text = String(result);
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…[truncated — result exceeded ${maxChars} chars]`;
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

// Domain executors mark input-validation errors (bad model tool args) by naming
// their error class 'ToolInputError' (scheduleAssistant/mutations.ts; the board
// assistant follows the same convention). Such errors are shown to the model
// verbatim so it can self-correct; any other throw is an execution failure.
function isToolInputError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ToolInputError';
}

// ── The loop ─────────────────────────────────────────────────────────────────

export async function runAssistantLoop(deps: AssistantLoopDeps): Promise<AssistantLoopResult> {
  const { client, tools, executors, mutatingTools, takeSnapshot, messages, onEvent } = deps;
  const maxIterations = deps.maxIterations ?? MAX_ITERATIONS;
  const maxToolResultChars = deps.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS;
  const system = [{ text: deps.systemPrompt }];

  const changes: string[] = [];
  const usage: AssistantUsage = {
    input_tokens: 0, output_tokens: 0,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  };
  let actionId: string | null = null;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const stream = client.stream(buildRequest({
      system,
      tools,
      // Snapshot copy: the params object must not alias the live array we keep
      // appending to (the SDK may read it lazily; tests inspect calls).
      messages: [...messages],
      model: deps.model,
    }));
    if (typeof stream.on === 'function') {
      stream.on('text', delta => onEvent({ type: 'text-delta', text: delta }));
    }
    const msg = await stream.finalMessage();
    addUsage(usage, msg.usage);
    messages.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason === 'max_tokens') {
      // Explicit truncation notice — never silently present a cut-off answer.
      // Also emitted through onEvent: the SSE consumer renders events only, so a
      // notice living solely in the returned messages array would be unseen.
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
    const hasMutation = toolUses.some(t => mutatingTools.has(t.name));
    let snapshotFailed = false;
    if (hasMutation && actionId === null) {
      const id = await takeSnapshot();
      if (id === null) snapshotFailed = true;
      else actionId = id;
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
      if (mutatingTools.has(tu.name) && snapshotFailed) {
        const message = 'Mutation refused: pre-change snapshot failed. Nothing was changed.';
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: message, is_error: true });
        onEvent({ type: 'tool-done', tool: tu.name, ok: false, error: message });
        continue;
      }

      try {
        const outcome = await executor(tu.input);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: stringifyResult(outcome.result, maxToolResultChars) });
        if (mutatingTools.has(tu.name)) changes.push(outcome.summary ?? '');
        onEvent({ type: 'tool-done', tool: tu.name, ok: true, summary: outcome.summary });
      } catch (err) {
        // ToolInputError-named errors carry the (zod) issue text; other errors
        // carry their message with a prefix. Both go back as is_error so the
        // model can self-correct.
        const message = isToolInputError(err)
          ? (err as Error).message
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
