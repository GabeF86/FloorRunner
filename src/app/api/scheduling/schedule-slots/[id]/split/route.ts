import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { splitCallSlot, type SplitMode } from '@/lib/scheduleSplit';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// POST /api/scheduling/schedule-slots/[id]/split  { mode: '2x12' | '3x8' }
// Splits a whole OPEN call slot into segment slots (scheduleSplit.ts owns the
// guards: call category, not-a-segment, open assignment, current version).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const sb = sbSchedulingServer();
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON: { mode: "2x12" | "3x8" }' }, { status: 400 });
  }
  const mode = (body as { mode?: unknown } | null)?.mode;
  if (mode !== '2x12' && mode !== '3x8') {
    return NextResponse.json({ error: `mode must be '2x12' or '3x8' (got ${JSON.stringify(mode ?? null)})` }, { status: 400 });
  }

  const out = await splitCallSlot(sb, id, mode as SplitMode);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({
    createdSlotIds: out.createdSlotIds,
    deletedSlotId: out.deletedSlotId,
    mode: out.mode,
    segmentCodes: out.segmentCodes,
  });
}
