/**
 * Create the FIRST admin invitation.
 *
 *   npx tsx scripts/bootstrap-admin.ts <provider-id> <email> [origin]
 *
 * Prints a /join link. Open it, choose a password, and the account is created
 * with the ADMIN role already attached — there is no window in which the first
 * chief exists with only provider access.
 *
 * ── WHY A SCRIPT AND NOT AN ENDPOINT ───────────────────────────────────────
 * An HTTP route that mints an admin invitation would have to be reachable
 * before any admin exists, which means reachable by anyone. That route would
 * then live in production forever, one misconfiguration away from being the
 * way in. A local script needs the service-role key and a shell, and it leaves
 * nothing behind.
 *
 * ── SAFE TO RE-RUN ─────────────────────────────────────────────────────────
 * Re-running revokes the previous pending invitation and issues a new link,
 * which is exactly what you want if the first one expired or was lost. It
 * refuses outright once the provider has a login.
 */

import { createClient } from '@supabase/supabase-js';
import { createInvitation } from '../src/lib/auth/inviteService';

async function main() {
  const [providerId, email, originArg] = process.argv.slice(2);
  if (!providerId || !email) {
    console.error('Usage: npx tsx scripts/bootstrap-admin.ts <provider-id> <email> [origin]');
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

  // Report which ORGANIZATION this binds to. FloorRunner's data is currently
  // split across two orgs, and a session is scoped to exactly one — so binding
  // the chief to the wrong one silently hides most of the app from them.
  const { data: prov, error } = await sb
    .from('providers')
    .select('id, first_name, last_name, organization_id, organizations:organization_id(name)')
    .eq('id', providerId)
    .maybeSingle();
  if (error) { console.error('Lookup failed:', error.message); process.exit(1); }
  if (!prov) { console.error('No provider with id', providerId); process.exit(1); }

  const orgRel = (prov as { organizations?: unknown }).organizations;
  const orgName = (Array.isArray(orgRel) ? orgRel[0] : orgRel) as { name?: string } | undefined;

  const res = await createInvitation(sb, null, {
    providerId, email, origin, now: new Date(), role: 'admin',
  });

  if (!res.ok) { console.error('Failed:', res.error); process.exit(1); }

  console.log('');
  console.log('  Admin invitation created');
  console.log('  ────────────────────────');
  console.log(`  Provider      ${prov.first_name} ${prov.last_name}  (${providerId})`);
  console.log(`  Organization  ${orgName?.name ?? prov.organization_id}`);
  console.log(`  Email         ${res.data!.email}`);
  console.log(`  Expires       ${new Date(res.data!.expiresAt).toLocaleString()}`);
  console.log('');
  console.log(`  ${res.data!.url}`);
  console.log('');
  console.log('  This link is shown once — the database stores only a hash.');
  console.log('  Re-run to issue a new one; the old link stops working.');
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
