/**
 * Merge "Test Org" into "United Anesthesia Services (UAS)".
 *
 *   npx tsx scripts/merge-orgs.ts [--apply]
 *
 * Dry run by default.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * FloorRunner's data was split across two organizations. Despite the names,
 * "Test Org" held the LIVE work — the Paoli schedule, 1,225 slots, 724
 * assignments, the weekend-v2 call pattern carrying the stated obligation
 * bands — while UAS held the staff roster and no schedule at all. Nothing ever
 * noticed, because every route runs on the service-role key and bypasses RLS.
 *
 * That becomes untenable the moment sessions exist: current_user_org_id()
 * scopes a login to exactly ONE organization, so a signed-in chief would see
 * either the roster or the schedule, never both. This merge is the
 * precondition for turning authentication on.
 *
 * ── SHAPE OF THE OPERATION ──────────────────────────────────────────────────
 *   1. repoint organization_id on every org-scoped table
 *   2. de-duplicate SITES  (4 names exist twice)
 *   3. de-duplicate PROVIDERS (13 people exist twice)
 *   4. delete the emptied organization
 *
 * Order is not arbitrary. Sites must be de-duplicated BEFORE providers: a
 * provider's home_site_id is repointed during step 2, and step 3 copies that
 * value onto the surviving record. Doing it the other way round would copy an
 * id that step 2 then deletes, and home_site_id is ON DELETE SET NULL — the
 * home site would silently become null for everyone involved.
 *
 * ── THE TWO FOREIGN KEYS THAT MAKE THIS DANGEROUS ───────────────────────────
 * assignments.provider_id is ON DELETE SET NULL. Deleting a provider who holds
 * assignments does not fail — it silently EMPTIES their slots. So the script
 * refuses to delete any provider with assignments, and every pair is oriented
 * so the record holding the work survives.
 *
 * provider_site_credentials.site_id is ON DELETE CASCADE and
 * provider_employment_profiles.home_site_id is ON DELETE SET NULL. Deleting a
 * duplicate site would therefore destroy its credentials and blank home sites.
 * Every reference is repointed before any site is deleted.
 *
 * schedule_slots.site_id is ON DELETE RESTRICT, which usefully makes it
 * impossible to delete the Paoli that holds the live schedule.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';

const UAS = 'c4d9b24a-d11e-4eac-9d52-7e040d062a3b';
const TEST = '3d4621c3-340f-4a16-b3fc-8529a2ccb42e';

/** Every table carrying organization_id. */
const ORG_TABLES = [
  'providers', 'sites', 'schedules', 'roles', 'rule_sets',
  'holiday_calendars', 'users', 'notifications', 'audit_log',
  'provider_custom_field_definitions',
];

/** Tables whose site_id must follow a de-duplicated site. */
const SITE_REFS: Array<[table: string, column: string]> = [
  ['provider_employment_profiles', 'home_site_id'],
  ['provider_availability', 'site_id'],
  ['provider_requests', 'site_id'],
  ['burden_targets', 'site_id'],
  ['burden_actuals', 'site_id'],
  ['holiday_calendars', 'site_id'],
  ['schedules', 'site_id'],
];

/**
 * Same person, recorded twice. KEEP holds the assignments; DROP is the empty
 * record created by the roster import. Nine were found by exact name; the last
 * four differ only by a familiar form of the first name, which no automatic
 * matcher would have caught and which would otherwise have duplicated four
 * physicians — two of them Paoli call takers.
 */
