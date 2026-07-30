// POST /api/scheduling/assistant/actions/[id]/revert — one-click undo.
// Restores the snapshot in scheduling.assistant_actions: active call pattern,
// site shift_types, and every version assignment; re-runs batch validation;
// stamps reverted_at. The revert snapshots the current state first, so the
// response's revertActionId is the undo-of-undo target.
import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { revertAction } from '@/lib/scheduleAssistant/snapshot';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sb = sbSchedulingServer();

  // scope 'assignments' restores ONLY the version's assignments (the
  // generation-undo case). Absent/anything else = 'all', the assistant's
  // pre-existing semantics byte for byte.
  let scope: 'all' | 'assignments' = 'all';
  try {
    const body = (await req.json()) as { scope?: unknown } | null;
    if (body?.scope === 'assignments') scope = 'assignments';
  } catch { /* no body — assistant default */ }

  try {
    const result = await revertAction(sb, id, { scope });
    if (result.notFound) {
      return NextResponse.json({ error: result.errors.join('; ') }, { status: 404 });
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
