// Unit tests for the Rules Normalizer Agent (A4) wrapper.
//
// Run with: npx tsx src/lib/gridCalculator/__tests__/rulesNormalizer.test.ts
//
// Mirrors A3's test runner pattern: tsx + node:assert + a tiny harness. The
// Anthropic SDK is mocked with stubs that return canned fixtures from
// `fixtures/normalizer-responses.json` — no real API calls.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  MissingApiKeyError,
  NormalizerConfigError,
  NormalizerResponseError,
  normalizeRules,
  type AnthropicLike,
  type AnthropicMessageResponse,
  type AnthropicMessagesCreateParams,
} from '../rulesNormalizer';
import type { GridSite } from '../types';

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURES_PATH = path.join(
  __dirname,
  'fixtures',
  'normalizer-responses.json',
);
const fixtures = JSON.parse(
  fs.readFileSync(FIXTURES_PATH, 'utf8'),
) as Record<string, AnthropicMessageResponse>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedCall {
  params: AnthropicMessagesCreateParams;
}

function makeClient(
  fixtureKey: keyof typeof fixtures,
  captured?: CapturedCall[],
): AnthropicLike {
  return {
    messages: {
      async create(params: AnthropicMessagesCreateParams) {
        if (captured) captured.push({ params });
        const fx = fixtures[fixtureKey];
        if (!fx) throw new Error(`No fixture: ${String(fixtureKey)}`);
        return fx;
      },
    },
  };
}

function site(id: string, name: string, position = 0): GridSite {
  return {
    id,
    name,
    color: '#000',
    icon: name[0] ?? '?',
    position,
    rooms: [],
  };
}

// ---------------------------------------------------------------------------
// Mini harness
// ---------------------------------------------------------------------------

type TestCase = { name: string; fn: () => void | Promise<void> };
const cases: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  cases.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. Endo solo → solo_md SiteRule.
// ---------------------------------------------------------------------------

test('Endo solo coverage maps to a solo_md SiteRule', async () => {
  const out = await normalizeRules({
    rawText: 'Endo is usually solo coverage by an Anesthesiologist.',
    sites: [site('s-endo', 'Endo')],
    client: makeClient('endoSolo'),
  });
  assert.equal(out.rules.siteRules.length, 1);
  assert.equal(out.rules.siteRules[0].site, 'Endo');
  assert.equal(out.rules.siteRules[0].defaultStaffing, 'solo_md');
  assert.deepEqual(out.unmapped, []);
  assert.equal(out.rules.globalRules.length, 0);
  // Cache miss expected on first call against a fresh fixture (cache_creation > 0).
  assert.equal(out.promptCacheHit, false);
});

// ---------------------------------------------------------------------------
// 2. Multiple sites in one paragraph.
// ---------------------------------------------------------------------------

test('Multiple sites described in one paragraph all surface as SiteRules', async () => {
  const out = await normalizeRules({
    rawText:
      'Endo is solo. OB is solo and helps with breaks, 1:3 max. EP Lab is supervised by a Main OR Anesthesiologist.',
    sites: [
      site('s-main', 'Main OR', 0),
      site('s-endo', 'Endo', 1),
      site('s-ob', 'OB', 2),
      site('s-ep', 'EP Lab', 3),
    ],
    client: makeClient('multipleSites'),
  });
  assert.equal(out.rules.siteRules.length, 3);
  const bySite = new Map(out.rules.siteRules.map((r) => [r.site, r]));
  assert.ok(bySite.has('Endo'));
  assert.ok(bySite.has('OB'));
  assert.ok(bySite.has('EP Lab'));
  assert.equal(bySite.get('Endo')!.defaultStaffing, 'solo_md');
  assert.equal(bySite.get('OB')!.auxiliaryRole, 'break_relief');
  assert.equal(bySite.get('OB')!.maxSupervisionRatio, '1:3');
  assert.equal(bySite.get('EP Lab')!.supervisorFromSite, 'Main OR');
});

// ---------------------------------------------------------------------------
// 3. Cross-site supervision phrasing → supervisorFromSite: "Main OR".
// ---------------------------------------------------------------------------

test('Cross-site supervision phrasing sets supervisorFromSite to "Main OR"', async () => {
  const out = await normalizeRules({
    rawText: 'EP is CRNAs supervised by a Main OR doc.',
    sites: [site('s-main', 'Main OR', 0), site('s-ep', 'EP Lab', 1)],
    client: makeClient('crossSiteSupervision'),
  });
  assert.equal(out.rules.siteRules.length, 1);
  const rule = out.rules.siteRules[0];
  assert.equal(rule.site, 'EP Lab');
  assert.equal(rule.defaultStaffing, 'supervised_md_crna');
  assert.equal(rule.supervisorFromSite, 'Main OR');
});

