// Cost math cross-checked against live probes on 2026-07-12 (Opus 4.8 rates:
// $5/M in, $25/M out, $6.25/M cache-write, $0.50/M cache-read):
// - local run  {in:98, out:4, write:8870, read:0}    → ~$0.0560
// - prod run   {in:98, out:4, write:0,    read:8870} → ~$0.0050
import { describe, it, expect } from 'vitest';
import { estimateCostUsd, formatUsageFooter, parseUsage } from './usageCost';

describe('estimateCostUsd', () => {
  it('prices all four token buckets at Opus 4.8 rates', () => {
    expect(estimateCostUsd({
      input_tokens: 98, output_tokens: 4,
      cache_creation_input_tokens: 8870, cache_read_input_tokens: 0,
    })).toBeCloseTo(0.0560275, 6);
  });

  it('prices cache reads at a tenth of input', () => {
    expect(estimateCostUsd({
      input_tokens: 98, output_tokens: 4,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 8870,
    })).toBeCloseTo(0.005025, 6);
  });

  it('treats missing buckets as zero', () => {
    expect(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(5, 6);
  });
});

describe('formatUsageFooter', () => {
  it('shows total input (all buckets), output, and rounded cost', () => {
    // 98 + 8870 = 8968 in; footer must not hide the cached share.
    expect(formatUsageFooter({
      input_tokens: 98, output_tokens: 4,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 8870,
    })).toBe('9k in (8.9k cached) · 4 out · ~$0.01');
  });

  it('omits the cache note when nothing was read from cache', () => {
    expect(formatUsageFooter({
      input_tokens: 98, output_tokens: 4,
      cache_creation_input_tokens: 8870, cache_read_input_tokens: 0,
    })).toBe('9k in · 4 out · ~$0.06');
  });

  it('floors tiny costs to <$0.01 instead of $0.00', () => {
    expect(formatUsageFooter({ input_tokens: 100, output_tokens: 10 })).toBe(
      '100 in · 10 out · <$0.01',
    );
  });

  it('keeps two decimals above a dollar', () => {
    expect(formatUsageFooter({ input_tokens: 200_000, output_tokens: 8_000 })).toBe(
      '200k in · 8k out · ~$1.20',
    );
  });
});

describe('parseUsage', () => {
  it('accepts the wire shape of the done event usage', () => {
    expect(parseUsage({ input_tokens: 98, output_tokens: 4 })).toEqual({
      input_tokens: 98, output_tokens: 4,
    });
  });

  it('rejects non-objects and non-numeric token fields', () => {
    expect(parseUsage(undefined)).toBeNull();
    expect(parseUsage('usage')).toBeNull();
    expect(parseUsage({ input_tokens: 'many' })).toBeNull();
  });
});
