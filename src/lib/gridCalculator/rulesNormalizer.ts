// Free-text Staffing Guidelines -> normalized CoverageRuleSet.
// Owned by agent A4 (Rules Normalizer).
//
// Wraps the server-side Anthropic SDK with prompt caching. The system prompt
// (schema + worked examples) is loaded once from prompts/normalizer.md and
// cached via `cache_control: {type: "ephemeral"}`. The user message carries
// only the variable per-request payload (site list + raw text) so the cached
// prefix stays stable across requests — target cache hit rate ≥80%.
//
// Universality contract: this module does NOT import from FloorRunner-specific
// modules. It only consumes the universal types from `./types`.
//
// PRD: docs/PRD-Grid-Calculator.md §9, §14 (A4 charter).

import fs from 'node:fs';
import path from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import type {
  CoverageRuleSet,
  GlobalRule,
  GridSite,
  SiteRule,
} from './types';

// ---------------------------------------------------------------------------
// Public input / output shapes
// ---------------------------------------------------------------------------

export interface NormalizeRulesInput {
  /** Free-text department staffing guidelines (paragraph or longer). */
  rawText: string;
  /** Current site list — supplies the canonical spellings the LLM must use. */
  sites: GridSite[];
  /**
   * Optional model override. Defaults to the production model from
   * `DEFAULT_MODEL` below. Allowed values are documented in `KNOWN_MODELS`.
   */
  model?: string;
  /**
   * Optional injected Anthropic client. Tests pass a stub here; production
   * code leaves it undefined and the wrapper constructs a real client.
   */
  client?: AnthropicLike;
}

export interface NormalizeRulesResult {
  /** Strict CoverageRuleSet the solver consumes. */
  rules: CoverageRuleSet;
  /**
   * Sentences the LLM could not map to the schema. The solver never sees
   * these — they bubble up to the UI for human clarification (PRD §9).
   */
  unmapped: string[];
  /** True if the system prompt was served from cache on this request. */
  promptCacheHit: boolean;
  /** Resolved Claude model id used for this normalization. */
  modelId: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when `process.env.ANTHROPIC_API_KEY` is missing AND no client was
 * injected. Caught by the API route and rendered as an explicit 500 message
 * (per PRD: "return an explicit MissingApiKeyError rather than throwing a
 * generic stack trace").
 */
export class MissingApiKeyError extends Error {
  constructor() {
    super(
      'ANTHROPIC_API_KEY is not set. Configure the env var or pass a client ' +
        'directly to normalizeRules() (tests do this).',
    );
    this.name = 'MissingApiKeyError';
  }
}

/**
 * Thrown when the LLM response cannot be parsed into the expected shape.
 * The route renders a 502 — the LLM misbehaved, not the caller.
 */
export class NormalizerResponseError extends Error {
  constructor(message: string, public readonly raw?: string) {
    super(message);
    this.name = 'NormalizerResponseError';
  }
}

/**
 * Thrown when normalizer configuration is invalid — currently used by the
 * env-driven prompt-path override to reject path-traversal attempts. The
 * route renders this as a 500 — the deployment is misconfigured.
 */
export class NormalizerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizerConfigError';
  }
}

// ---------------------------------------------------------------------------
// Model & prompt configuration
// ---------------------------------------------------------------------------

/** PRD §9: pin to claude-opus-4-7 for v1; downshift to sonnet-4-6 if needed. */
export const DEFAULT_MODEL = 'claude-opus-4-7';

/** Models the wrapper recognizes — used for validation in the route. */
export const KNOWN_MODELS = new Set<string>([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
]);

/**
 * Validate the env-driven prompt-path override (if set) is path-traversal
 * safe. Called on every `loadSystemPrompt()` regardless of cache state, so a
 * misconfigured deploy is caught even when an earlier call already populated
 * the cache with a legitimate path.
 *
 * Path-traversal hardening: when the env override is set, we resolve it to
 * an absolute path and reject anything that does not live under
 * `process.cwd()`. A misconfigured deploy that points the override at
 * `../../etc/passwd` (or similar) must NOT silently load a file outside the
 * project tree — instead we raise a clear `NormalizerConfigError` so the
 * route surfaces a 500 with the actual misconfiguration.
 */
