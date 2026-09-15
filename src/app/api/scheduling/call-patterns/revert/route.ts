// POST /api/scheduling/call-patterns/revert  { site_id, pattern_id, dry_run? }
//
// Puts a previously archived pattern back in force.
//
//   200 { added[], removed[], identical }            — dry_run
//   200 { added[], removed[], pattern }              — applied
//   400 { error }   — bad body, or the archived document no longer validates
//   401/403         — not an admin
//   404 { error }   — no such archived pattern at this site
//   500 { error }   — Supabase failure
//
// ── A REVERT IS A CHANGE, AND GETS THE SAME REVIEW ─────────────────────────
// dry_run exists so going back is previewed in exactly the English a forward
// change is. "Undo" sounds safe enough to click without reading, which is
// precisely why it should show its consequences: reverting a week-old pattern
// can silently discard three changes made since.
//
// ── THE ARCHIVED DOCUMENT IS RE-VALIDATED ──────────────────────────────────
// It satisfied the schema when it was written, but the schema can tighten
// between then and now. Restoring a document the CURRENT engine would reject
// is the one thing this route must not do, because the engine answers an
// invalid pattern by silently falling back to CLASSIC — so the site would look
// reverted while scheduling something else entirely.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { requireAdmin } from '@/lib/auth/session';
import { readActiveCallPattern, listShiftTypes } from '@/lib/queries/config';
import { diffSchedulingLogic } from '@/lib/patternEdit';
import { replaceActivePattern } from '@/lib/scheduleAssistant/mutations';
import { CallPatternDocSchema, CLASSIC_PATTERN } from '@/lib/rulesEngine/callPattern';
import type { ShiftTypeFacts } from '@/lib/schedulingLogic';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  site_id: z.string().min(1),
  pattern_id: z.string().min(1),
  dry_run: z.boolean().optional(),
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
    return NextResponse.json({ error: 'site_id and pattern_id are required.' }, { status: 400 });
  }
  const { site_id, pattern_id, dry_run } = parsed.data;

  const sb = sbSchedulingServer();

  // Scoped to the site as well as the id, so a pattern id from another site
  // cannot be restored here by guessing.
  const { data: row, error: rowErr } = await sb
    .from('call_patterns')
    .select('id, name, definition, status')
    .eq('id', pattern_id)
    .eq('site_id', site_id)
    .maybeSingle();
  if (rowErr) return NextResponse.json({ error: rowErr.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'No such pattern for this site.' }, { status: 404 });

  const archived = row as { id: string; name: string | null; definition: unknown; status: string };
  if (archived.status === 'active') {
    return NextResponse.json({ error: 'That pattern is already in force.' }, { status: 400 });
  }

  const restored = CallPatternDocSchema.safeParse(archived.definition);
  if (!restored.success) {
    return NextResponse.json({
      error: 'That archived pattern no longer passes validation, so restoring it would leave '
        + 'the site on the built-in classic structure rather than on the pattern shown. '
        + `First problem: ${restored.error.issues[0]?.message ?? 'unknown'}.`,
    }, { status: 400 });
  }

  const [currentRes, typesRes, siteRes] = await Promise.all([
    readActiveCallPattern(sb, site_id),
    listShiftTypes(sb, site_id),
    sb.from('sites').select('call_par_level').eq('id', site_id).maybeSingle(),
  ]);
  if (!currentRes.ok) return NextResponse.json({ error: currentRes.error }, { status: 500 });

  const current = currentRes.doc ?? CLASSIC_PATTERN;
  const par = (siteRes.data as { call_par_level?: number } | null)?.call_par_level;
  const diff = diffSchedulingLogic(current, restored.data, {
    shiftTypes: (typesRes.ok ? typesRes.rows : []) as unknown as ShiftTypeFacts[],
    parLevel: typeof par === 'number' ? par : null,
  });

  if (dry_run) {
    return NextResponse.json({ added: diff.added, removed: diff.removed, identical: diff.identical });
  }

  const { data, error } = await replaceActivePattern(sb, site_id, restored.data, {
    ...(archived.name ? { name: archived.name } : {}),
    source: 'manual',
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ added: diff.added, removed: diff.removed, pattern: data });
}
