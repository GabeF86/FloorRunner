/**
 * Pure incremental SSE frame parser, extracted verbatim from the reader loop
 * that AssistantPanel implemented inline. Framing contract:
 *
 * - Frames are delimited by "\n\n"; a trailing partial frame stays buffered
 *   across push() calls until its delimiter arrives.
 * - Within a completed frame, only lines with the exact "data: " prefix
 *   (colon + space) are parsed; each such line is one JSON event.
 * - Malformed JSON in a completed frame throws, propagating to the caller
 *   (the original code let JSON.parse throw into the send() try/catch).
 */
export type SSEEvent = Record<string, unknown>;

export interface SSEParser {
  /** Feed a decoded chunk; returns the events completed by this chunk, in order. */
  push(chunk: string): SSEEvent[];
}

export function createSSEParser(): SSEParser {
  let buffer = '';
  return {
    push(chunk: string): SSEEvent[] {
      buffer += chunk;
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      const events: SSEEvent[] = [];
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as SSEEvent);
        }
      }
      return events;
    },
  };
}
