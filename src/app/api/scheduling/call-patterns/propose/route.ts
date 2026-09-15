// POST /api/scheduling/call-patterns/propose  { site_id, request }
//
// Interprets a plain-English change and returns a PREVIEW. Writes nothing.
//
//   200 { edits, added[], removed[], publishedWarning? }
//   200 { unsupported }      — understood, but not expressible / already true
//   400 { error }            — bad body, or the edits do not apply to this pattern
//   401/403                  — not an admin
//   500 { error }            — no API key, transport failure, Supabase failure
//
// ── WHY PREVIEW AND APPLY ARE SEPARATE ROUTES ──────────────────────────────
// So that nothing is written by the act of asking. A single route that
// interpreted AND applied would make "what would this do?" indistinguishable
// from "do this", and the diff would be a receipt rather than a decision.
//
// ── ADMIN ONLY, GATED HERE ─────────────────────────────────────────────────
// requireAdmin() directly rather than relying on the middleware, matching the
// invite route: changing a call pattern changes how a hospital staffs its
// call, and that must not depend on an env flag being set.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { requireAdmin } from '@/lib/auth/session';
import { buildDefaultAssistantClient, mapAssistantError } from '@/lib/assistantCore/client';
import { readActiveCallPattern, listShiftTypes } from '@/lib/queries/config';
import { interpretPatternRequest } from '@/lib/patternInterpreter';
import { applyPatternEdits, diffSchedulingLogic } from '@/lib/patternEdit';
import { CLASSIC_PATTERN } from '@/lib/rulesEngine/callPattern';
import type { ShiftTypeFacts } from '@/lib/schedulingLogic';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  site_id: z.string().min(1),
  request: z.string().min(1).max(2000),
}).strict();

export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'site_id and a request are required.' }, { status: 400 });
  }
  const { site_id, request } = parsed.data;

  const sb = sbSchedulingServer();
  const [patternRes, typesRes, siteRes] = await Promise.all([
    readActiveCallPattern(sb, site_id),
    listShiftTypes(sb, site_id),
    sb.from('sites').select('name, call_par_level').eq('id', site_id).maybeSingle(),
  ]);

  if (!patternRes.ok) return NextResponse.json({ error: patternRes.error }, { status: 500 });
  const site = siteRes.data as { name?: string; call_par_level?: number } | null;
  if (!site) return NextResponse.json({ error: 'That site does not exist.' }, { status: 400 });

  // A site with no stored pattern runs on CLASSIC. Editing from that baseline
  // is legitimate — it is what the engine is actually using — but the reply
  // says so, because the first save would turn an implicit default into an
  // explicit document.
  const baseline = patternRes.doc ?? CLASSIC_PATTERN;
  const shiftTypes = (typesRes.ok ? typesRes.rows : []) as unknown as ShiftTypeFacts[];
  const parLevel = typeof site.call_par_level === 'number' ? site.call_par_level : null;

  let interpreted;
  try {
    interpreted = await interpretPatternRequest(buildDefaultAssistantClient(), {
      request,
      doc: baseline,
      shiftTypes,
      parLevel,
      siteName: site.name ?? 'this site',
    });
  } catch (e) {
    const mapped = mapAssistantError(e);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }

  if (!interpreted.ok) {
    return interpreted.kind === 'unsupported'
      ? NextResponse.json({ unsupported: interpreted.message })
      : NextResponse.json({ error: interpreted.message }, { status: 500 });
  }

  const applied = applyPatternEdits(baseline, interpreted.edits);
  if (!applied.ok) {
    // The model proposed something the pattern cannot take. That is the
    // applier doing its job, and the message names the target that was wrong.
    return NextResponse.json({ error: applied.error }, { status: 400 });
  }

  const diff = diffSchedulingLogic(baseline, applied.doc, { shiftTypes, parLevel });
  if (diff.identical) {
    return NextResponse.json({
      unsupported: 'That change would not alter how this site schedules — the pattern already behaves that way.',
    });
  }

  // How many schedules are already published here. A pattern change affects
  // the NEXT generation and rewrites nothing that exists, which is not
  // obvious: without saying so, "Friday C1 now covers neuro" reads as though
  // it just altered the live schedule.
  const { count: publishedCount } = await sb
    .from('schedule_versions')
    .select('id, schedules!inner(site_id)', { count: 'exact', head: true })
    .eq('version_status', 'published')
    .eq('schedules.site_id', site_id);

  return NextResponse.json({
    edits: interpreted.edits,
    added: diff.added,
    removed: diff.removed,
    usingClassicBaseline: patternRes.doc === null,
    publishedCount: publishedCount ?? 0,
  });
}
