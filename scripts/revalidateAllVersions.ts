/**
 * Re-run batch validation on the latest version of every schedule so stored
 * validation_flags reflect the CURRENT evaluator set. Use after any change to
 * evaluators.ts semantics (e.g. 2026-07-14: call-only open-slot warnings +
 * poolEligibility) — stale flags otherwise persist until a version is next
 * validated by generation or an assistant action.
 *
 * Invocation (repo root, reads .env.local, writes to the LIVE database):
 *   npx tsx scripts/revalidateAllVersions.ts
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { loadSiteValidationContext } from '../src/lib/rulesEngine/loadContext';
import { batchValidateVersion } from '../src/lib/rulesEngine/batchValidate';

// dotenv isn't a dependency (Next loads .env.local itself) — parse the two
// vars we need directly.
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: 'scheduling' } },
);

async function main() {
  const { data: schedules, error } = await sb
    .from('schedules')
    .select('id, schedule_name, site_id, schedule_versions(id, version_number)');
  if (error) throw error;

  for (const s of schedules ?? []) {
    const versions = (s.schedule_versions ?? []) as Array<{ id: string; version_number: number }>;
    if (!versions.length) continue;
    const latest = versions.sort((a, b) => b.version_number - a.version_number)[0];
    const siteCtx = await loadSiteValidationContext(sb as never, s.site_id);
    const res = await batchValidateVersion(sb as never, latest.id, siteCtx);
    const evaluated = res.results.filter(r => r.evaluated).length;
    const hard = res.results.reduce((n, r) => n + r.violations.filter(v => v.severity === 'hard').length, 0);
    const soft = res.results.reduce((n, r) => n + r.violations.filter(v => v.severity === 'soft').length, 0);
    console.log(
      `${s.schedule_name} v${latest.version_number}: rows=${res.results.length} evaluated=${evaluated} ` +
      `hard=${hard} soft=${soft} written=${res.written} errors=${res.errors.length}`,
    );
    for (const e of res.errors.slice(0, 5)) console.log(`  error: ${e}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