const PAIRS: Array<{ keep: string; drop: string; who: string }> = [
  { keep: 'dadf814c-2def-4704-8926-f7b5907a3646', drop: '77007f37-790f-4c2a-9fdc-987e2356446f', who: 'Amusa, Ganiyu' },
  { keep: 'c0ab7be1-cfe1-4f01-b6e9-b01281b14819', drop: '5285ac86-283b-4d0a-9452-893fd217bb91', who: 'Chamchad, Dmitri' },
  { keep: '906b3db2-8f52-4a8a-af9d-b1baeb4778f5', drop: '9bf68b88-2f2d-460a-82c3-ff9cdb69021e', who: 'Havildar, Sapna' },
  { keep: 'fb385733-8171-47fc-a2de-926d98373414', drop: '38efdc9a-9f39-4499-b667-4761374e46ac', who: 'Horan, Kevin' },
  { keep: '268706d8-b692-40b0-b1ff-70999387270d', drop: 'b4522a68-ec9d-4923-b7fb-c3eb2075b0dd', who: 'Hussain, Omar' },
  { keep: '4c39e7c3-4e5f-4824-a05c-9ba27bb47d0c', drop: '4acac1a8-f827-4d47-9e0c-996744f31f55', who: 'Jones, Archana' },
  { keep: '18598d26-4298-46bd-a65e-cd1de806ee98', drop: '03b140c5-7037-44d9-b8e2-f0e1129790b7', who: 'Kalawadia, Nina' },
  { keep: '36800add-7add-4709-8ce4-6feb253691e3', drop: '0e9fcbd3-0bac-48c5-9c16-f82df56723da', who: 'Lin, Victor' },
  { keep: '49491d5b-2853-4c20-ac37-fc0a42e915e1', drop: 'a64831da-33e9-437e-9ed0-71e2edf126b9', who: 'Vu, Stella' },
  // Nickname pairs — same person, different familiar name.
  { keep: '3a6f7647-9867-4b11-8529-bcd76426e04f', drop: '739b432a-f78e-4ee9-8bc0-8d6d8cfe858b', who: 'Farkas, Gabriel / Gabe' },
  { keep: '6328e0cc-963f-4072-8a2f-32d1d9451fd0', drop: '702374d7-a5ea-4b73-9e2d-5f463af20efb', who: 'Mojica, Ron / Ronald' },
  { keep: '1270e935-ac93-4e38-a54a-43e56550dc00', drop: '7245fcb5-5c6a-403b-80ac-f378311b53f4', who: 'Orji, Obi / Obinna' },
  { keep: '9075cc97-eab0-4e33-bf86-bfe979a6295b', drop: '46620410-8288-4bd6-a05d-2018efedd59c', who: 'Simon, Jim / James' },
];
// NOT a pair: Vu Stella (Paoli) and Vu Jonathan (Lankenau) are two people. The
// staffing report lists both.

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* env may already be present */ }
}