// ---------------------------------------------------------------------------
// 4. Unparseable sentence → `unmapped`.
// ---------------------------------------------------------------------------

test('An unparseable sentence bubbles up verbatim in unmapped', async () => {
  const out = await normalizeRules({
    rawText:
      'Endo is solo. We try to avoid scheduling Dr. Chen on Fridays.',
    sites: [site('s-endo', 'Endo')],
    client: makeClient('unparseableSentence'),
  });
  assert.equal(out.rules.siteRules.length, 1);
  assert.deepEqual(out.unmapped, [
    'We try to avoid scheduling Dr. Chen on Fridays.',
  ]);
});

// ---------------------------------------------------------------------------
// 5. Conflicting rules (two staffings for Endo) → both surface, the last wins,
//    both noted. We delegate "last wins" to the solver (which iterates the
//    siteRules array and the last entry overwrites in its lookup map). The
//    normalizer's job is to surface BOTH rules in order with a note.
// ---------------------------------------------------------------------------

test('Conflicting rules for the same site surface both, in order, with a note', async () => {
  const out = await normalizeRules({
    rawText:
      'Endo is solo. Actually Endo is CRNAs supervised by a Main OR doc.',
    sites: [site('s-main', 'Main OR', 0), site('s-endo', 'Endo', 1)],
    client: makeClient('conflictingRules'),
  });
  const endoRules = out.rules.siteRules.filter((r) => r.site === 'Endo');
  assert.equal(endoRules.length, 2);
  // Order preserved — solver consumes the last one.
  assert.equal(endoRules[0].defaultStaffing, 'solo_md');
  assert.equal(endoRules[1].defaultStaffing, 'supervised_md_crna');
  // The second rule carries a conflict note.
  assert.ok(
    endoRules[1].notes && /conflict/i.test(endoRules[1].notes),
    'second conflicting rule should carry a note explaining the conflict',
  );
});

// ---------------------------------------------------------------------------
// 6. Empty input → empty rules, no throw, no Claude call.
// ---------------------------------------------------------------------------

test('Empty input returns empty rules without calling Claude', async () => {
  const captured: CapturedCall[] = [];
  const out = await normalizeRules({
    rawText: '   \n\t  ',
    sites: [site('s-endo', 'Endo')],
    client: makeClient('endoSolo', captured),
  });
  assert.deepEqual(out.rules.siteRules, []);
  assert.deepEqual(out.rules.globalRules, []);
  assert.deepEqual(out.unmapped, []);
  assert.equal(out.promptCacheHit, false);
  // Should not have hit the client at all.
  assert.equal(captured.length, 0);
});

// ---------------------------------------------------------------------------
// 7. Cache hit detection: a fixture with cache_read_input_tokens > 0 sets
//    promptCacheHit = true.
// ---------------------------------------------------------------------------

test('promptCacheHit reflects cache_read_input_tokens on the response', async () => {
  const out = await normalizeRules({
    rawText: 'Endo is solo.',
    sites: [site('s-endo', 'Endo')],
    client: makeClient('multipleSites'), // this fixture has cache_read > 0
  });
  assert.equal(out.promptCacheHit, true);
});

// ---------------------------------------------------------------------------
// 8. Code-fence-wrapped JSON is still parsed.
// ---------------------------------------------------------------------------

test('Code-fence-wrapped JSON output is still parsed', async () => {
  const out = await normalizeRules({
    rawText: 'OB is solo and helps with breaks.',
    sites: [site('s-ob', 'OB')],
    client: makeClient('withCodeFence'),
  });
  assert.equal(out.rules.siteRules.length, 1);
  assert.equal(out.rules.siteRules[0].site, 'OB');
  assert.equal(out.rules.siteRules[0].auxiliaryRole, 'break_relief');
});

// ---------------------------------------------------------------------------
// 9. Unparseable LLM output throws NormalizerResponseError.
// ---------------------------------------------------------------------------

test('Unparseable LLM output raises NormalizerResponseError', async () => {
  await assert.rejects(
    () =>
      normalizeRules({
        rawText: 'anything',
        sites: [site('s-endo', 'Endo')],
        client: makeClient('garbage'),
      }),
    (err: unknown) => err instanceof NormalizerResponseError,
  );
});

// ---------------------------------------------------------------------------
// 10. Missing API key (no client injected, no env var) → MissingApiKeyError.
// ---------------------------------------------------------------------------

test('Missing ANTHROPIC_API_KEY raises MissingApiKeyError when no client injected', async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () =>
        normalizeRules({
          rawText: 'Endo is solo.',
          sites: [site('s-endo', 'Endo')],
        }),
      (err: unknown) => err instanceof MissingApiKeyError,
    );
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});