function resolveSafeEnvPromptPath(): string | null {
  const fromEnv = process.env.GRID_CALCULATOR_NORMALIZER_PROMPT_PATH;
  if (!fromEnv || fromEnv.length === 0) return null;
  const resolved = path.resolve(fromEnv);
  const cwd = path.resolve(process.cwd());
  // Require resolved path to start with cwd + separator (the separator check
  // prevents `cwd-evil/...` from satisfying `startsWith(cwd)` falsely).
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new NormalizerConfigError(
      `GRID_CALCULATOR_NORMALIZER_PROMPT_PATH must resolve to a path under ` +
        `the project root (${cwd}). Got: ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Resolved candidate paths to the markdown prompt. We try the source-tree
 * location first (works when running tests via `npx tsx` and when Next.js
 * preserves relative source structure for server bundles), then fall back
 * to project-root-relative paths so the loader still works when bundled.
 *
 * Override with `GRID_CALCULATOR_NORMALIZER_PROMPT_PATH` for ops flexibility.
 */
function candidatePromptPaths(): string[] {
  const candidates: string[] = [];
  const envPath = resolveSafeEnvPromptPath();
  if (envPath) candidates.push(envPath);
  // Co-located source path — works under tsx and most server bundlers that
  // preserve __dirname for compiled CJS server output.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dirname: string | undefined = typeof __dirname === 'string' ? __dirname : undefined;
  if (dirname) candidates.push(path.join(dirname, 'prompts', 'normalizer.md'));
  // Fallback: cwd-relative (Next.js dev/server runs from project root).
  candidates.push(
    path.join(process.cwd(), 'src', 'lib', 'gridCalculator', 'prompts', 'normalizer.md'),
  );
  return candidates;
}

let cachedSystemPrompt: string | null = null;
function loadSystemPrompt(): string {
  // Always re-validate the env override on every call, even on a cache hit.
  // Otherwise a deploy could swap in a hostile env value at runtime and the
  // hardening check would silently no-op for the rest of the process.
  resolveSafeEnvPromptPath();

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
  throw new Error(
    `Could not locate normalizer.md prompt file. Tried: ${paths.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// Anthropic client shape (test seam)
// ---------------------------------------------------------------------------

/**
 * Minimal slice of the Anthropic client we use, so tests can substitute a
 * stub without depending on the SDK's internals. Mirrors the shape returned
 * by `client.messages.create()` on the real SDK.
 */
export interface AnthropicLike {
  messages: {
    create(params: AnthropicMessagesCreateParams): Promise<AnthropicMessageResponse>;
  };
}

export interface AnthropicMessagesCreateParams {
  model: string;
  max_tokens: number;
  system: Array<{
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
  }>;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<{ type: 'text'; text: string }>;
  }>;
}

export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

/**
 * Normalize free-text guidelines into a `CoverageRuleSet`. Pure with respect
 * to the caller — no DB writes, no caches modified outside this module.
 * Persistence is A1/A2's territory (PRD §13).
 */
export async function normalizeRules(
  input: NormalizeRulesInput,
): Promise<NormalizeRulesResult> {
  const trimmed = (input.rawText ?? '').trim();
  const modelId = input.model ?? DEFAULT_MODEL;

  // Short-circuit empty input — don't burn a Claude call to learn there's
  // nothing to normalize. The solver gets an empty rule set, the route
  // reports cache_hit=false (no call was made).
  if (trimmed.length === 0) {
    return {
      rules: { siteRules: [], globalRules: [] },
      unmapped: [],
      promptCacheHit: false,
      modelId,
    };
  }

  const client = input.client ?? buildDefaultClient();
  const systemPrompt = loadSystemPrompt();

  // The user message is the only varying payload. Keeping it small and
  // deterministic preserves the cached prefix (system prompt + tools = none).
  const userMessage = buildUserMessage(trimmed, input.sites);

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        // Cache the schema + few-shot examples. Min cacheable prefix on
        // claude-opus-4-7 is ~4096 tokens; the prompt comfortably exceeds
        // that. Default 5min TTL is fine — this endpoint is hit
        // interactively, so re-hits within the user's session window.
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  });

  const parsed = parseResponse(response);
  const promptCacheHit = (response.usage?.cache_read_input_tokens ?? 0) > 0;

  return {
    rules: parsed.rules,
    unmapped: parsed.unmapped,
    promptCacheHit,
    modelId: response.model ?? modelId,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function buildDefaultClient(): AnthropicLike {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new MissingApiKeyError();
  }
  // Cast: the SDK's real client satisfies AnthropicLike structurally for the
  // narrow surface we use (messages.create with cache_control on system blocks).
  return new Anthropic({ apiKey }) as unknown as AnthropicLike;
}

/**
 * Build the per-request user content. The site list comes first so the LLM
 * has the canonical spellings before reading the free text. Both are encoded
 * deterministically (sorted by site name) so identical guideline+site inputs
 * produce byte-identical user messages — important when callers preview
 * before saving.
 */
function buildUserMessage(rawText: string, sites: GridSite[]): string {
  const siteNames = sites
    .map((s) => s.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const sitesBlock =
    siteNames.length > 0
      ? `Sites (use these EXACT spellings):\n${JSON.stringify(siteNames)}`
      : 'Sites: (none provided — return any site-specific sentence in `unmapped`)';

  return `${sitesBlock}\n\nGuideline text:\n${rawText}`;
}

interface ParsedResponse {
  rules: CoverageRuleSet;
  unmapped: string[];
}

function parseResponse(response: AnthropicMessageResponse): ParsedResponse {
  // Grab the first text block. Models occasionally emit thinking blocks first
  // when thinking is enabled; we look for the first `text` block regardless.
  const textBlock = response.content.find(
    (b): b is { type: string; text: string } =>
      b.type === 'text' && typeof b.text === 'string',
  );

  if (!textBlock || !textBlock.text) {
    throw new NormalizerResponseError(
      'Claude returned no text block — cannot normalize.',
    );
  }

  const json = extractJsonObject(textBlock.text);
  if (json === null) {
    throw new NormalizerResponseError(
      'Claude did not return parseable JSON.',
      textBlock.text,
    );
  }

  return validateAndCoerce(json, textBlock.text);
}

/**
 * Pull a JSON object out of the model's reply. Models are instructed to emit
 * JSON only, but defensively we strip leading/trailing code fences and
 * narrative if any slip through.
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  // Direct parse first.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // Strip ```json ... ``` fences.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // fall through
    }
  }

  // Last resort: find the first `{` and last `}` and parse that span.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Validate the JSON shape and coerce into our types. Anything wrong shape
 * becomes a NormalizerResponseError so the route can return 502.
 */
function validateAndCoerce(json: unknown, raw: string): ParsedResponse {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new NormalizerResponseError(
      'Top-level response is not a JSON object.',
      raw,
    );
  }

  const obj = json as Record<string, unknown>;
  const rulesRaw = obj.rules;
  const unmappedRaw = obj.unmapped;

  if (
    typeof rulesRaw !== 'object' ||
    rulesRaw === null ||
    Array.isArray(rulesRaw)
  ) {
    throw new NormalizerResponseError(
      'Response missing `rules` object.',
      raw,
    );
  }
  const rules = rulesRaw as Record<string, unknown>;

  const siteRulesRaw = rules.siteRules;
  const globalRulesRaw = rules.globalRules;

  if (!Array.isArray(siteRulesRaw)) {
    throw new NormalizerResponseError(
      'Response `rules.siteRules` is not an array.',
      raw,
    );
  }
  if (!Array.isArray(globalRulesRaw)) {
    throw new NormalizerResponseError(
      'Response `rules.globalRules` is not an array.',
      raw,
    );
  }

  const siteRules = siteRulesRaw
    .map((r) => coerceSiteRule(r))
    .filter((r): r is SiteRule => r !== null);

  const globalRules = globalRulesRaw
    .map((r) => coerceGlobalRule(r))
    .filter((r): r is GlobalRule => r !== null);

  const unmapped = Array.isArray(unmappedRaw)
    ? unmappedRaw.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];

  return {
    rules: { siteRules, globalRules },
    unmapped,
  };
}

