// Per-run cost estimation for the chat drawer, from the `usage` object the
// assistant's `done` event carries (accumulated across the whole tool loop).
//
// Pure + dependency-free on purpose: this renders client-side, and the
// scheduleAssistant lib imports the Anthropic SDK (server-only). Rates are
// hardcoded for the assistant's DEFAULT_MODEL (claude-opus-4-8) — hence the
// "~" in the rendered footer; update RATES_PER_MTOK if the model changes.

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// USD per million tokens, claude-opus-4-8 (2026-07): $5 in / $25 out,
// cache writes 1.25× input, cache reads 0.1× input.
const RATES_PER_MTOK = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

const USAGE_KEYS = [
  'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
] as const;

/** Narrow an untyped `done`-event field to TokenUsage; null if it isn't one. */
export function parseUsage(raw: unknown): TokenUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const out: TokenUsage = {};
  for (const key of USAGE_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[key] = v;
  }
  return out;
}

export function estimateCostUsd(usage: TokenUsage): number {
  return (
    (usage.input_tokens ?? 0) * RATES_PER_MTOK.input +
    (usage.output_tokens ?? 0) * RATES_PER_MTOK.output +
    (usage.cache_creation_input_tokens ?? 0) * RATES_PER_MTOK.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * RATES_PER_MTOK.cacheRead
  ) / 1_000_000;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
  return `${rounded}k`;
}

function fmtCost(usd: number): string {
  if (usd < 0.005) return '<$0.01';
  return `~$${usd.toFixed(2)}`;
}

/** e.g. "9k in (8.9k cached) · 4 out · ~$0.01" — the assistant bubble footer. */
export function formatUsageFooter(usage: TokenUsage): string {
  const cached = usage.cache_read_input_tokens ?? 0;
  const totalIn = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cached;
  const inPart = cached > 0
    ? `${fmtTokens(totalIn)} in (${fmtTokens(cached)} cached)`
    : `${fmtTokens(totalIn)} in`;
  return `${inPart} · ${fmtTokens(usage.output_tokens ?? 0)} out · ${fmtCost(estimateCostUsd(usage))}`;
}