async function main() {
  loadEnv();
  const apply = process.argv.includes('--apply');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) { console.error('Missing Supabase env vars.'); process.exit(1); }
  const sb = createClient(url, svc, {
    db: { schema: 'scheduling' }, auth: { autoRefreshToken: false, persistSession: false },
  });

  const count = async (t: string, col: string, val: string) => {
    const { count: n } = await sb.from(t).select('id', { count: 'exact', head: true }).eq(col, val);
    return n ?? 0;
  };

  // ── Preconditions ────────────────────────────────────────────────────────
  const before = {
    uas: await count('providers', 'organization_id', UAS),
    test: await count('providers', 'organization_id', TEST),
    assignments: (await sb.from('assignments').select('id', { count: 'exact', head: true })).count ?? 0,
    slots: (await sb.from('schedule_slots').select('id', { count: 'exact', head: true })).count ?? 0,
  };
  console.log(`\n  BEFORE  UAS providers ${before.uas} | Test Org ${before.test}`
    + ` | assignments ${before.assignments} | slots ${before.slots}`);

  // Refuse to delete anyone holding work — assignments.provider_id is SET NULL,
  // so such a delete would silently empty their slots instead of failing.
  const unsafe: string[] = [];
  for (const p of PAIRS) {
    const n = await count('assignments', 'provider_id', p.drop);
    if (n > 0) unsafe.push(`${p.who}: the record marked for deletion holds ${n} assignments`);
  }
  if (unsafe.length) {
    console.error('\n  ABORT — pair orientation is wrong:');
    for (const u of unsafe) console.error('   ', u);
    process.exit(1);
  }
  console.log(`  ${PAIRS.length} duplicate people; every record marked for deletion holds 0 assignments.`);

  if (!apply) {
    console.log('\n  DRY RUN — nothing written. Re-run with --apply.\n');
    return;
  }

  // ── 1. Repoint the organization ──────────────────────────────────────────
  for (const t of ORG_TABLES) {
    const { error } = await sb.from(t).update({ organization_id: UAS }).eq('organization_id', TEST);
    if (error) { console.error(`  organization repoint failed on ${t}:`, error.message); process.exit(1); }
  }
  console.log(`  1. repointed ${ORG_TABLES.length} org-scoped tables`);

  // Roles are seeded PER ORGANIZATION, so repointing merges two sets of the
  // same two names into one org. Left alone that breaks invitation acceptance:
  // the role lookup uses a single-row read and PostgREST answers "JSON object
  // requested, multiple (or no) rows returned" — shown to someone mid-way
  // through setting their password. Learned the hard way on the first real
  // acceptance. There is now a UNIQUE (organization_id, name) constraint, so a
  // re-run would fail at step 1 instead; this keeps the script correct anyway.
  const { data: dupRoles } = await sb.from('roles')
    .select('id, name, created_at').eq('organization_id', UAS).order('created_at');
  const seenRole = new Set<string>();
  for (const r of dupRoles ?? []) {
    const n = r.name as string;
    if (!seenRole.has(n)) { seenRole.add(n); continue; }
    const grants = await count('user_roles', 'role_id', r.id as string);
    if (grants > 0) {
      // Never orphan a real grant; re-point it instead of deleting blindly.
      const keepId = (dupRoles ?? []).find(x => x.name === n)!.id as string;
      await sb.from('user_roles').update({ role_id: keepId }).eq('role_id', r.id as string);
    }
    await sb.from('roles').delete().eq('id', r.id as string);
    console.log(`     removed duplicate role '${n}'`);
  }

  // ── 2. De-duplicate sites ────────────────────────────────────────────────
  const { data: sites } = await sb.from('sites').select('id, name, created_at').eq('organization_id', UAS);
  const byName = new Map<string, Array<{ id: string; created_at: string }>>();
  for (const s of sites ?? []) {
    const list = byName.get(s.name as string) ?? [];
    list.push({ id: s.id as string, created_at: s.created_at as string });
    byName.set(s.name as string, list);
  }

  let sitesDropped = 0;
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    // The survivor is whichever holds the schedule. schedule_slots.site_id is
    // RESTRICT, so getting this backwards fails loudly rather than quietly.
    const withSlots = await Promise.all(list.map(async s => ({
      ...s, slots: await count('schedule_slots', 'site_id', s.id),
    })));
    withSlots.sort((a, b) => b.slots - a.slots || a.created_at.localeCompare(b.created_at));
    const keep = withSlots[0];
    for (const drop of withSlots.slice(1)) {
      for (const [table, col] of SITE_REFS) {
        const { error } = await sb.from(table).update({ [col]: keep.id }).eq(col, drop.id);
        if (error) { console.error(`  site repoint failed on ${table}.${col}:`, error.message); process.exit(1); }
      }
      // Credentials are UNIQUE (provider_id, site_id), so a provider already
      // credentialed at the survivor would collide. Drop those rows first, then
      // move the rest.
      const { data: dupCreds } = await sb.from('provider_site_credentials')
        .select('id, provider_id').eq('site_id', drop.id);
      for (const c of dupCreds ?? []) {
        const { data: clash } = await sb.from('provider_site_credentials')
          .select('id').eq('site_id', keep.id).eq('provider_id', c.provider_id as string).maybeSingle();
        if (clash) await sb.from('provider_site_credentials').delete().eq('id', c.id as string);
        else await sb.from('provider_site_credentials').update({ site_id: keep.id }).eq('id', c.id as string);
      }
      const { error: delErr } = await sb.from('sites').delete().eq('id', drop.id);
      if (delErr) { console.error(`  could not delete duplicate site ${name}:`, delErr.message); process.exit(1); }
      sitesDropped++;
      console.log(`     ${name}: kept ${keep.id} (${keep.slots} slots), removed ${drop.id}`);
    }
  }
  console.log(`  2. de-duplicated sites (${sitesDropped} removed)`);

  // ── 3. De-duplicate providers ────────────────────────────────────────────
  for (const p of PAIRS) {
    const { data: dropProf } = await sb.from('provider_employment_profiles')
      .select('*').eq('provider_id', p.drop).maybeSingle();
    const { data: keepProf } = await sb.from('provider_employment_profiles')
      .select('*').eq('provider_id', p.keep).maybeSingle();

    if (dropProf && keepProf) {
      // Fill only what the survivor is MISSING. Never overwrite: the surviving
      // record carries hand-tuned values the staffing sheet does not know
      // about — Hussain's call fte_value is 0.70 against the sheet's 1.0,
      // because a third of his time is ICU.
      const patch: Record<string, unknown> = {};
      if (keepProf.home_site_id == null && dropProf.home_site_id != null) patch.home_site_id = dropProf.home_site_id;
      if (!keepProf.is_shareholder && dropProf.is_shareholder) patch.is_shareholder = true;
      if (!keepProf.call_taker && dropProf.call_taker) patch.call_taker = true;
      if (Object.keys(patch).length) {
        await sb.from('provider_employment_profiles').update(patch).eq('provider_id', p.keep);
      }
    }

    // Move credentials the survivor does not already have.
    const { data: creds } = await sb.from('provider_site_credentials')
      .select('id, site_id').eq('provider_id', p.drop);
    for (const c of creds ?? []) {
      const { data: clash } = await sb.from('provider_site_credentials')
        .select('id').eq('provider_id', p.keep).eq('site_id', c.site_id as string).maybeSingle();
      if (!clash) await sb.from('provider_site_credentials').update({ provider_id: p.keep }).eq('id', c.id as string);
    }

    const { error } = await sb.from('providers').delete().eq('id', p.drop);
    if (error) { console.error(`  could not remove the duplicate for ${p.who}:`, error.message); process.exit(1); }
  }
  console.log(`  3. merged ${PAIRS.length} duplicate people`);

  // ── 4. Remove the emptied organization ───────────────────────────────────
  // EVERY foreign key onto organizations is ON DELETE CASCADE, so a row still
  // pointing at Test Org would be destroyed silently rather than blocking the
  // delete. Check all ten tables, not just the obvious two.
  const stragglers: string[] = [];
  for (const t of ORG_TABLES) {
    const n = await count(t, 'organization_id', TEST);
    if (n > 0) stragglers.push(`${t}: ${n}`);
  }
  if (stragglers.length) {
    console.error('  ABORT — rows still reference Test Org, and the delete would CASCADE them away:');
    for (const s of stragglers) console.error('   ', s);
    process.exit(1);
  }
  const { error: orgErr } = await sb.from('organizations').delete().eq('id', TEST);
  if (orgErr) { console.error('  could not delete the empty organization:', orgErr.message); process.exit(1); }
  console.log('  4. removed the emptied organization');

  // ── Verify ───────────────────────────────────────────────────────────────
  const after = {
    uas: await count('providers', 'organization_id', UAS),
    assignments: (await sb.from('assignments').select('id', { count: 'exact', head: true })).count ?? 0,
    slots: (await sb.from('schedule_slots').select('id', { count: 'exact', head: true })).count ?? 0,
  };
  const { count: orphanAssignments } = await sb
    .from('assignments').select('id', { count: 'exact', head: true }).is('provider_id', null);

  console.log(`\n  AFTER   UAS providers ${after.uas}`
    + ` | assignments ${after.assignments} | slots ${after.slots}`);
  console.log(`  assignments orphaned by the merge: ${orphanAssignments ?? 0}`);
  if (after.assignments !== before.assignments || after.slots !== before.slots) {
    console.error('  !! assignment or slot count changed — investigate immediately');
    process.exit(1);
  }
  console.log('  assignment and slot counts unchanged.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
