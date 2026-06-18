/**
 * Aesthetic Audit — A10 (Aesthetic Review Loop).
 *
 * Reads docs/aesthetic-reviews/baseline.json and walks the grid-calculator
 * route's source files to verify every locked visual constraint from
 * PRD §7 + the A9 checkpoint. Emits a JSON drift report.
 *
 * Invocation:
 *   npx tsx scripts/aesthetic-audit.ts
 *   npx tsx scripts/aesthetic-audit.ts > docs/aesthetic-reviews/$(date +%F).json
 *
 * Exit codes:
 *   0  — no `severity: 'error'` findings
 *   1  — at least one `severity: 'error'` finding
 *
 * Constraints (per A10 charter):
 *   - Node built-ins only — `node:fs`, `node:path`, `node:process`.
 *   - No external dependencies, no network calls, no filesystem writes
 *     (the script prints to stdout; caller redirects to a file).
 *   - Read-only over the codebase. NEVER mutates source files.
 *
 * Audit framework:
 *   The baseline.json `rules[*].check` field describes what to grep for. Each
 *   check kind has a small handler below. New rule kinds slot in by adding a
 *   case to `runCheck()`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Types — mirror the baseline.json shape, no JSON-schema lib required.
// ---------------------------------------------------------------------------

type Severity = 'error' | 'warn' | 'info';

interface Finding {
  rule: string;
  severity: Severity;
  file?: string;
  lineHint?: number;
  note: string;
}

interface CheckFileShape {
  kind: 'fileShape';
  file?: string;
  files?: string[];
  mustContainAll: string[];
}

interface CheckTokenInFile {
  kind: 'tokenInFile';
  file?: string;
  files?: Array<string | { file: string; mustContain: string[] }>;
  mustContain?: string[];
}

interface CheckTokensPresent {
  kind: 'tokensPresent';
  scanDir: string;
  requiredTokens: string[];
  warnTokens?: Array<{ token: string; note: string }>;
}

interface CheckForbiddenInJsxText {
  kind: 'forbiddenInJsxText';
  scanDir: string;
  forbiddenJsxText: string[];
  allowedJsxText: string[];
}

type Check =
  | CheckFileShape
  | CheckTokenInFile
  | CheckTokensPresent
  | CheckForbiddenInJsxText;

interface BaselineRule {
  id: string;
  prdRef: string;
  description: string;
  check: Check;
}

interface Baseline {
  version: number;
  lockedAt: string;
  variant: { flag: string; constantName: string; constantFile: string };
  dimensions: {
    laneHeaderWidthPx: number;
    roomCardMinWidthPx: number;
    shimmerMs: number;
    constantName: string;
    constantFile: string;
  };
  shimmer: { spec: string; expectedDurationMs: number; homeFile: string };
  colors: Record<string, { hex?: string; family: string; borderStyle?: string }>;
  labels: {
    required: { anesthesiologist: string; crna: string };
    forbiddenInRenderedUi: Array<{ string: string; context: string }>;
  };
  rules: BaselineRule[];
  driftWatchList: string[];
}

interface Report {
  date: string;
  variantConfirmed: boolean;
  filesAudited: string[];
  findings: Finding[];
  summary: {
    totalRules: number;
    errors: number;
    warns: number;
    infos: number;
    passed: number;
  };
}

// ---------------------------------------------------------------------------
// Filesystem helpers.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '..');

function readBaseline(): Baseline {
  const baselinePath = join(REPO_ROOT, 'docs', 'aesthetic-reviews', 'baseline.json');
  const raw = readFileSync(baselinePath, 'utf8');
  return JSON.parse(raw) as Baseline;
}

function readSrcFile(relPath: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, relPath), 'utf8');
  } catch {
    return null;
  }
}

function walkDir(absDir: string, exts = ['.ts', '.tsx']): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(absDir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      out.push(...walkDir(full, exts));
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function findLine(content: string, needle: string): number | undefined {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Variant + dimension sanity checks — run before the rule loop.
// ---------------------------------------------------------------------------

function checkVariantConstants(baseline: Baseline, findings: Finding[]): boolean {
  const stateFile = readSrcFile(baseline.variant.constantFile);
  if (!stateFile) {
    findings.push({
      rule: 'variant.constants',
      severity: 'error',
      file: baseline.variant.constantFile,
      note: `Could not read ${baseline.variant.constantFile} — variant flag location missing.`,
    });
    return false;
  }

  const variantLineHint = findLine(stateFile, `${baseline.variant.constantName}: LayoutVariant`);
  const variantValueOk = new RegExp(
    `${baseline.variant.constantName}\\s*:\\s*LayoutVariant\\s*=\\s*'${baseline.variant.flag}'`,
  ).test(stateFile);
  if (!variantValueOk) {
    findings.push({
      rule: 'variant.value',
      severity: 'error',
      file: baseline.variant.constantFile,
      lineHint: variantLineHint,
      note: `LAYOUT_VARIANT must equal '${baseline.variant.flag}' (baseline locked 2026-06-17).`,
    });
  }

  const dim = baseline.dimensions;
  const dimChecks: Array<[string, number, RegExp]> = [
    ['laneHeaderWidth', dim.laneHeaderWidthPx, new RegExp(`laneHeaderWidth\\s*:\\s*${dim.laneHeaderWidthPx}\\b`)],
    ['roomCardMinWidth', dim.roomCardMinWidthPx, new RegExp(`roomCardMinWidth\\s*:\\s*${dim.roomCardMinWidthPx}\\b`)],
    ['shimmerMs', dim.shimmerMs, new RegExp(`shimmerMs\\s*:\\s*${dim.shimmerMs}\\b`)],
  ];
  for (const [name, value, re] of dimChecks) {
    if (!re.test(stateFile)) {
      findings.push({
        rule: `dimensions.${name}`,
        severity: 'error',
        file: baseline.dimensions.constantFile,
        note: `LAYOUT_DIMENSIONS.${name} must equal ${value}.`,
      });
    }
  }

  return variantValueOk;
}

// ---------------------------------------------------------------------------
// Rule check handlers.
// ---------------------------------------------------------------------------

function runFileShape(rule: BaselineRule, check: CheckFileShape, findings: Finding[]): void {
  const files = check.files ?? (check.file ? [check.file] : []);
  if (files.length === 0) {
    findings.push({ rule: rule.id, severity: 'warn', note: 'fileShape check declares no files.' });
    return;
  }
  for (const f of files) {
    const content = readSrcFile(f);
    if (content == null) {
      findings.push({ rule: rule.id, severity: 'error', file: f, note: `File ${f} not readable.` });
      continue;
    }
    for (const needle of check.mustContainAll) {
      if (!content.includes(needle)) {
        findings.push({
          rule: rule.id,
          severity: 'error',
          file: f,
          note: `${rule.prdRef}: file is missing required token "${needle}". ${rule.description}`,
        });
      }
    }
  }
}

function runTokenInFile(rule: BaselineRule, check: CheckTokenInFile, findings: Finding[]): void {
  // Two shapes:
  //   1. Flat: { file, mustContain }
  //   2. Nested: { files: [{ file, mustContain }] }
  if (check.file && check.mustContain) {
    const content = readSrcFile(check.file);
    if (content == null) {
      findings.push({ rule: rule.id, severity: 'error', file: check.file, note: `Cannot read ${check.file}.` });
      return;
    }
    for (const needle of check.mustContain) {
      if (!content.includes(needle)) {
        findings.push({
          rule: rule.id,
          severity: 'error',
          file: check.file,
          note: `${rule.prdRef}: missing required token "${needle}". ${rule.description}`,
        });
      }
    }
    return;
  }
  if (check.files) {
    for (const entry of check.files) {
      if (typeof entry === 'string') {
        const content = readSrcFile(entry);
        if (content == null) {
          findings.push({ rule: rule.id, severity: 'error', file: entry, note: `Cannot read ${entry}.` });
        }
        continue;
      }
      const content = readSrcFile(entry.file);
      if (content == null) {
        findings.push({ rule: rule.id, severity: 'error', file: entry.file, note: `Cannot read ${entry.file}.` });
        continue;
      }
      for (const needle of entry.mustContain) {
        if (!content.includes(needle)) {
          findings.push({
            rule: rule.id,
            severity: 'error',
            file: entry.file,
            lineHint: findLine(content, needle),
            note: `${rule.prdRef}: missing required token "${needle}". ${rule.description}`,
          });
        }
      }
    }
  }
}

function runTokensPresent(
  rule: BaselineRule,
  check: CheckTokensPresent,
  findings: Finding[],
): void {
  const files = walkDir(join(REPO_ROOT, check.scanDir));
  const found = new Map<string, string>(); // token -> file
  const warnHits: Array<{ token: string; note: string; file: string; lineHint?: number }> = [];

  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs);
    const content = readFileSync(abs, 'utf8');
    for (const t of check.requiredTokens) {
      if (!found.has(t) && content.includes(t)) found.set(t, rel);
    }
    for (const wt of check.warnTokens ?? []) {
      if (content.includes(wt.token)) {
        warnHits.push({ token: wt.token, note: wt.note, file: rel, lineHint: findLine(content, wt.token) });
      }
    }
  }

  for (const t of check.requiredTokens) {
    if (!found.has(t)) {
      findings.push({
        rule: rule.id,
        severity: 'error',
        note: `${rule.prdRef}: required color token "${t}" not present anywhere under ${check.scanDir}.`,
      });
    }
  }
  for (const w of warnHits) {
    findings.push({
      rule: rule.id,
      severity: 'warn',
      file: w.file,
      lineHint: w.lineHint,
      note: `${rule.prdRef}: discouraged token "${w.token}" — ${w.note}`,
    });
  }
}

function runForbiddenInJsxText(
  rule: BaselineRule,
  check: CheckForbiddenInJsxText,
  findings: Finding[],
): void {
  // Heuristic for "rendered text":
  //   1. Match strings inside JSX text nodes  -> `>${token}<` (no escaping).
  //   2. Match obvious label string literals  -> `label: 'token'` or
  //      `label: "token"` or `title: '...token...'`.
  //   3. Match button/option literals          -> `'MD-heavy'` in a value:label
  //      array (catches the ToggleBar shape).
  // FALSE-POSITIVE guards:
  //   - Inline comment lines (// …) are skipped.
  //   - Block-comment-only lines (/* … */ or leading `*`) are skipped.
  //   - Module path imports (`@/lib/...` etc.) are skipped via the JSX heuristic
  //     (the forbidden tokens are short label-shaped, not paths).
  const files = walkDir(join(REPO_ROOT, check.scanDir));
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs);
    const lines = readFileSync(abs, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

      for (const forbidden of check.forbiddenJsxText) {
        // (1) JSX text node: >Forbidden< or > Forbidden  (whitespace OK)
        const jsxText = new RegExp(`>\\s*${escapeRe(forbidden)}\\b`).test(line) ||
                        new RegExp(`>\\s*${escapeRe(forbidden)}\\s*<`).test(line);
        // (2) label/title/description literal containing the token as a standalone word
        const labelLiteral = new RegExp(
          `(label|title|description|placeholder|aria-label)\\s*[:=]\\s*['"][^'"]*\\b${escapeRe(forbidden)}\\b[^'"]*['"]`,
        ).test(line);
        // (3) bare quoted label in a {value:label} array (catches `label: 'MD-heavy'`)
        const arrayLabel = new RegExp(
          `\\{\\s*value\\s*:\\s*['"][^'"]*['"]\\s*,\\s*label\\s*:\\s*['"][^'"]*\\b${escapeRe(forbidden)}\\b[^'"]*['"]`,
        ).test(line);

        if (jsxText || labelLiteral || arrayLabel) {
          findings.push({
            rule: rule.id,
            severity: 'error',
            file: rel,
            lineHint: i + 1,
            note: `${rule.prdRef}: forbidden user-visible label "${forbidden}" found. Replace with canonical UI label (Anesthesiologist / CRNA).`,
          });
        }
      }
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function runCheck(rule: BaselineRule, findings: Finding[]): void {
  switch (rule.check.kind) {
    case 'fileShape':
      return runFileShape(rule, rule.check, findings);
    case 'tokenInFile':
      return runTokenInFile(rule, rule.check, findings);
    case 'tokensPresent':
      return runTokensPresent(rule, rule.check, findings);
    case 'forbiddenInJsxText':
      return runForbiddenInJsxText(rule, rule.check, findings);
    default: {
      const _exhaustive: never = rule.check;
      void _exhaustive;
      findings.push({
        rule: rule.id,
        severity: 'warn',
        note: `Unknown check kind — skipped.`,
      });
    }
  }
}

function main(): number {
  const baseline = readBaseline();
  const findings: Finding[] = [];

  // Walk the grid-calculator route once for the file list.
  const auditDir = 'src/app/(scheduling)/grid-calculator';
  const absAuditDir = join(REPO_ROOT, auditDir);
  const filesAudited = walkDir(absAuditDir).map((f) => relative(REPO_ROOT, f));

  // 1. Variant + dimension constants — the foundational checks.
  const variantConfirmed = checkVariantConstants(baseline, findings);

  // 2. Per-rule checks driven by baseline.json.
  for (const rule of baseline.rules) {
    runCheck(rule, findings);
  }

  // 3. Summary.
  const summary = {
    totalRules: baseline.rules.length + 1 /* variant block */,
    errors: findings.filter((f) => f.severity === 'error').length,
    warns: findings.filter((f) => f.severity === 'warn').length,
    infos: findings.filter((f) => f.severity === 'info').length,
    passed: 0,
  };
  // Count rules with no findings as passed (variant block + each baseline rule).
  const failingRuleIds = new Set(findings.map((f) => f.rule));
  summary.passed = summary.totalRules - new Set(
    [...failingRuleIds].filter(
      (id) => id.startsWith('variant.') || id.startsWith('dimensions.') || baseline.rules.some((r) => r.id === id),
    ),
  ).size;

  const report: Report = {
    date: new Date().toISOString().slice(0, 10),
    variantConfirmed,
    filesAudited,
    findings,
    summary,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return summary.errors > 0 ? 1 : 0;
}

process.exit(main());
