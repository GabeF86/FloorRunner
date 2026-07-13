// POST /api/board/assistant — the Claude board (floor-runner) copilot.
//
// Body: { boardDate: 'YYYY-MM-DD', hospital: string | null,
//         messages: [{role, content}...], model? }
// Response: SSE stream (text/event-stream). Events (one JSON object per `data:`
// line) are the loop's AssistantEvent union: text-delta, tool-start, tool-done,
// and a final `done` carrying {changes, actionId, usage}. SDK failures surface
// as an `error` event with the mapped status — the HTTP response is already
// streaming by then, so the status rides in the event payload.
//
// This is a thin adapter over the domain-generic loop (assistantCore/loop.ts),
// the board sibling of the scheduling route: it builds the BoardCtx, the shared
// BoardActionRef, the executor map, and the snapshot closure that stashes the
// action id into the ref BEFORE any mutating executor runs (the T6 seam —
// mark_relieved reads actionRef.actionId to record the relief_log row it creates
// into the open snapshot), then delegates the conversation mechanics.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sbBoardServer } from '@/lib/supabaseBoard';
import { formatZodIssues } from '@/lib/validation/scheduling';
import {
  runAssistantLoop,
  type AssistantEvent,
} from '@/lib/assistantCore/loop';
import { buildDefaultAssistantClient, mapAssistantError, type AssistantMessageParam } from '@/lib/assistantCore/client';
import {
  boardTools,
  MUTATING_BOARD_TOOLS,
  createBoardExecutors,
  type BoardCtx,
  type BoardActionRef,
} from '@/lib/boardAssistant/tools';
import { takeBoardSnapshot } from '@/lib/boardAssistant/snapshot';
import { loadBoardSystemPrompt } from '@/lib/boardAssistant/prompt';

export const dynamic = 'force-dynamic';
// Board turns are small (per-row upserts, no regeneration engine) — a minute is
// plenty and well under the schedule route's 300s.
export const maxDuration = 60;

const BodySchema = z.object({
  // The board's working date. Kept a plain YYYY-MM-DD string (the board tables
  // are date-scoped on this exact value) — reject anything that isn't.
  boardDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'boardDate must be an ISO date (YYYY-MM-DD).'),
  // null / '' = the board's "All facilities" pill (no hospital filter).
  hospital: z.string().nullable(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  })).min(1),
  model: z.string().optional(),
}).strict();

// Snapshot label for the Undo chip — derived from the runner's latest utterance,
// mirroring the schedule adapter's snapshotSummaryFrom.
function snapshotSummary(messages: Array<{ role: string; content: string }>): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const t = lastUser?.content ?? null;
  if (!t) return 'Board assistant edit';
  return `Board assistant: ${t.length > 180 ? `${t.slice(0, 180)}…` : t}`;
}

export async function POST(req: NextRequest) {
  // Pre-parse key check (same as the scheduling route): fail as a plain JSON 500
  // BEFORE we open a stream, so a misconfigured server returns a normal response.
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.trim() === '') {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured on the server — the board assistant is unavailable.' },
      { status: 500 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(formatZodIssues(parsed.error), { status: 400 });
  }
  const body = parsed.data;

  const ctx: BoardCtx = { boardDate: body.boardDate, hospital: body.hospital };

  // System = frozen board.md + a SMALL trailing context block (date + hospital).
  // The whole thing rides in ONE cached system block (buildRequest stamps
  // cache_control on the last block), so a multi-turn conversation on the SAME
  // board reuses the cached prefix. Deliberately NO high-resolution timestamp
  // here — that would bust the cache every request; get_board carries the
  // current time for time-of-day reasoning instead.
  const contextText = [
    `Board date: ${ctx.boardDate}.`,
    ctx.hospital && ctx.hospital.trim() !== ''
      ? `Hospital in scope: ${ctx.hospital}.`
      : 'Hospital in scope: All facilities (no hospital filter).',
  ].join('\n');
  const systemPrompt = `${loadBoardSystemPrompt()}\n\n${contextText}`;

  const initialMessages: AssistantMessageParam[] = body.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        // A disconnected client makes enqueue throw — swallow it so the run
        // finishes (mutations + snapshot already happened server-side).
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* client gone */
        }
      };
      try {
        const sb = sbBoardServer();
        const client = buildDefaultAssistantClient();

        // Shared handle the snapshot closure populates before the first mutating
        // executor runs; mark_relieved reads it to record its relief_log row.
        const actionRef: BoardActionRef = { actionId: null };
        const executors = createBoardExecutors(sb, ctx, actionRef);

        const summary = snapshotSummary(body.messages);
        const takeSnapshot = async (): Promise<string | null> => {
          try {
            const id = await takeBoardSnapshot(sb, ctx, summary);
            actionRef.actionId = id; // the T6 seam — before any mutating executor
            return id;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[boardAssistant] snapshot failed — refusing mutations this turn: ${message}`);
            return null;
          }
        };

        await runAssistantLoop({
          client,
          systemPrompt,
          tools: boardTools,
          executors,
          mutatingTools: MUTATING_BOARD_TOOLS,
          takeSnapshot,
          messages: initialMessages,
          onEvent: (ev: AssistantEvent) => send(ev), // includes the final `done`
          model: body.model,
        });
      } catch (err) {
        const { status, message } = mapAssistantError(err);
        console.error(`[boardAssistant] run failed (${status}): ${message}`);
        send({ type: 'error', status, message });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
