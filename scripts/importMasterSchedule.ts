/**
 * Import the group's master schedule CSV into FloorRunner.
 *
 * Usage (repo root):
 *   npx tsx scripts/importMasterSchedule.ts <master.csv> --dry-run
 *   npx tsx scripts/importMasterSchedule.ts <master.csv> --apply
 *
 * Reads .env.local and writes with the service-role key.
 *
 * ── WHAT IT WRITES ─────────────────────────────────────────────────────────
 *   shift_types            created where a site lacks the code (never edited)
 *   schedules + versions   one PUBLISHED version per site for the CSV window
 *   schedule_slots         ONE PER ASSIGNMENT, plus one per open position
 *   assignments            one per filled cell
 *   provider_availability  leave runs, tagged source='master_csv_import'
 *
 * ── AND WHAT IT REPLACES ───────────────────────────────────────────────────
 * A site's previously imported schedule for the same window is ARCHIVED, not
 * deleted — history is kept, and a published schedule is never left overlapping
 * a new one, which would double-book the entire roster against clinical
 * invariant 3. Availability rows written by a previous run of THIS importer are
 * deleted and rewritten; rows entered by hand are left alone, identified by the
 * `source` column.
 *
 * Re-running is safe: it produces the same result, not a second copy.
 */

import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { parseMasterCsv } from '../src/lib/scheduleImport/masterCsv';
import { planImport, duplicatePositions, crossSiteSameDay, leaveConflicts } from '../src/lib/scheduleImport/plan';
import type { ImportPlan, PlannedAssignment } from '../src/lib/scheduleImport/plan';
import { DICTIONARY, PLACEHOLDER_ROWS, requiredShiftTypes, assumptions } from '../src/lib/scheduleImport/dictionary';

const IMPORT_SOURCE = 'master_csv_import';

// ── env ────────────────────────────────────────────────────────────────────

