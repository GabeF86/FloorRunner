// POST /api/scheduling/call-patterns/apply  { site_id, edits }
//
// Applies previewed edits. This is the only route that writes a pattern from
// the editor.
//
//   200 { added[], removed[], pattern }
//   400 { error }   — bad body, or the edits no longer apply
//   401/403         — not an admin
//   409 { error }   — the pattern changed since the preview was generated
//   500 { error }   — Supabase failure
//
// ── IT TAKES EDITS, NOT A DOCUMENT ─────────────────────────────────────────
// The client never sends a CallPatternDoc. If it did, anything able to reach
// this route could post an arbitrary pattern and the whole
// interpret → validate → review chain would be decoration. Instead the server
// re-reads the live pattern, re-applies the SAME named edits, and re-validates
// — so what is written is always code applying reviewed operations to the
// document that is actually in force.
//
// ── AND IT RE-CHECKS THE BASELINE ──────────────────────────────────────────
// Between preview and apply, someone else may have changed the pattern. The
// edits would then land on a document the reviewer never saw. The preview
// returns a fingerprint of what it was computed against; a mismatch is a 409
// rather than a silent write onto different ground.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { requireAdmin } from '@/lib/auth/session';
import { readActiveCallPattern, listShiftTypes } from '@/lib/queries/config';
import { applyPatternEdits, diffSchedulingLogic, type PatternEdit } from '@/lib/patternEdit';
import { replaceActivePattern } from '@/lib/scheduleAssistant/mutations';
import { CLASSIC_PATTERN } from '@/lib/rulesEngine/callPattern';
import type { ShiftTypeFacts } from '@/lib/schedulingLogic';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  site_id: z.string().min(1),
  // Shape-checked here only enough to be an object list; applyPatternEdits is
  // the real gate and rejects anything it cannot act on by name.
  edits: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
  /** What the preview was computed against — see the 409 below. */
  baseline_fingerprint: z.string().optional(),
}).strict();

// Not exported: a route handler may only export its HTTP verbs and the route
// config (dynamic, revalidate…). Any other named export fails the build's type
// check while tsc on src/ alone stays clean — the same trap page.tsx has.
/** Stable enough to notice a change; not a security boundary. */
function fingerprintDoc(doc: unknown): string {
  return JSON.stringify(doc);
}

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
    return NextResponse.json({ error: 'site_id and at least one edit are required.' }, { status: 400 });
  }
  const { site_id, edits, baseline_fingerprint } = parsed.data;

  const sb = sbSchedulingServer();
  const [patternRes, typesRes, siteRes] = await Promise.all([
    readActiveCallPattern(sb, site_id),
    listShiftTypes(sb, site_id),
    sb.from('sites').select('call_par_level').eq('id', site_id).maybeSingle(),
  ]);
  if (!patternRes.ok) return NextResponse.json({ error: patternRes.error }, { status: 500 });

  const baseline = patternRes.doc ?? CLASSIC_PATTERN;

  if (baseline_fingerprint && fingerprintDoc(baseline) !== baseline_fingerprint) {
    return NextResponse.json({
      error: 'This site\'s call pattern changed after the preview was generated. '
        + 'Re-run the change so you are reviewing what is actually in force.',
    }, { status: 409 });
  }

  const applied = applyPatternEdits(baseline, edits as unknown as PatternEdit[]);
  if (!applied.ok) return NextResponse.json({ error: applied.error }, { status: 400 });

  const shiftTypes = (typesRes.ok ? typesRes.rows : []) as unknown as ShiftTypeFacts[];
  const par = (siteRes.data as { call_par_level?: number } | null)?.call_par_level;
  const diff = diffSchedulingLogic(baseline, applied.doc, {
    shiftTypes,
    parLevel: typeof par === 'number' ? par : null,
  });

  // replaceActivePattern archives the current row and inserts the new one, so
  // the previous document survives as history — which is what makes this
  // reversible without a bespoke undo table.
  const { data, error } = await replaceActivePattern(sb, site_id, applied.doc, {
    // Carry the existing name forward. replaceActivePattern defaults to
    // "Custom pattern", which would quietly rename "Weekend v2" on its first
    // edit and lose the only label anyone recognises it by.
    ...(patternRes.name ? { name: patternRes.name } : {}),
    source: 'assistant',
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ added: diff.added, removed: diff.removed, pattern: data });
}