const VALID_STAFFING = new Set<SiteRule['defaultStaffing']>([
  'solo_md',
  'supervised_md_crna',
  'solo_crna_with_remote_md',
]);

const VALID_RATIOS = new Set<NonNullable<SiteRule['maxSupervisionRatio']>>([
  '1:1',
  '1:2',
  '1:3',
  '1:4',
]);

const VALID_AUX_ROLES = new Set<NonNullable<SiteRule['auxiliaryRole']>>([
  'break_relief',
  'add_on_relief',
]);

/**
 * Best-effort coercion of a single site rule. Drops rules that lack required
 * fields rather than throwing — a single bad rule should not nuke the whole
 * response. The solver tolerates an empty rule set.
 */
function coerceSiteRule(value: unknown): SiteRule | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;

  const site = r.site;
  const defaultStaffing = r.defaultStaffing;

  if (typeof site !== 'string' || site.length === 0) return null;
  if (typeof defaultStaffing !== 'string') return null;
  if (!VALID_STAFFING.has(defaultStaffing as SiteRule['defaultStaffing'])) {
    return null;
  }

  const result: SiteRule = {
    site,
    defaultStaffing: defaultStaffing as SiteRule['defaultStaffing'],
  };

  if (Array.isArray(r.fallbacks)) {
    const fb = r.fallbacks.filter(
      (s): s is string =>
        typeof s === 'string' &&
        VALID_STAFFING.has(s as SiteRule['defaultStaffing']),
    );
    if (fb.length > 0) result.fallbacks = fb;
  }

  if (typeof r.supervisorFromSite === 'string' && r.supervisorFromSite.length > 0) {
    result.supervisorFromSite = r.supervisorFromSite;
  }

  if (
    typeof r.maxSupervisionRatio === 'string' &&
    VALID_RATIOS.has(r.maxSupervisionRatio as NonNullable<SiteRule['maxSupervisionRatio']>)
  ) {
    result.maxSupervisionRatio =
      r.maxSupervisionRatio as NonNullable<SiteRule['maxSupervisionRatio']>;
  }

  if (
    typeof r.auxiliaryRole === 'string' &&
    VALID_AUX_ROLES.has(r.auxiliaryRole as NonNullable<SiteRule['auxiliaryRole']>)
  ) {
    result.auxiliaryRole =
      r.auxiliaryRole as NonNullable<SiteRule['auxiliaryRole']>;
  }

  if (typeof r.notes === 'string' && r.notes.length > 0) {
    result.notes = r.notes;
  }

  return result;
}

function coerceGlobalRule(value: unknown): GlobalRule | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;

  if (typeof r.kind !== 'string' || r.kind.length === 0) return null;
  const payload =
    typeof r.payload === 'object' && r.payload !== null && !Array.isArray(r.payload)
      ? (r.payload as Record<string, unknown>)
      : {};

  return { kind: r.kind, payload };
}
