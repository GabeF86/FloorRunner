import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { unsplitCallSlot } from '@/lib/scheduleSplit';

// Never prerender — this route hits Supabase per request.
export const dynamic = 'force-dynamic';

// POST /api/scheduling/schedule-slots/[id]/unsplit — [id] is ANY segment slot
// of the split call. Every sibling segment on the date must be OPEN
// (scheduleSplit.ts owns the guards); deletes the segments and restores the
// whole-call slot with an open assignment.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const sb = sbSchedulingServer();
  const { id } = await params;

  const out = await unsplitCallSlot(sb, id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status });
  return NextResponse.json({
    createdSlotId: out.createdSlotId,
    deletedSlotIds: out.deletedSlotIds,
    parentCode: out.parentCode,
  });
}
