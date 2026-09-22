/**
 * Import the CRNA master spreadsheet.
 *
 *   npx tsx scripts/importCrnaSchedule.ts <file.csv>          # dry run
 *   npx tsx scripts/importCrnaSchedule.ts <file.csv> --write  # commit
 *
 * DRY BY DEFAULT. It prints the plan, the unmatched providers and every
 * conflict it found, and writes nothing. --write is a separate decision made
 * after reading that report.
 *
 * ── WHAT IT WRITES ─────────────────────────────────────────────────────────
 * One published schedule per SITE, holding that site's CRNA assignments. Not
 * one schedule for the file: the sheet is titled "Lankenau Master" and only
 * 54% of it is Lankenau — each cell names its own hospital, and a schedule is
 * a thing that belongs to one.
 *
 * ── WHAT IT DOES NOT WRITE ─────────────────────────────────────────────────
 * · Absences. This sheet contains none — 2,601 cells and every one is a work
 *   code, despite "(Work+Vac)" in the filename. A blank means "not working"
 *   with no way to tell a day off from PTO, and inventing leave from a blank
 *   would put approved time off on the record that nobody approved.
 * · Post-call days. cLankPC / cPaoliPC mark a rest day the call shift's
 *   requires_post_call_rule already implies; a zero-hour row for it would put
 *   a phantom line on every grid.
 * · Providers. An unmatched code is REPORTED, never created. Twelve
 *   code-named physicians already exist from the earlier import and cannot be
 *   resolved; adding more is not a thing to do by accident.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseCrnaCsv, parseCrnaCode, duplicateRows } from '../src/lib/scheduleImport/crnaCsv';

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* env may already be present */ }
}

/** Hand-resolved codes the surname+initial rule cannot reach. Each is a
 *  different irregularity, recorded with its reasoning — a rule general enough
 *  to catch them all would also catch the wrong person. */
const MANUAL: Record<string, { last: string; first: string; why: string }> = {
  // Gabriel 2026-09-22: "OdonR is Charles Odonnell (aka Ryan Odonnell)". The
  // R is the name he goes by, which is why the initial matches neither
  // Charles Odonnell nor Jennifer Odonovan. BOTH OdonR rows are this person.
  OdonR: { last: 'Odonnell', first: 'Charles', why: 'Ryan = Charles Odonnell (Gabriel)' },
  // The rule applied to the second element of a two-part surname; the sheet
  // sorts this row under W, which is the confirmation.
  Mahone: { last: 'Walley Mahoney', first: 'Elizabeth', why: 'second element of the surname; sorts under W' },
  // Sorts between JackL and KameD — a J name. Jakielaszek is the only one, so
  // the leading Z is a typo for J.
  Zjakij: { last: 'Jakielaszek', first: 'Jenna', why: 'Jaki+J; leading Z is a typo, row sorts in the Js' },
  // Three the rule misses by ONE character. Each has exactly one candidate in
  // the roster, an active CRNA, at the site its cells are for. Same standard
  // as the two above: a unique near-match is a spelling, a non-unique one
  // would be a guess and is left unmatched instead.
  HickyA: { last: 'Hickey', first: 'Angela', why: 'sheet drops the e; only Hick* in the roster' },
  ContA: { last: 'Conley', first: 'Amanda', why: 'Cont/Conl typo; only Con* in the roster' },
  SalaYa: { last: 'Salsabil', first: 'Yaser', why: 'Sala/Sals typo + Ya(ser); only Sal* in the roster' },
};

/**
 * Rows that are POSITIONS, not people.
 *
 * `cLankOpen1`, `cLankTrOpen2` — a line on the spreadsheet for a slot nobody
 * stood. 124 cells. Skipping them as "unmatched providers" would lose the one
 * fact they carry: the position existed and went unfilled. They are written as
 * slots with no assignment, which is exactly how the grid shows an open call.
 *
 * `SpinTest` is somebody testing the spreadsheet and is dropped outright.
 */
const PLACEHOLDER_RE = /Open\d*$/i;
const JUNK_ROWS = new Set(['SpinTest']);

const bare = (s: string) => s.replace(/[^a-z]/gi, '').toLowerCase();

