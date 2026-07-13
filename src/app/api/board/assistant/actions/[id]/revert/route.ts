// POST /api/board/assistant/actions/[id]/revert — one-click undo for a board
// assistant turn. Restores the snapshot in public.board_assistant_actions: the
// in-scope day rows of the five day-scoped board tables, deletes the turn's
// relief_log entries, and stamps reverted_at. Realtime repaints the open board.
import { NextRequest, NextResponse } from 'next/server';
import { sbBoardServer } from '@/lib/supabaseBoard';
import { revertBoardAction } from '@/lib/boardAssistant/snapshot';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = sbBoardServer();

  try {
    const result = await revertBoardAction(sb, id);
    if (result.notFound) {
      return NextResponse.json({ error: result.errors.join('; ') }, { status: 404 });
    }
    if (result.alreadyReverted) {
      return NextResponse.json({ error: result.errors.join('; ') }, { status: 409 });
    }
    if (!result.ok) {
      return NextResponse.json({ error: result.errors.join('; ') }, { status: 500 });
    }
    return NextResponse.json({ ok: true, restored: result.restored, reliefDeleted: result.reliefDeleted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