function loadEnv(): { url: string; key: string } {
  const text = readFileSync('.env.local', 'utf8');
  const get = (name: string) => {
    const m = new RegExp(`^${name}=(.*)$`, 'm').exec(text);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const url = get('NEXT_PUBLIC_SUPABASE_URL');
  const key = get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('.env.local is missing the Supabase URL or service-role key.');
  return { url, key };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

async function must<T>(label: string, p: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) {
    const msg = (error as { message?: string }).message ?? JSON.stringify(error);
    throw new Error(`${label}: ${msg}`);
  }
  return data;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const apply = args.includes('--apply');
  if (!file) {
    console.error('Usage: npx tsx scripts/importMasterSchedule.ts <master.csv> [--apply]');
    process.exit(1);
  }

  const { url, key } = loadEnv();
  const sb: Sb = createClient(url, key, { db: { schema: 'scheduling' }, auth: { persistSession: false } });

  // ── Roster ──────────────────────────────────────────────────────────────
  const providers = await must<Array<{ id: string; short_display_name: string | null; first_name: string | null; last_name: string | null }>>(
    'providers', sb.from('providers')
      .select('id, short_display_name, first_name, last_name')
      .eq('provider_type', 'physician').eq('status', 'active'));

  // CSV code → provider id. Exact short_display_name first; then the group's
  // 3+1 code rule (first three of the surname + first initial), which is how
  // the roster's un-coded records are named. A code that resolves to more than
  // one physician is left UNMATCHED rather than guessed — the cost of a wrong
  // match is one doctor's call night on another doctor's record.
  const byShort = new Map<string, string>();
  const byRule = new Map<string, string[]>();
  for (const p of providers) {
    if (p.short_display_name) byShort.set(p.short_display_name, p.id);
    const last = (p.last_name || '').replace(/[^a-z]/gi, '');
    const first = (p.first_name || '').replace(/[^a-z]/gi, '');
    if (last.length >= 3 && first.length >= 1) {
      const code = (last.slice(0, 3) + first[0]).toUpperCase();
      const list = byRule.get(code);
      if (list) list.push(p.id); else byRule.set(code, [p.id]);
    }
  }
  // The Paoli roster is stored under a different scheme ("G.Farkas"), so the
  // rule is applied to THAT form too.
  for (const p of providers) {
    const m = /^([A-Z])\.(.+)$/.exec(p.short_display_name || '');
    if (!m) continue;
    const code = (m[2].replace(/[^a-z]/gi, '').slice(0, 3) + m[1]).toUpperCase();
    if (!byShort.has(code)) {
      const list = byRule.get(code);
      if (list) { if (!list.includes(p.id)) list.push(p.id); } else byRule.set(code, [p.id]);
    }
  }

  // Codes the two rules above cannot reach, each resolved by hand against the
  // roster and recorded with its reasoning. Written as a table rather than as
  // extra rules because every one of them is a different irregularity, and a
  // rule general enough to catch them all would also catch the wrong person.
  const MANUAL: Record<string, { surname: string; first: string; why: string }> = {
    // Surname + first TWO letters of the forename — needed because Jonathan Vu
    // is also on the roster, at a different site.
    VUST: { surname: 'Vu', first: 'Stella', why: 'VU + ST; disambiguates from Jonathan Vu (LMC)' },
    // Four letters of the surname — SCO alone is Kevin Scott.
    SCOZT: { surname: 'Scozzafava', first: 'Thomas', why: 'SCOZ + T; SCO is taken by Kevin Scott' },
    // The rule applied to the second element of a two-part surname.
    AMEO: { surname: 'Ben Amer', first: 'Omar', why: 'AME + O, taking "Amer" as the surname' },
    // The roster holds two records for this physician — "Dmitri Gorelick" with
    // the live Paoli-scheme short name, and "Dmitry Gorelik" created by the
    // 2026-09-14 bulk import. Pointed at the first; the pair needs merging.
    GORDI: { surname: 'Gorelick', first: 'Dmitri', why: 'duplicate roster records; uses the D.Gorelick row' },
    // NEEDS CONFIRMATION. BAL is unique in the roster (Konstantinos Balis,
    // Lankenau) and the row is a heavy Lankenau call-taker, which fits — but
    // the code implies a forename starting with D, not K. Included because
    // dropping it loses 35 Lankenau call cells; flagged in the report.
    BALD: { surname: 'Balis', first: 'Konstantinos', why: 'UNCONFIRMED — code implies a D forename' },
  };
  const manualId = (surname: string, first: string): string | null => {
    const hit = providers.filter(p =>
      (p.last_name || '').toLowerCase() === surname.toLowerCase()
      && (p.first_name || '').toLowerCase() === first.toLowerCase());
    return hit.length === 1 ? hit[0].id : null;
  };

  const sheet = parseMasterCsv(readFileSync(file, 'utf8'));
  const providerIds = new Map<string, string>();
  const ambiguous: string[] = [];
  const manualUsed: string[] = [];
  for (const row of sheet.rows) {
    const code = row.providerCode;
    if (providerIds.has(code) || PLACEHOLDER_ROWS.has(code)) continue;
    const exact = byShort.get(code);
    if (exact) { providerIds.set(code, exact); continue; }
    const ruled = byRule.get(code);
    if (ruled?.length === 1) { providerIds.set(code, ruled[0]); continue; }
    if (ruled && ruled.length > 1) { ambiguous.push(code); continue; }
    const manual = MANUAL[code];
    if (manual) {
      const id = manualId(manual.surname, manual.first);
      if (id) { providerIds.set(code, id); manualUsed.push(`${code} → ${manual.first} ${manual.surname} (${manual.why})`); }
    }
  }

  const plan = planImport({ sheet, mappings: DICTIONARY, providerIds, placeholders: PLACEHOLDER_ROWS });

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(70)}\nMASTER SCHEDULE IMPORT — ${apply ? 'APPLY' : 'DRY RUN'}\n${'='.repeat(70)}`);
  console.log(`source      : ${file}`);
  console.log(`window      : ${sheet.dates[0]} .. ${sheet.dates[sheet.dates.length - 1]} (${sheet.dates.length} days)`);
  console.log(`rows        : ${sheet.rows.length}  providers matched: ${providerIds.size}`);
  console.log(`assignments : ${plan.assignments.length} (${plan.assignments.filter(a => !a.providerId).length} open positions)`);
  console.log(`leave runs  : ${plan.availability.length}`);

  if (plan.unmapped.length) {
    console.log(`\nUNMAPPED CODES (${plan.unmapped.length}) — import blocked:`);
    for (const u of plan.unmapped) console.log(`   ${u.code}  ${u.count} cells  [${u.sections.join(', ')}]`);
    console.error('\nEvery code must be in the dictionary before importing. Nothing written.');
    process.exit(1);
  }
  if (plan.unknownProviders.length) {
    console.log(`\nUNMATCHED PROVIDERS (${plan.unknownProviders.length}) — their cells are SKIPPED:`);
    for (const u of plan.unknownProviders) {
      console.log(`   ${u.providerCode.padEnd(8)} ${u.section.padEnd(12)} ${u.cells} cells`);
    }
  }
  if (manualUsed.length) {
    console.log(`\nMATCHED BY HAND (${manualUsed.length}) — each is an irregular code:`);
    for (const m of manualUsed) console.log(`   ${m}`);
  }
  if (ambiguous.length) console.log(`\nAMBIGUOUS CODES (left unmatched): ${ambiguous.join(', ')}`);
  for (const p of plan.problems) console.log(`   ! ${p}`);

  const dupes = duplicatePositions(plan);
  const cross = crossSiteSameDay(plan);
  const leave = leaveConflicts(plan);
  console.log(`\nFINDINGS CARRIED THROUGH (imported as written, for review on the grid):`);
  console.log(`   ${dupes.length} call positions with two holders`);
  for (const d of dupes) console.log(`      ${d.date} ${d.site} ${d.shiftCode}: ${d.providers.join(' + ')}`);
  console.log(`   ${cross.length} physicians at two sites on one day`);
  for (const c of cross) console.log(`      ${c.date} ${c.providerCode}: ${c.sites.join(' + ')}`);
  console.log(`   ${leave.length} assignments landing inside a leave block`);

  console.log(`\nPER SITE:`);
  for (const s of plan.sites) {
    console.log(`   ${s.site.padEnd(7)} ${s.firstDate} .. ${s.lastDate}  ${String(s.assignments).padStart(5)} assignments`);
  }

  console.log(`\n${assumptions().length} ASSUMPTIONS — review these before trusting the numbers:`);
  for (const a of assumptions()) console.log(`   ${a.code}: ${a.assumption}`);

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.\n');
    return;
  }

  // ── Sites and shift types ───────────────────────────────────────────────
  const sites = await must<Array<{ id: string; short_name: string; organization_id: string }>>(
    'sites', sb.from('sites').select('id, short_name, organization_id'));
  const siteId = new Map(sites.map(s => [s.short_name, s.id]));
  const orgId = sites[0].organization_id;

  const existingTypes = await must<Array<{ id: string; site_id: string; code: string; is_active: boolean }>>(
    'shift_types', sb.from('shift_types').select('id, site_id, code, is_active'));
  const typeId = new Map<string, string>();
  for (const t of existingTypes) {
    const short = sites.find(s => s.id === t.site_id)?.short_name;
    if (short) typeId.set(`${short}|${t.code}`, t.id);
  }

  let created = 0;
  for (const spec of requiredShiftTypes()) {
    const key = `${spec.site}|${spec.code}`;
    if (typeId.has(key)) continue;
    const sid = siteId.get(spec.site);
    if (!sid) { console.log(`   ! no site ${spec.site}; skipping ${spec.code}`); continue; }
    const row = await must<Array<{ id: string }>>(`create ${key}`, sb.from('shift_types').insert({
      site_id: sid, code: spec.code, name: spec.name, category: spec.category,
      provider_group: 'physician',
      start_time: spec.startTime, end_time: spec.endTime,
      // A shift whose end is at or before its start runs past midnight. `<=`
      // not `<`: an 07:00→07:00 weekend call is a full 24 hours, and `<` would
      // record it as zero-length (the patch54 bug).
      crosses_midnight: spec.endTime <= spec.startTime,
      call_rank: spec.callRank,
      requires_post_call_rule: spec.requiresPostCall,
      counts_toward_call_burden: spec.countsTowardCallBurden,
      counts_toward_hours: true, is_active: true,
    }).select('id'));
    typeId.set(key, row[0].id);
    created++;
  }
  console.log(`\nshift types created: ${created}`);

  // Paoli's D8 is stored inactive and the sheet uses it once.
  await must('reactivate D8', sb.from('shift_types').update({ is_active: true })
    .eq('site_id', siteId.get('PH')).eq('code', 'D8').select('id'));

  // ── Per site: archive, then build ───────────────────────────────────────
  const first = sheet.dates[0];
  const last = sheet.dates[sheet.dates.length - 1];

  for (const site of plan.sites) {
    const sid = siteId.get(site.site);
    if (!sid) continue;
    const name = `${site.site} — Master ${first} to ${last}`;

    // Archive anything published that overlaps the window, including a prior
    // run of this importer. Two published schedules over one date range would
    // double-book the roster.
    const overlapping = await must<Array<{ id: string }>>('overlapping schedules',
      sb.from('schedules').select('id').eq('site_id', sid)
        .lte('date_start', last).gte('date_end', first));
    for (const s of overlapping) {
      await must('archive versions', sb.from('schedule_versions')
        .update({ version_status: 'archived' }).eq('schedule_id', s.id).select('id'));
      await must('archive schedule', sb.from('schedules')
        .update({ status: 'archived' }).eq('id', s.id).select('id'));
    }
    if (overlapping.length) console.log(`   ${site.site}: archived ${overlapping.length} overlapping schedule(s)`);

    const sched = await must<Array<{ id: string }>>('create schedule', sb.from('schedules').insert({
      organization_id: orgId, site_id: sid, schedule_name: name,
      schedule_type: 'master', provider_group: 'physician',
      date_start: site.firstDate, date_end: site.lastDate,
      status: 'published', current_version_number: 1, published_version_number: 1,
    }).select('id'));
    const version = await must<Array<{ id: string }>>('create version', sb.from('schedule_versions').insert({
      schedule_id: sched[0].id, version_number: 1, version_status: 'published',
      published_at: new Date().toISOString(),
      notes: `Imported from ${file} on ${new Date().toISOString().slice(0, 10)}.`,
    }).select('id'));
    const versionId = version[0].id;

    // One slot per assignment. slot_index separates concurrent rooms of the
    // same shift type on one date — eight physicians on the Lankenau day code
    // are eight rooms, not one contested position.
    const mine = plan.assignments.filter(a => a.site === site.site);
    const indexByKey = new Map<string, number>();
    const slotRows = mine.map((a: PlannedAssignment) => {
      const key = `${a.date}|${a.shiftCode}`;
      const idx = indexByKey.get(key) ?? 0;
      indexByKey.set(key, idx + 1);
      return {
        schedule_version_id: versionId, site_id: sid, slot_date: a.date,
        shift_type_id: typeId.get(`${a.site}|${a.shiftCode}`),
        slot_label: a.sourceCode, required_count: 1, slot_index: idx,
        derived_day_type: dayType(a.date),
        generated_by_system: false,
      };
    }).filter(r => r.shift_type_id);

    const slotIds: string[] = [];
    for (let i = 0; i < slotRows.length; i += 400) {
      const batch = await must<Array<{ id: string }>>('insert slots',
        sb.from('schedule_slots').insert(slotRows.slice(i, i + 400)).select('id'));
      for (const r of batch) slotIds.push(r.id);
    }

    const assignRows = mine
      .map((a, i) => ({ a, slotId: slotIds[i] }))
      .filter(x => x.slotId && x.a.providerId)
      .map(x => ({
        schedule_slot_id: x.slotId, provider_id: x.a.providerId,
        assignment_status: 'assigned', source_type: 'imported',
        assigned_at: new Date().toISOString(),
        notes: `Master sheet: ${x.a.sourceCode}${x.a.starred ? ' (noted)' : ''}`,
      }));
    for (let i = 0; i < assignRows.length; i += 400) {
      await must('insert assignments',
        sb.from('assignments').insert(assignRows.slice(i, i + 400)).select('id'));
    }
    console.log(`   ${site.site}: ${slotRows.length} slots, ${assignRows.length} assignments`);
  }

  // ── Availability ────────────────────────────────────────────────────────
  // Only rows this importer wrote are cleared, so hand-entered time off — and
  // anything the request workflow created — survives a re-run.
  await must('clear prior import availability', sb.from('provider_availability')
    .delete().eq('source', IMPORT_SOURCE).select('id'));

  const avRows = plan.availability.map(av => ({
    provider_id: av.providerId,
    availability_type: av.availabilityType,
    start_date: av.startDate, end_date: av.endDate, all_day: true,
    // A waitlist keeps its real status. 'waitlisted' is not dismissed by
    // isDismissedAvailability (only denied/canceled are), so it still blocks —
    // which is what an un-adjudicated request must do.
    approval_status: av.sourceCode === '1. Vac' ? 'waitlisted' : 'approved',
    source: IMPORT_SOURCE,
    notes: `Master sheet: ${av.sourceCode}`,
  }));
  for (let i = 0; i < avRows.length; i += 400) {
    await must('insert availability',
      sb.from('provider_availability').insert(avRows.slice(i, i + 400)).select('id'));
  }
  console.log(`\navailability rows: ${avRows.length}`);
  console.log('\nImport complete.\n');
}

/** The engine's day-type label for a date. Holidays are not resolved here — a
 *  holiday-dated call still folds onto its weekday everywhere it matters. */
function dayType(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return ['sunday', 'weekday', 'weekday', 'weekday', 'weekday', 'friday', 'saturday'][dow];
}

main().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
