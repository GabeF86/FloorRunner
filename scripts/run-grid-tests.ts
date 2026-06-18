// Unified test runner for the Anesthesia Coverage Grid Calculator.
// Owned by agent A12 (Test Loop) per PRD §14.
//
// Run with: npx tsx scripts/run-grid-tests.ts
//
// PURPOSE
// -------
// Run every test file under src/lib/gridCalculator/__tests__/ in series,
// capture pass/fail counts per file, print a unified summary, and exit
// non-zero on any failure. Suitable for `/loop 1h` during active development
// and for CI gating.
//
// CONVENTIONS
// -----------
// Each test file follows the in-repo "tsx + node:assert" convention:
//   - Test file prints `  ok  <name>` per pass and `  FAIL <name>` per failure.
//   - Final summary line is `N/M passed, K failed`.
//   - Exit code is 0 on success, non-zero on any failure.
//
// We spawn each file via `npx tsx` so the runner inherits the project's
// tsconfig.json and `paths` aliases. Stdout/stderr from each child is
// streamed to the runner's stdout. The runner then parses the final summary
// line to compute the unified count.
//
// To add a new test file, drop it under one of the discovered roots below
// (or its `_property/` subdirectory). No registration needed.

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '..');
const TESTS_ROOT = resolve(
  REPO_ROOT,
  'src',
  'lib',
  'gridCalculator',
  '__tests__',
);

// ---------------------------------------------------------------------------
// Discovery — every *.test.ts file under TESTS_ROOT (recursive).
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip fixtures-only directories; they hold data, not tests.
      if (entry === 'fixtures') continue;
      walk(full, out);
    } else if (
      st.isFile() &&
      (entry.endsWith('.test.ts') || entry.endsWith('.property.test.ts'))
    ) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spawn helper — runs a tsx file, streams output, returns parsed results.
// ---------------------------------------------------------------------------

interface FileResult {
  file: string;
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  exitCode: number | null;
  parseFailed: boolean;
}

function runOne(file: string): Promise<FileResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const rel = relative(REPO_ROOT, file);
    process.stdout.write(`\n=== ${rel} ===\n`);

    const child = spawn('npx', ['tsx', file], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - started;
      const summary = parseSummary(stdoutBuf, stderrBuf);
      resolvePromise({
        file: rel,
        passed: summary.passed,
        failed: summary.failed,
        total: summary.total,
        durationMs,
        exitCode: code,
        parseFailed: summary.parseFailed,
      });
    });
  });
}

/**
 * Parse the per-file summary line `N/M passed, K failed` from a test file's
 * stdout. Returns parseFailed=true if no line matches; the runner then treats
 * the file as one big failure to surface the issue loudly.
 */
function parseSummary(stdout: string, stderr: string): {
  passed: number;
  failed: number;
  total: number;
  parseFailed: boolean;
} {
  const combined = `${stdout}\n${stderr}`;
  // Match the last summary line in the buffer (in case `console.log` accidentally
  // emits a similar-looking string earlier).
  const re = /(\d+)\s*\/\s*(\d+)\s+passed,\s*(\d+)\s+failed/g;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(combined)) !== null) {
    last = match;
  }
  if (!last) {
    return { passed: 0, failed: 1, total: 1, parseFailed: true };
  }
  return {
    passed: Number(last[1]),
    failed: Number(last[3]),
    total: Number(last[2]),
    parseFailed: false,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const files = walk(TESTS_ROOT).sort();
  if (files.length === 0) {
    console.error(`No test files discovered under ${TESTS_ROOT}`);
    process.exit(2);
  }

  console.log(`Discovered ${files.length} test file(s) under ${relative(REPO_ROOT, TESTS_ROOT)}`);
  for (const f of files) {
    console.log(`  • ${relative(REPO_ROOT, f)}`);
  }

  const started = Date.now();
  const results: FileResult[] = [];
  let exitCode = 0;
  for (const file of files) {
    const r = await runOne(file);
    results.push(r);
    if (r.exitCode !== 0 || r.parseFailed) exitCode = 1;
  }
  const totalDuration = Date.now() - started;

  // -------------------------------------------------------------------------
  // Unified summary.
  // -------------------------------------------------------------------------
  const grandPassed = results.reduce((acc, r) => acc + r.passed, 0);
  const grandFailed = results.reduce((acc, r) => acc + r.failed, 0);
  const grandTotal = results.reduce((acc, r) => acc + r.total, 0);

  console.log('\n========================================');
  console.log('Grid Calculator test summary');
  console.log('========================================');
  for (const r of results) {
    const status = r.failed > 0 || r.parseFailed || r.exitCode !== 0 ? 'FAIL' : ' ok ';
    const parseNote = r.parseFailed ? ' (could not parse summary)' : '';
    console.log(
      `  ${status}  ${r.passed}/${r.total} passed, ${r.failed} failed — ${r.file} (${r.durationMs}ms)${parseNote}`,
    );
  }
  console.log('----------------------------------------');
  console.log(
    `  TOTAL  ${grandPassed}/${grandTotal} passed, ${grandFailed} failed across ${results.length} file(s) in ${totalDuration}ms`,
  );
  console.log('========================================');

  if (exitCode !== 0) {
    console.error('\nOne or more test files failed.');
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Runner crashed:', err);
  process.exit(2);
});
