// POST /api/scheduling/assistant — the Claude schedule assistant.
//
// Body: { scheduleId, messages: [{role, content}...], image?: {media_type, data}, model? }
// Response: SSE stream (text/event-stream). Events (one JSON object per
// `data:` line) are the loop's AssistantEvent union: text-delta, tool-start,
// tool-done, and a final `done` carrying {changes, actionId, usage}. SDK
// failures surface as an `error` event with the mapped status
// (RateLimitError → 429, connection/529 → 503) — the HTTP response is already
// streaming by then, so the status rides in the event payload.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { formatZodIssues } from '@/lib/validation/scheduling';
import { runAssistant } from '@/lib/scheduleAssistant/assistant';
import { buildDefaultAssistantClient, mapAssistantError } from '@/lib/scheduleAssistant/client';

export const dynamic = 'force-dynamic';
// A structural change + full regeneration can run for minutes.
export const maxDuration = 300;

const BodySchema = z.object({
  scheduleId: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  })).min(1),
  image: z.object({
    media_type: z.string().min(1),
    data: z.string().min(1),
  }).optional(),
  model: z.string().optional(),
}).strict();

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.trim() === '') {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured on the server — the schedule assistant is unavailable.' },
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
        const sb = sbSchedulingServer();
        const client = buildDefaultAssistantClient();
        await runAssistant({
          sb,
          client,
          scheduleId: body.scheduleId,
          messages: body.messages,
          image: body.image,
          model: body.model,
          onEvent: send, // includes the final `done` event
        });
      } catch (err) {
        const { status, message } = mapAssistantError(err);
        console.error(`[scheduleAssistant] run failed (${status}): ${message}`);
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