// ---------------------------------------------------------------------------
// 11. System prompt is sent with cache_control: ephemeral on every request.
// ---------------------------------------------------------------------------

test('System prompt is sent with cache_control: ephemeral', async () => {
  const captured: CapturedCall[] = [];
  await normalizeRules({
    rawText: 'Endo is solo.',
    sites: [site('s-endo', 'Endo')],
    client: makeClient('endoSolo', captured),
  });
  assert.equal(captured.length, 1);
  const sys = captured[0].params.system;
  assert.ok(Array.isArray(sys) && sys.length === 1);
  assert.equal(sys[0].type, 'text');
  assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
  assert.ok(sys[0].text.length > 1000, 'system prompt should be substantial');
});

// ---------------------------------------------------------------------------
// 12. User message is deterministic — site list sorted, raw text appended.
//     Two identical inputs produce byte-identical user messages, which is
//     what preserves the cached prefix across requests.
// ---------------------------------------------------------------------------

test('User message is deterministic for identical inputs', async () => {
  const captured: CapturedCall[] = [];
  const sites = [site('s-b', 'B Site', 0), site('s-a', 'A Site', 1)];
  await normalizeRules({
    rawText: 'A Site is solo.',
    sites,
    client: makeClient('endoSolo', captured),
  });
  await normalizeRules({
    rawText: 'A Site is solo.',
    // Different order in input, but normalized to the same sorted list.
    sites: [...sites].reverse(),
    client: makeClient('endoSolo', captured),
  });
  assert.equal(captured.length, 2);
  const m0 = captured[0].params.messages[0].content;
  const m1 = captured[1].params.messages[0].content;
  assert.equal(typeof m0, 'string');
  assert.equal(typeof m1, 'string');
  assert.equal(m0, m1);
  // Sites should appear sorted alphabetically in the rendered user message.
  assert.ok(typeof m0 === 'string' && m0.indexOf('A Site') < m0.indexOf('B Site'));
});

// ---------------------------------------------------------------------------
// 13. Global rules round-trip when the LLM emits one.
// ---------------------------------------------------------------------------

test('Global rules round-trip when the LLM emits one', async () => {
  const out = await normalizeRules({
    rawText: 'We never supervise more than 1:3.',
    sites: [site('s-main', 'Main OR')],
    client: makeClient('globalRule'),
  });
  assert.equal(out.rules.siteRules.length, 0);
  assert.equal(out.rules.globalRules.length, 1);
  assert.equal(out.rules.globalRules[0].kind, 'max_supervision_ratio');
  assert.deepEqual(out.rules.globalRules[0].payload, { ratio: '1:3' });
});

// ---------------------------------------------------------------------------
// 14. Path-traversal hardening: an env-var override pointing OUTSIDE the
//     project tree raises a NormalizerConfigError rather than silently loading
//     a file the deployer didn't intend (e.g. `../../etc/passwd`).
// ---------------------------------------------------------------------------

test('Path-traversal env-var override raises NormalizerConfigError', async () => {
  const original = process.env.GRID_CALCULATOR_NORMALIZER_PROMPT_PATH;
  process.env.GRID_CALCULATOR_NORMALIZER_PROMPT_PATH = '../../../../etc/passwd';
  try {
    await assert.rejects(
      () =>
        normalizeRules({
          rawText: 'Endo is solo.',
          sites: [site('s-endo', 'Endo')],
          client: makeClient('endoSolo'),
        }),
      (err: unknown) => {
        return (
          err instanceof NormalizerConfigError &&
          /under the project root/i.test(err.message)
        );
      },
    );

    // Absolute paths outside the project root must also be rejected.
    process.env.GRID_CALCULATOR_NORMALIZER_PROMPT_PATH = '/etc/passwd';
    await assert.rejects(
      () =>
        normalizeRules({
          rawText: 'Endo is solo.',
          sites: [site('s-endo', 'Endo')],
          client: makeClient('endoSolo'),
        }),
      (err: unknown) => err instanceof NormalizerConfigError,
    );
  } finally {
    if (original === undefined) {
      delete process.env.GRID_CALCULATOR_NORMALIZER_PROMPT_PATH;
    } else {
      process.env.GRID_CALCULATOR_NORMALIZER_PROMPT_PATH = original;
    }
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  let passed = 0;
  let failed = 0;
  const failures: Array<{ name: string; err: unknown }> = [];
  for (const tc of cases) {
    try {
      await tc.fn();
      passed++;
      console.log(`  ok  ${tc.name}`);
    } catch (err) {
      failed++;
      failures.push({ name: tc.name, err });
      console.error(`  FAIL ${tc.name}`);
    }
  }
  console.log(`\n${passed}/${cases.length} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) {
      console.error(`\n--- ${f.name} ---`);
      console.error(f.err);
    }
    process.exit(1);
  }
}

main();
