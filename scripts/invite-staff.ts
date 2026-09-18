/**
 * Invite a back-office STAFF member.
 *
 *   npx tsx scripts/invite-staff.ts <email> <first> <last> [origin]
 *
 * Prints a /join link. They open it, choose their own password, and the account
 * is created with the STAFF role attached.
 *
 * ── WHAT STAFF CAN AND CANNOT DO ───────────────────────────────────────────
 * Can:    enter and maintain operational data, work the schedule, manage
 *         provider information, run the board, demonstrate the platform.
 * Cannot: change the generation contract (call patterns, /rules), shift types
 *         or templates, organisation settings, or reach the LLM assistants.
 *         The allow-list is STAFF_PREFIXES in src/lib/auth/routeAccess.ts, and
 *         everything absent from it is admin-only by default.
 *
 * ── WHY A SCRIPT, NOT AN ENDPOINT ──────────────────────────────────────────
 * Same reason as bootstrap-admin: a route that mints accounts is a route that
 * lives in production forever, one misconfiguration from being the way in. A
 * local script needs the service-role key and a shell, and leaves nothing
 * behind.
 *
 * ── NO PROVIDER RECORD IS CREATED ──────────────────────────────────────────
 * A coordinator is not a clinician. Inventing a provider row to satisfy a
 * foreign key would put them in the roster, the call pool and every staffing
 * count — see createStaffInvitation.
 *
 * Safe to re-run: the previous pending invitation for the same address is
 * revoked and a new link issued. It refuses once the address has a login.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createStaffInvitation } from '../src/lib/auth/inviteService';

/** .env.local, without adding a dotenv dependency for a one-off script. */
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
  const [email, first, last, originArg] = process.argv.slice(2);
  if (!email || !first || !last) {
    console.error('Usage: npx tsx scripts/invite-staff.ts <email> <first> <last> [origin]');
    process.exit(1);
  }
  const origin = originArg || process.env.NEXT_PUBLIC_SITE_ORIGIN || 'http://localhost:3000';

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (load .env.local).');
    process.exit(1);
  }

  const sb = createClient(url, key, {
    db: { schema: 'scheduling' },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Report which organization this binds to. A session is scoped to exactly
  // one, so binding to the wrong one would silently hide most of the app.
  const { data: orgs, error: orgError } = await sb
    .from('organizations').select('id, name').order('created_at').limit(1);
  if (orgError) { console.error('Organization lookup failed:', orgError.message); process.exit(1); }
  const org = (orgs ?? [])[0];
  if (!org) { console.error('No organization exists.'); process.exit(1); }

  // The role must exist before the link is handed out: discovering it missing
  // at redemption means someone types a password and gets an error.
  const { data: role, error: roleError } = await sb
    .from('roles').select('id').eq('organization_id', org.id).eq('name', 'staff').maybeSingle();
  if (roleError) { console.error('Role lookup failed:', roleError.message); process.exit(1); }
  if (!role) {
    console.error('The "staff" role is missing for this organization. Apply patch60.');
    process.exit(1);
  }

  const res = await createStaffInvitation(sb, null, {
    email, firstName: first, lastName: last,
    organizationId: org.id, origin, now: new Date(),
  });
  if (!res.ok) { console.error('Failed:', res.error); process.exit(1); }

  console.log('');
  console.log('  Staff invitation created');
  console.log('  ────────────────────────');
  console.log(`  Name          ${first} ${last}`);
  console.log(`  Email         ${res.data!.email}`);
  console.log(`  Organization  ${org.name}`);
  console.log(`  Role          staff — operational data and the schedule.`);
  console.log(`                NOT call patterns, /rules, shift types,`);
  console.log(`                settings, or the assistants.`);
  console.log(`  Expires       ${new Date(res.data!.expiresAt).toLocaleString()}`);
  console.log('');
  console.log(`  ${res.data!.url}`);
  console.log('');
  console.log('  This link is shown once — the database stores only a hash.');
  console.log('  Re-run to issue a new one; the old link stops working.');
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