async function main() {
  loadEnv();
  const file = process.argv[2];
  const write = process.argv.includes('--write');
  if (!file) {
    console.error('Usage: npx tsx scripts/importCrnaSchedule.ts <file.csv> [--write]');
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Supabase env vars missing.'); process.exit(1); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, {
    db: { schema: 'scheduling' }, auth: { persistSession: false },
  });

  const sheet = parseCrnaCsv(readFileSync(file, 'utf8'));
  console.log(`\nFILE   ${file}`);
  console.log(`dates  ${sheet.dates.length}  ${sheet.dates[0]} → ${sheet.dates[sheet.dates.length - 1]}`);
  console.log(`rows   ${sheet.rows.length}   cells ${sheet.cells.length}`);
  for (const p of sheet.problems) console.log(`  ! ${p}`);
  for (const d of duplicateRows(sheet)) {
    console.log(`  · ${d.code} is listed on ${d.rows} rows — treated as one person`);
  }

  // ── Reference data ──────────────────────────────────────────────────────
  const { data: sites } = await sb.from('sites').select('id, short_name, name, organization_id');
  const siteBy = new Map<string, { id: string; name: string; organization_id: string }>(
    (sites ?? []).map((s: Record<string, string>) => [s.short_name, s as never]));

  const { data: types } = await sb.from('shift_types')
    .select('id, site_id, code, provider_group').eq('provider_group', 'crna');
  const typeKey = (siteId: string, code: string) => `${siteId}|${code}`;
  const typeBy = new Map<string, string>(
    (types ?? []).map((t: Record<string, string>) => [typeKey(t.site_id, t.code), t.id]));

  const { data: providers } = await sb.from('providers')
    .select('id, first_name, last_name, provider_type').eq('status', 'active');

  // ── Provider matching: surname prefix + first initial ───────────────────
  const byRule = new Map<string, string[]>();
  for (const p of providers ?? []) {
    const last = bare(p.last_name), first = bare(p.first_name);
    if (!last || !first) continue;
    for (let k = 3; k <= Math.min(last.length, 6); k++) {
      for (const initLen of [1, 2]) {
        const code = (last.slice(0, k) + first.slice(0, initLen)).toLowerCase();
        const list = byRule.get(code);
        if (list) { if (!list.includes(p.id)) list.push(p.id); } else byRule.set(code, [p.id]);
      }
    }
  }
  const manualId = (last: string, first: string): string | null => {
    const hit = (providers ?? []).filter((p: Record<string, string>) =>
      p.last_name?.toLowerCase() === last.toLowerCase()
      && p.first_name?.toLowerCase() === first.toLowerCase());
    return hit.length === 1 ? hit[0].id : null;
  };

  const providerIds = new Map<string, string>();
  const ambiguous: string[] = [];
  const unmatched: Array<{ code: string; cells: number }> = [];
  const cellsPer = new Map<string, number>();
  for (const c of sheet.cells) cellsPer.set(c.providerCode, (cellsPer.get(c.providerCode) ?? 0) + 1);

  const placeholders = new Set<string>();
  for (const row of sheet.rows) {
    const code = row.providerCode;
    if (JUNK_ROWS.has(code)) continue;
    // A position row: its label is a shift code, not a name.
    if (PLACEHOLDER_RE.test(code) && parseCrnaCode(code)) { placeholders.add(code); continue; }
    if (providerIds.has(code)) continue;
    const man = MANUAL[code];
    if (man) {
      const id = manualId(man.last, man.first);
      if (id) { providerIds.set(code, id); continue; }
    }
    const hits = byRule.get(bare(code));
    if (hits?.length === 1) { providerIds.set(code, hits[0]); continue; }
    if (hits && hits.length > 1) { ambiguous.push(code); continue; }
    unmatched.push({ code, cells: cellsPer.get(code) ?? 0 });
  }

  // ── Build the per-site plan ─────────────────────────────────────────────
  const bySite = new Map<string, Array<{ date: string; shiftCode: string; providerId: string | null }>>();
  let openSlots = 0;
  const unknownCodes = new Map<string, number>();
  let skippedNoProvider = 0, postCallMarkers = 0, missingType = 0;
  const missingTypeCodes = new Map<string, number>();

  for (const cell of sheet.cells) {
    const parsed = parseCrnaCode(cell.code);
    if (!parsed) { unknownCodes.set(cell.code, (unknownCodes.get(cell.code) ?? 0) + 1); continue; }
    if (parsed.postCall) { postCallMarkers++; continue; }
    if (JUNK_ROWS.has(cell.providerCode)) continue;
    const isOpen = placeholders.has(cell.providerCode);
    const pid = isOpen ? null : (providerIds.get(cell.providerCode) ?? null);
    if (!isOpen && !pid) { skippedNoProvider++; continue; }
    if (isOpen) openSlots++;
    const site = siteBy.get(parsed.site);
    if (!site) { unknownCodes.set(cell.code, (unknownCodes.get(cell.code) ?? 0) + 1); continue; }
    if (!typeBy.has(typeKey(site.id, parsed.shiftCode))) {
      missingType++;
      missingTypeCodes.set(`${parsed.site}/${parsed.shiftCode}`,
        (missingTypeCodes.get(`${parsed.site}/${parsed.shiftCode}`) ?? 0) + 1);
      continue;
    }
    const list = bySite.get(parsed.site);
    const entry = { date: cell.date, shiftCode: parsed.shiftCode, providerId: pid };
    if (list) list.push(entry); else bySite.set(parsed.site, [entry]);
  }

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`\nPROVIDERS  matched ${providerIds.size}  ambiguous ${ambiguous.length}  unmatched ${unmatched.length}`);
  if (ambiguous.length) console.log(`  ambiguous: ${ambiguous.join(', ')}`);
  if (unmatched.length) {
    console.log('  UNMATCHED (their cells are SKIPPED):');
    for (const u of unmatched.sort((a, b) => b.cells - a.cells)) {
      console.log(`    ${u.code.padEnd(10)} ${String(u.cells).padStart(3)} cells`);
    }
  }
  if (unknownCodes.size) {
    console.log('  UNKNOWN CODES:');
    for (const [c, n] of unknownCodes) console.log(`    ${c.padEnd(22)} ${n}`);
  }
  if (missingType) {
    console.log(`  NO SHIFT TYPE (${missingType} cells):`);
    for (const [c, n] of missingTypeCodes) console.log(`    ${c.padEnd(22)} ${n}`);
  }
  console.log(`\n  OPEN positions written as unfilled slots            : ${openSlots}`);
  console.log(`  post-call markers skipped (derived, not written): ${postCallMarkers}`);
  console.log(`  cells skipped for an unmatched provider          : ${skippedNoProvider}`);

  console.log('\nPLAN');
  let total = 0;
  for (const [short, entries] of [...bySite.entries()].sort()) {
    const dates = entries.map(e => e.date).sort();
    console.log(`  ${short.padEnd(6)} ${String(entries.length).padStart(5)} assignments  `
      + `${dates[0]} → ${dates[dates.length - 1]}  `
      + `${new Set(entries.map(e => e.providerId).filter(Boolean)).size} people`
      + (entries.some(e => !e.providerId)
        ? `, ${entries.filter(e => !e.providerId).length} open` : ''));
    total += entries.length;
  }
  console.log(`  ${'TOTAL'.padEnd(6)} ${String(total).padStart(5)}`);

  if (!write) {
    console.log('\nDRY RUN — nothing written. Re-run with --write to commit.\n');
    return;
  }

  // ── Write ───────────────────────────────────────────────────────────────
  console.log('\nWRITING…');
  for (const [short, entries] of [...bySite.entries()].sort()) {
    const site = siteBy.get(short)!;
    const dates = entries.map(e => e.date).sort();
    const from = dates[0], to = dates[dates.length - 1];

    const { data: sched, error: sErr } = await sb.from('schedules').insert({
      organization_id: site.organization_id,
      site_id: site.id,
      schedule_name: `${short} — CRNA Master ${from} to ${to}`,
      schedule_type: 'call',
      provider_group: 'crna',
      date_start: from, date_end: to,
      status: 'published',
      current_version_number: 1, published_version_number: 1,
    }).select('id').single();
    if (sErr) { console.error(`  ${short}: ${sErr.message}`); continue; }

    const { data: ver, error: vErr } = await sb.from('schedule_versions').insert({
      schedule_id: sched.id, version_number: 1,
      version_status: 'published', published_at: new Date().toISOString(),
      notes: 'Imported from the CRNA master spreadsheet.',
    }).select('id').single();
    if (vErr) { console.error(`  ${short}: ${vErr.message}`); continue; }

    // One slot per (date, shift type, occurrence) and one assignment each.
    const slotRows = entries.map(e => ({
      schedule_version_id: ver.id,
      site_id: site.id,
      slot_date: e.date,
      shift_type_id: typeBy.get(typeKey(site.id, e.shiftCode)),
      required_count: 1,
      slot_index: 0,
    }));
    let made = 0;
    for (let i = 0; i < slotRows.length; i += 500) {
      const chunk = slotRows.slice(i, i + 500);
      const { data: slots, error: slErr } = await sb.from('schedule_slots')
        .insert(chunk).select('id');
      if (slErr) { console.error(`  ${short} slots: ${slErr.message}`); break; }
      // An OPEN position gets its slot and no assignment — that is what makes
      // the grid render it as an unfilled call rather than as nothing at all.
      const asn = slots
        .map((s: { id: string }, j: number) => ({ slot: s, e: entries[i + j] }))
        .filter((x: { e: { providerId: string | null } }) => x.e.providerId)
        .map((x: { slot: { id: string }; e: { providerId: string } }) => ({
          schedule_slot_id: x.slot.id,
          provider_id: x.e.providerId,
          assignment_status: 'assigned',
        }));
      if (asn.length > 0) {
        const { error: aErr } = await sb.from('assignments').insert(asn);
        if (aErr) { console.error(`  ${short} assignments: ${aErr.message}`); break; }
      }
      made += chunk.length;
    }
    console.log(`  ${short.padEnd(6)} ${made} assignments written`);
  }
  console.log('\nDone.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
