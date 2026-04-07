#!/usr/bin/env node
/**
 * Delete ALL providers in the first (or specified) organization.
 * Use this to reset test data before re-running seed-test-providers.mjs.
 *
 * Usage:
 *   1. Make sure the dev server is running: `npm run dev`
 *   2. node scripts/delete-all-providers.mjs
 *
 * Optional env vars:
 *   BASE_URL - defaults to http://localhost:3000
 *   ORG_ID   - skip auto-detect and target a specific org
 *   YES      - set to skip the confirmation prompt
 */

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function main() {
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
      console.error('No organizations found.');
      process.exit(1);
    }
    orgId = orgs[0].id;
    console.log(`Using organization: ${orgs[0].name || orgs[0].id} (${orgId})`);
  }

  const listRes = await fetch(`${BASE_URL}/api/scheduling/providers?org_id=${orgId}`);
  if (!listRes.ok) {
    console.error(`Failed to list providers: ${listRes.status}`);
    process.exit(1);
  }
  const providers = await listRes.json();
  if (!Array.isArray(providers) || providers.length === 0) {
    console.log('No providers to delete.');
    return;
  }

  console.log(`\nFound ${providers.length} provider(s):`);
  for (const p of providers) {
    console.log(`  - ${p.first_name} ${p.last_name} (${p.provider_type})`);
  }

  if (!process.env.YES) {
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(`\nPermanently delete all ${providers.length} providers? (yes/no): `);
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Aborted.');
      return;
    }
  }

  let deleted = 0;
  let failed = 0;
  for (const p of providers) {
    const res = await fetch(`${BASE_URL}/api/scheduling/providers/${p.id}`, { method: 'DELETE' });
    if (res.ok) {
      deleted++;
      console.log(`  deleted ${p.first_name} ${p.last_name}`);
    } else {
      failed++;
      console.error(`  FAIL ${p.first_name} ${p.last_name}: ${await res.text()}`);
    }
  }

  console.log(`\nDone. Deleted ${deleted}, failed ${failed}.`);
  if (deleted > 0) {
    console.log(`\nNext step: node scripts/seed-test-providers.mjs`);
  }
}

main().catch((e) => {
  console.error('Script crashed:', e);
  process.exit(1);
});
