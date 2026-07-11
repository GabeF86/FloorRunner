// Thin injectable wrapper around the Anthropic SDK for the schedule assistant.
// Consolidates the streaming seam (the assistant loop needs `stream()` +
// `finalMessage()`) so tests substitute a fake without touching the SDK.
// Request shape follows the claude-api reference: adaptive thinking, no
// temperature, system block array with cache_control on the LAST block.
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-4-8';
export const KNOWN_MODELS = ['claude-opus-4-8', 'claude-fable-5'] as const;
export const MAX_TOKENS = 16000;

// ── Wire types (narrow structural slice of the SDK) ──────────────────────────

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  // Thinking blocks may appear in responses; we pass them back verbatim.
  | { type: 'thinking'; thinking: string; signature?: string };

export interface AssistantMessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface AssistantToolDef {
  name: string;
  description: string;
  strict: true;
  input_schema: Record<string, unknown>;
}

export interface AssistantUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AssistantFinalMessage {
  content: ContentBlock[];
  stop_reason?: string | null;
  model?: string;
  usage?: Partial<AssistantUsage>;
}

export interface AssistantStreamParams {
  model: string;
  max_tokens: number;
  thinking: { type: 'adaptive' };
  system: SystemBlock[];
  tools: AssistantToolDef[];
  messages: AssistantMessageParam[];
}

export interface AssistantStreamLike {
  // The SDK's MessageStream emits 'text' with each text delta.
  on(event: 'text', cb: (delta: string) => void): unknown;
  finalMessage(): Promise<AssistantFinalMessage>;
}

export interface AssistantClientLike {
  stream(params: AssistantStreamParams): AssistantStreamLike;
}

// ── Request builder ──────────────────────────────────────────────────────────

// Assembles the request with the fixed conventions: adaptive thinking (works
// on both allowed models — Fable 5 accepts an explicit adaptive), max_tokens
// 16000, NO temperature (removed on Opus 4.8/Fable 5 — sending it 400s), and
// cache_control {type:'ephemeral'} stamped on the last system block so the
// frozen prompt + per-schedule context cache across the conversation's turns.
export function buildRequest(opts: {
  system: Array<{ text: string }>;
  tools: AssistantToolDef[];
  messages: AssistantMessageParam[];
  model?: string;
}): AssistantStreamParams {
  let model = DEFAULT_MODEL;
  if (opts.model) {
    if ((KNOWN_MODELS as readonly string[]).includes(opts.model)) {
      model = opts.model;
    } else {
      // Coercion must not be silent — a typo'd override would otherwise look
      // like an intentional default-model run.
      console.warn(`[scheduleAssistant] unknown model '${opts.model}' — using default '${DEFAULT_MODEL}'`);
    }
  }
  const system: SystemBlock[] = opts.system.map((b, i) => ({
    type: 'text' as const,
    text: b.text,
    ...(i === opts.system.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
  return {
    model,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system,
    tools: opts.tools,
    messages: opts.messages,
  };
}

// ── Default (real) client ────────────────────────────────────────────────────

export class MissingApiKeyError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not set — the schedule assistant requires a server-side Anthropic API key.');
    this.name = 'MissingApiKeyError';
  }
}

export function buildDefaultAssistantClient(): AssistantClientLike {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) throw new MissingApiKeyError();
  const anthropic = new Anthropic({ apiKey });
  return {
    stream(params: AssistantStreamParams): AssistantStreamLike {
      // Cast: our structural types are a narrow slice of the SDK's params /
      // MessageStream — the SDK accepts this shape verbatim.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return anthropic.messages.stream(params as any) as unknown as AssistantStreamLike;
    },
  };
}

// ── Typed error mapping (claude-api reference chain) ─────────────────────────

// Maps SDK errors to HTTP-ish {status, message} for the route / SSE error
// event. Most specific first: RateLimitError → 429; connection failures and
// 529 overloads → 503 with a retry hint; other API errors keep their status.
export function mapAssistantError(err: unknown): { status: number; message: string } {
  if (err instanceof MissingApiKeyError) return { status: 500, message: err.message };
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, message: 'Claude is rate-limited right now — wait a moment and retry.' };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { status: 503, message: 'Could not reach Claude (connection error) — retry shortly.' };
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : 500;
    if (status === 529) {
      return { status: 503, message: 'Claude is overloaded (529) — retry shortly.' };
    }
    return { status, message: err.message };
  }
  return { status: 500, message: err instanceof Error ? err.message : String(err) };
}
