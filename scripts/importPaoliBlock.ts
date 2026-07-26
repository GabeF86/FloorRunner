/**
 * Import a Paoli block workbook into a normalized constraint manifest.
 *
 * Usage (repo root):
 *   npx tsx scripts/importPaoliBlock.ts <workbook.xlsx> --roster <roster.json> [options]
 *   npx tsx scripts/importPaoliBlock.ts <workbook.xlsx> --live [options]
 *
 * Roster source (exactly one):
 *   --roster <path>   JSON array of { id, name, aliases? }
 *   --live            READ-ONLY roster load from the live DB (active physicians;
 *                     reads .env.local; performs no writes of any kind)
 *
 * Options:
 *   --expect prompt   compare against the Paoli prompt's full-workbook checksums
 *   --expect <path>   compare against a ChecksumValues JSON file
 *   --out <dir>       output directory (default: artifacts/)
 *   --name <label>    artifact basename (default: slugified workbook filename)
 *
 * Writes <out>/<name>.manifest.json and <out>/<name>.report.txt.
 * Exit codes: 0 = clean; 1 = hard import errors; 2 = checksum mismatches only.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { importPaoliBlockWorkbook } from '../src/lib/paoliBlock/importWorkbook';
import { renderImportReport } from '../src/lib/paoliBlock/report';
import { PROMPT_EXPECTED_CHECKSUMS } from '../src/lib/paoliBlock/checksums';
import type { ChecksumValues } from '../src/lib/paoliBlock/manifest';
import type { RosterEntry } from '../src/lib/paoliBlock/names';

function fail(msg: string): never {
  console.error(`importPaoliBlock: ${msg}`);
  process.exit(1);
}

interface Args {
  workbook: string;
  rosterPath?: string;
  live: boolean;
  expect?: string;
  out: string;
  name?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { workbook: '', live: false, out: 'artifacts' };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--roster') args.rosterPath = argv[++i];
    else if (a === '--live') args.live = true;
    else if (a === '--expect') args.expect = argv[++i];
    else if (a === '--out') args.out = argv[++i] ?? 'artifacts';
    else if (a === '--name') args.name = argv[++i];
    else if (a.startsWith('--')) fail(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) {
    fail('usage: npx tsx scripts/importPaoliBlock.ts <workbook.xlsx> (--roster <roster.json> | --live) [--expect prompt|<path>] [--out <dir>] [--name <label>]');
  }
  args.workbook = positional[0];
  if (!args.rosterPath && !args.live) fail('one of --roster <path> or --live is required');
  if (args.rosterPath && args.live) fail('--roster and --live are mutually exclusive');
  return args;
}

async function loadLiveRoster(): Promise<RosterEntry[]> {
  // Read-only roster load; mirrors scripts/revalidateAllVersions.ts env bootstrap.
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'scheduling' } },
  );
  const { data, error } = await sb
    .from('providers')
    .select('id, short_display_name, first_name, last_name, provider_type, status')
    .eq('status', 'active')
    .eq('provider_type', 'physician')
    .order('short_display_name');
  if (error) fail(`live roster query failed: ${error.message}`);
  // Aliases: last name and FIRST name both participate as exact candidate
  // keys — the 8/10-10/25 workbook lists Ganiyu by his first name "Amusa"
  // (Gabriel 2026-07-26). Uniqueness still guards: a first name colliding
  // with any other candidate key surfaces as an ambiguous HARD error.
  return (data ?? []).map((p) => ({
    id: p.id as string,
    name: p.short_display_name as string,
    aliases: [p.last_name, p.first_name].filter((x): x is string => !!x),
  }));
}

function loadExpected(expect: string | undefined): ChecksumValues | null {
  if (!expect) return null;
  if (expect === 'prompt') return PROMPT_EXPECTED_CHECKSUMS;
  return JSON.parse(readFileSync(expect, 'utf8')) as ChecksumValues;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let bytes: Buffer;
  try {
    bytes = readFileSync(args.workbook);
  } catch {
    fail(`cannot read workbook: ${args.workbook}`);
  }

  const roster: RosterEntry[] = args.live
    ? await loadLiveRoster()
    : (JSON.parse(readFileSync(args.rosterPath!, 'utf8')) as RosterEntry[]);
  if (!Array.isArray(roster) || roster.some((r) => !r?.id || !r?.name)) {
    fail('roster must be a JSON array of { id, name }');
  }

  const expectedChecksums = loadExpected(args.expect);

  const result = importPaoliBlockWorkbook(bytes, {
    workbookLabel: path.basename(args.workbook),
    roster,
    expectedChecksums,
  });

  const name =
    args.name ??
    path
      .basename(args.workbook)
      .replace(/\.[^.]+$/, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  mkdirSync(args.out, { recursive: true });

  const manifestPath = path.join(args.out, `${name}.manifest.json`);
  const reportPath = path.join(args.out, `${name}.report.txt`);

  if (result.manifest) {
    writeFileSync(manifestPath, JSON.stringify(result.manifest, null, 2) + '\n');
    const report = renderImportReport(result.manifest);
    writeFileSync(reportPath, report);
    console.log(report);
    console.log(`manifest: ${manifestPath}`);
    console.log(`report:   ${reportPath}`);
  } else {
    for (const e of result.hardErrors) console.error(`HARD ERROR: ${e}`);
  }

  if (result.hardErrors.length) {
    console.error(`\nimport FAILED with ${result.hardErrors.length} hard error(s).`);
    process.exit(1);
  }
  if (result.checksums.ok === false) {
    console.error('\nimport completed with CHECKSUM MISMATCHES (see report).');
    process.exit(2);
  }
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
