#!/usr/bin/env node
/**
 * Seed test providers (physicians + CRNAs) into FloorRunner.
 *
 * Usage:
 *   1. Make sure the dev server is running: `npm run dev`
 *   2. In another terminal: `node scripts/seed-test-providers.mjs`
 *
 * Optional env vars:
 *   BASE_URL  - defaults to http://localhost:3000
 *   ORG_ID    - skip auto-detect and target a specific org
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const PHYSICIANS = [
  { first_name: 'Sarah',   last_name: 'Mitchell',  employment_status: 'full_time', call_taker: true,  is_shareholder: true,  fellowship_primary: 'cardiac' },
  { first_name: 'David',   last_name: 'Chen',      employment_status: 'full_time', call_taker: true,  is_shareholder: true,  fellowship_primary: 'pediatric' },
  { first_name: 'Maria',   last_name: 'Rodriguez', employment_status: 'full_time', call_taker: true,  is_shareholder: true,  fellowship_primary: 'obstetric' },
  { first_name: 'James',   last_name: 'Patel',     employment_status: 'full_time', call_taker: true,  is_shareholder: true,  fellowship_primary: 'regional' },
  { first_name: 'Emily',   last_name: 'Thompson',  employment_status: 'full_time', call_taker: true,  is_shareholder: false, fellowship_primary: null },
  { first_name: 'Michael', last_name: 'Nguyen',    employment_status: 'full_time', call_taker: true,  is_shareholder: false, fellowship_primary: 'cardiac' },
  { first_name: 'Rachel',  last_name: 'Goldberg',  employment_status: 'part_time', call_taker: false, is_shareholder: false, fellowship_primary: null },
  { first_name: 'Thomas',  last_name: 'Anderson',  employment_status: 'full_time', call_taker: true,  is_shareholder: true,  fellowship_primary: 'neuro' },
  { first_name: 'Linda',   last_name: 'Park',      employment_status: 'full_time', call_taker: true,  is_shareholder: false, fellowship_primary: 'pain' },
  { first_name: 'Robert',  last_name: 'Williams',  employment_status: 'per_diem',  call_taker: false, is_shareholder: false, fellowship_primary: null },
];

const CRNAS = [
  { first_name: 'Jennifer', last_name: 'Brooks',    employment_status: 'full_time', call_taker: true,  fellowship_primary: null },
  { first_name: 'Marcus',   last_name: 'Johnson',   employment_status: 'full_time', call_taker: true,  fellowship_primary: null },
  { first_name: 'Ashley',   last_name: 'Davis',     employment_status: 'full_time', call_taker: true,  fellowship_primary: null },
  { first_name: 'Brandon',  last_name: 'Martinez',  employment_status: 'full_time', call_taker: true,  fellowship_primary: null },
  { first_name: 'Stephanie',last_name: 'Lee',       employment_status: 'full_time', call_taker: false, fellowship_primary: null },
  { first_name: 'Kevin',    last_name: 'Walker',    employment_status: 'full_time', call_taker: true,  fellowship_primary: null },
  { first_name: 'Nicole',   last_name: 'Hall',      employment_status: 'full_time', call_taker: true,  fellowship_primary: null },
  { first_name: 'Daniel',   last_name: 'Wright',    employment_status: 'full_time', call_taker: true,  fellowship_primary: null },
  { first_name: 'Megan',    last_name: 'Carter',    employment_status: 'part_time', call_taker: false, fellowship_primary: null },
  { first_name: 'Tyler',    last_name: 'Phillips',  employment_status: 'full_time', call_taker: true,  fellowship_primary: null },
  { first_name: 'Amanda',   last_name: 'Reed',      employment_status: 'part_time', call_taker: false, fellowship_primary: null },
  { first_name: 'Christopher', last_name: 'Bailey', employment_status: 'per_diem',  call_taker: false, fellowship_primary: null },
  { first_name: 'Lauren',   last_name: 'Cooper',    employment_status: 'full_time', call_taker: true,  fellowship_primary: null },
  { first_name: 'Justin',   last_name: 'Murphy',    employment_status: 'full_time', call_taker: true,  fellowship_primary: null },
  { first_name: 'Hannah',   last_name: 'Rivera',    employment_status: 'full_time', call_taker: false, fellowship_primary: null },
];

async function main() {
  // 1. Get organization id
  let orgId = process.env.ORG_ID;
  if (!orgId) {
    const res = await fetch(`${BASE_URL}/api/scheduling/organizations`);
    if (!res.ok) {
      console.error(`Failed to fetch organizations: ${res.status} ${res.statusText}`);
      console.error('Is the dev server running on', BASE_URL, '?');
      process.exit(1);
    }
    const orgs = await res.json();
    if (!Array.isArray(orgs) || orgs.length === 0) {
      console.error('No organizations found. Create one first via the UI.');
      process.exit(1);
    }
    orgId = orgs[0].id;
    console.log(`Using organization: ${orgs[0].name || orgs[0].id} (${orgId})`);
  }

  // 2. Fetch sites for this org so we can credential providers at them
  const sitesRes = await fetch(`${BASE_URL}/api/scheduling/sites?org_id=${orgId}`);
  const sites = sitesRes.ok ? await sitesRes.json() : [];
  if (!Array.isArray(sites) || sites.length === 0) {
    console.warn('\n⚠  No sites found for this org — providers will be created WITHOUT site credentials.');
    console.warn('   Create at least one site via the UI first if you want full rules-engine coverage.\n');
  } else {
    console.log(`Found ${sites.length} site(s): ${sites.map((s) => s.short_name || s.name).join(', ')}`);
  }

  let created = 0;
  let failed = 0;
  let credsCreated = 0;
  let credsFailed = 0;

  const seedCredential = async (providerId, providerName, site, opts) => {
    const body = {
      site_id: site.id,
      credentialed: true,
      is_active: true,
      can_take_call: opts.callTaker,
      can_take_weekend_call: opts.callTaker,
      can_take_holiday_call: opts.callTaker,
      can_take_backup_call: opts.callTaker,
      allowed_shift_types: [],
      excluded_shift_types: [],
      skill_tags: opts.skills,
    };
    const res = await fetch(`${BASE_URL}/api/scheduling/providers/${providerId}/site-credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`       cred FAIL @ ${site.short_name || site.name}: ${err}`);
      credsFailed++;
      return;
    }
    credsCreated++;
  };

  const seed = async (provider, type) => {
    const body = {
      organization_id: orgId,
      provider_type: type,
      ...provider,
      email: `${provider.first_name.toLowerCase()}.${provider.last_name.toLowerCase()}@floorrunner.test`,
      status: 'active',
    };
    const res = await fetch(`${BASE_URL}/api/scheduling/providers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`  FAIL ${type} ${provider.first_name} ${provider.last_name}: ${err}`);
      failed++;
      return;
    }
    const data = await res.json();
    const displayName = data.short_display_name || `${provider.first_name} ${provider.last_name}`;
    console.log(`  OK   ${type.padEnd(9)} ${displayName}`);
    created++;

    // Seed site credentials. Strategy:
    // - Physicians: credentialed at ALL sites (multi-site coverage common for partners)
    // - CRNAs: credentialed at the first 1-2 sites only (reflects home-site model)
    if (sites.length === 0) return;
    const targetSites = type === 'physician' ? sites : sites.slice(0, Math.min(2, sites.length));

    // Skill tags derived from provider profile
    const skills = [];
    if (provider.fellowship_primary) skills.push(provider.fellowship_primary);
    if (type === 'physician') skills.push('physician');
    if (type === 'crna') skills.push('crna');

    for (const site of targetSites) {
      await seedCredential(data.id, displayName, site, {
        callTaker: provider.call_taker,
        skills,
      });
    }
  };

  console.log(`\nSeeding ${PHYSICIANS.length} physicians...`);
  for (const p of PHYSICIANS) await seed(p, 'physician');

  console.log(`\nSeeding ${CRNAS.length} CRNAs...`);
  for (const p of CRNAS) await seed(p, 'crna');

  console.log(`\nDone.`);
  console.log(`  Providers   — created: ${created}, failed: ${failed}`);
  console.log(`  Credentials — created: ${credsCreated}, failed: ${credsFailed}`);
}

main().catch((e) => {
  console.error('Seed script crashed:', e);
  process.exit(1);
});
