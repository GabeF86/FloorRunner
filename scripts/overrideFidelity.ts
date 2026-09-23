/**
 * Why does solve() drop a third of a supplied call assignment?
 *
 *   npx tsx scripts/overrideFidelity.ts <versionId> [--mode obligatory] [--seconds 60]
 *
 * READ ONLY.
 *
 * Measured across 8 synthetic blocks: handed CP-SAT's 113-slot call map,
 * solve(ctx, {callOverrides}) honours 80-84, MOVES 0, and DROPS 29-33. The
 * whole CP-SAT hybrid rides on that seam, so the drops are the feature's
 * ceiling. This classifies every one of them.
 *
 * Buckets, which correspond to the ways an override can fail to land:
 *   sequence-owned   the slot belongs to a chain; the main loop never offers
 *                    it, applyDayChains/applyBlockChains fill it from the
 *                    ANCHOR's holder and never consult the override map
 *   ineligible       overrideFor() ran evaluateEligibility against the LIVE
 *                    solve state and the forced provider failed a dynamic
 *                    gate (same-day, post-call rest) the model modelled
 *                    differently or not at all
 *   obligation-cap   obligatory mode refused the pin: the provider is at
 *                    their cap, or the whole-block chain admission did not fit
 *   other            anything else, printed verbatim
 */

import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadGenerationContext } from '../src/lib/rulesEngine/genContext';
import { solve } from '../src/lib/rulesEngine/solve';
import { buildCpsatModel } from '../src/lib/rulesEngine/cpsatModel';
import { computeSequenceOwnedSlotIds } from '../src/lib/rulesEngine/sequenceOwnership';
import { CLASSIC_PATTERN } from '../src/lib/rulesEngine/callPattern';
import type { FillMode } from '../src/lib/rulesEngine/genTypes';

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* already present */ }
}
const opt = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

async function main() {
  loadEnv();
  const versionId = process.argv[2];
  if (!versionId || versionId.startsWith('--')) {
    console.error('Usage: npx tsx scripts/overrideFidelity.ts <versionId> [--mode obligatory]');
    process.exit(1);
  }
  const mode = opt('mode', 'obligatory') as FillMode;
  const seconds = opt('seconds', '60');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('Supabase env vars missing.'); process.exit(1); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = createClient(url, key, {
    db: { schema: 'scheduling' }, auth: { persistSession: false },
  });

  const { ctx } = await loadGenerationContext(sb, versionId);
  if (!ctx) { console.error('Context failed to load.'); process.exit(1); }

  const outDir = join(__dirname, '..', '.cpsat');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const modelPath = join(outDir, `fidelity-${versionId}.json`);
  const model = buildCpsatModel(ctx);
  writeFileSync(modelPath, JSON.stringify(model));
  execFileSync('python3', [
    join(__dirname, 'cpsat', 'model.py'), modelPath, '--mode', mode, '--seconds', seconds,
  ], { stdio: 'pipe' });
  const sol = JSON.parse(readFileSync(
    modelPath.replace(/\.json$/, '') + `.solution.${mode}.json`, 'utf8'));
  const assignment = sol.assignment as Record<string, string>;

  const derived = solve(ctx, {
    callOverrides: new Map(Object.entries(assignment)), fillMode: mode,
  });

  const placed = new Map<string, string>();
  for (const a of derived.assignments) if (a.provider_id) placed.set(a.slot_id, a.provider_id);
  const unfilledBy = new Map(derived.unfilled.map(u => [u.slot_id, u]));
  const owned = computeSequenceOwnedSlotIds(ctx.callPattern ?? CLASSIC_PATTERN, ctx.slotIndex);
  const slotById = new Map(ctx.slotsToFill.map(s => [s.slot_id, s]));
  const chainLinkIds = new Set(model.chains.map(c => c.to));

  const buckets = new Map<string, Array<{ slot: string; code: string; date: string }>>();
  const add = (k: string, slotId: string) => {
    const s = slotById.get(slotId);
    const arr = buckets.get(k) ?? [];
    arr.push({ slot: slotId, code: s?.shift_type_code ?? '?', date: s?.slot_date ?? '?' });
    buckets.set(k, arr);
  };

  let honoured = 0, moved = 0;
  for (const [slotId, pid] of Object.entries(assignment)) {
    const got = placed.get(slotId);
    if (got === pid) { honoured++; continue; }
    if (got) { moved++; add(`MOVED to another provider`, slotId); continue; }
    const u = unfilledBy.get(slotId);
    if (owned.has(slotId)) add('sequence-owned (chain fills it, override never consulted)', slotId);
    else if (!u) add('vanished — neither assigned nor reported unfilled', slotId);
    else add(u.reason, slotId);
  }

  console.log(`\n  ${Object.keys(assignment).length} overrides supplied`);
  console.log(`  honoured ${honoured} · moved ${moved} · dropped `
    + `${Object.keys(assignment).length - honoured - moved}\n`);
  console.log('  WHY THE DROPS HAPPEN');
  const rows = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [reason, items] of rows) {
    console.log(`    ${String(items.length).padStart(4)}  ${reason}`);
    for (const it of items.slice(0, 3)) console.log(`            e.g. ${it.date} ${it.code}`);
    if (items.length > 3) console.log(`            … and ${items.length - 3} more`);
  }

  // ── What is actually blocking the 'ineligible' ones? ────────────────────
  // The model evaluates eligibility against an EMPTY state (static gates
  // only) and then states the dynamic rules as constraints. Every drop here
  // is a place where its statement of a dynamic rule differs from the
  // engine's. Classify by what the provider is doing in the derived plan on
  // and around that date — the two dynamic gates that can fire are the
  // one-call-per-day budget and post-call rest.
  const ineligible = buckets.get('Forced provider ineligible') ?? [];
  if (ineligible.length > 0) {
    const byPidDate = new Map<string, string[]>();
    for (const a of derived.assignments) {
      if (!a.provider_id) continue;
      const k = `${a.provider_id}|${a.slot_date}`;
      const cur = byPidDate.get(k);
      if (cur) cur.push(a.shift_type_code); else byPidDate.set(k, [a.shift_type_code]);
    }
    const shift = (d: string, n: number) => {
      const t = new Date(`${d}T00:00:00Z`);
      t.setUTCDate(t.getUTCDate() + n);
      return t.toISOString().slice(0, 10);
    };
    const tally = new Map<string, number>();
    for (const it of ineligible) {
      const pid = assignment[it.slot];
      const sameDay = byPidDate.get(`${pid}|${it.date}`);
      const prev = byPidDate.get(`${pid}|${shift(it.date, -1)}`);
      const prev2 = byPidDate.get(`${pid}|${shift(it.date, -2)}`);
      const label = sameDay ? `already working that day (${sameDay.join(',')})`
        : prev ? `worked the day before (${prev.join(',')}) — post-call rest`
          : prev2 ? `worked two days before (${prev2.join(',')})`
            : 'no adjacent assignment — some other dynamic gate';
      tally.set(label, (tally.get(label) ?? 0) + 1);
    }
    console.log('\n  THE \'ineligible\' DROPS, by what the provider was doing');
    for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  ${k}`);
    }
  }

  // Is the chain hypothesis the whole story?
  const droppedIds = rows.flatMap(([, items]) => items.map(i => i.slot));
  const linkShare = droppedIds.filter(id => chainLinkIds.has(id)).length;
  console.log(`\n  ${linkShare}/${droppedIds.length} dropped slots are a chain LINK in the model`);
  console.log(`  ${droppedIds.filter(id => owned.has(id)).length}/${droppedIds.length} are sequence-owned per the pattern`);
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
