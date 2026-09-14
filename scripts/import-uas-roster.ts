/**
 * Import the UAS staff roster.
 *
 *   npx tsx scripts/import-uas-roster.ts [--apply]
 *
 * Dry run by default: it prints exactly what it would create and writes
 * nothing. Pass --apply to perform the insert.
 *
 * Source of record is private/uas-roster-2026-09-14.json, parsed from
 * "Staffing Report updated 9.14.26.xlsx" (283 rows).
 *
 * That file is GITIGNORED and must stay so. This repository is public, and the
 * snapshot is 218 real physicians and CRNAs with their hire dates and FTEs —
 * employee PII that has no business on GitHub. The script is the reproducible
 * artifact; the data it reads is not.
 *
 * ── WHY A SCRIPT AND NOT A patchN.sql ──────────────────────────────────────
 * The patchN convention in this repo is for DDL. This is data: 218 people, no
 * schema change. A script can also be re-run safely and re-checked against the
 * live roster, which a one-shot SQL file cannot.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * Every run re-reads the live roster and skips anyone already present, matched
 * on (lower(last_name), lower(first_name)). Re-running creates nothing.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * It never UPDATES an existing provider. That is not timidity: the sheet's FTE
 * is the EMPLOYMENT factor, and for at least one physician (Hussain) it reads
 * 1.0 while his CALL fte_value is 0.70, because a third of his time is ICU
 * (patch43, work_days_fte). Overwriting from this sheet would silently change
 * what the scheduling engine thinks he owes.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';

const ORG = 'c4d9b24a-d11e-4eac-9d52-7e040d062a3b'; // United Anesthesia Services (UAS)
const ROSTER = join(__dirname, '..', 'private', 'uas-roster-2026-09-14.json');
const BATCH = 50;

interface RosterRow {
  first_name: string;
  last_name: string;
  provider_type: string;
  start_date: string | null;
  fte_value: number;
  employment_status: string;
  is_shareholder: boolean;
  call_taker: boolean;
  home_site_name: string | null;
  source_name: string;
  source_department: string | null;
  source_level: string | null;
}

/** .env.local, without adding a dotenv dependency for a one-off script. */
function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* env may already be present */ }
}

const key = (r: { first_name: string; last_name: string }) =>
  `${r.last_name.toLowerCase()}|${r.first_name.toLowerCase()}`;

async function main() {
  loadEnv();
  const apply = process.argv.includes('--apply');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) {
    console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }
  const sb = createClient(url, svc, {
    db: { schema: 'scheduling' },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const roster: RosterRow[] = JSON.parse(readFileSync(ROSTER, 'utf8'));

  const { data: existing, error: exErr } = await sb
    .from('providers').select('id, first_name, last_name').eq('organization_id', ORG);
  if (exErr) { console.error('Could not read the roster:', exErr.message); process.exit(1); }
  const present = new Set((existing ?? []).map(key));

  const { data: sites, error: siteErr } = await sb
    .from('sites').select('id, name').eq('organization_id', ORG);
  if (siteErr) { console.error('Could not read sites:', siteErr.message); process.exit(1); }
  const siteId = new Map((sites ?? []).map(s => [s.name as string, s.id as string]));

  const todo = roster.filter(r => !present.has(key(r)));
  const unmappedSite = todo.filter(r => r.home_site_name && !siteId.has(r.home_site_name));

  console.log(`\n  roster file        ${roster.length}`);
  console.log(`  already present    ${roster.length - todo.length}`);
  console.log(`  to create          ${todo.length}`);
  console.log(`  no home site       ${todo.filter(r => !r.home_site_name).length}`);
  if (unmappedSite.length) {
    // A site name in the roster that does not exist in UAS would silently
    // become a null home site, so it is surfaced rather than swallowed.
    console.log(`\n  !! ${unmappedSite.length} rows name a site that does not exist in UAS:`);
    for (const r of unmappedSite) console.log(`     ${r.source_name} -> ${r.home_site_name}`);
  }
  if (todo.length === 0) { console.log('\n  Nothing to do.\n'); return; }

  if (!apply) {
    console.log('\n  DRY RUN — nothing written. Re-run with --apply.\n');
    for (const r of todo.slice(0, 5)) {
      console.log(`     ${r.last_name}, ${r.first_name}  ${r.provider_type}  fte=${r.fte_value}`
        + `  ${r.employment_status}  call=${r.call_taker}  ${r.home_site_name ?? '(no site)'}`);
    }
    console.log(`     … and ${Math.max(0, todo.length - 5)} more\n`);
    return;
  }

  let created = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);

    const { data: inserted, error } = await sb.from('providers').insert(
      chunk.map(r => ({
        organization_id: ORG,
        provider_type: r.provider_type,
        first_name: r.first_name,
        last_name: r.last_name,
        preferred_display_name: `${r.first_name} ${r.last_name}`,
        status: 'active',
        start_date: r.start_date,
      })),
    ).select('id, first_name, last_name');
    if (error) { console.error('\n  Provider insert failed:', error.message); process.exit(1); }

    const idFor = new Map((inserted ?? []).map(
      p => [key(p as { first_name: string; last_name: string }), p.id as string],
    ));
    const profiles = chunk.map(r => ({
      provider_id: idFor.get(key(r)),
      employment_status: r.employment_status,
      fte_value: r.fte_value,
      is_shareholder: r.is_shareholder,
      call_taker: r.call_taker,
      home_site_id: r.home_site_name ? siteId.get(r.home_site_name) ?? null : null,
    }));
    const missing = profiles.filter(p => !p.provider_id);
    if (missing.length) {
      // Better to stop with providers created and profiles missing — which the
      // next run reports — than to write profiles against the wrong ids.
      console.error(`\n  ${missing.length} inserted providers could not be matched back by name. Stopping.`);
      process.exit(1);
    }

    const { error: profErr } = await sb.from('provider_employment_profiles').insert(profiles);
    if (profErr) { console.error('\n  Profile insert failed:', profErr.message); process.exit(1); }

    created += chunk.length;
    console.log(`  created ${created}/${todo.length}`);
  }

  // Verify against the live table rather than trusting the loop's own count.
  const { count: total } = await sb
    .from('providers').select('id', { count: 'exact', head: true }).eq('organization_id', ORG);
  const { data: orphans } = await sb
    .from('providers')
    .select('id, provider_employment_profiles(provider_id)')
    .eq('organization_id', ORG);
  const withoutProfile = (orphans ?? []).filter(
    (p) => ((p as { provider_employment_profiles?: unknown[] }).provider_employment_profiles ?? []).length === 0,
  ).length;

  console.log(`\n  UAS providers now  ${total}`);
  console.log(`  without a profile  ${withoutProfile}${withoutProfile ? '  <-- investigate' : ''}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
