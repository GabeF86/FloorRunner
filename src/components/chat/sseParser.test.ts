/**
 * Tests for the pure incremental SSE frame parser extracted from
 * AssistantPanel's reader loop. The framing contract (verbatim from the
 * original code) is:
 *
 *   buffer += chunk;
 *   const frames = buffer.split('\n\n');
 *   buffer = frames.pop() ?? '';
 *   for (const frame of frames)
 *     for (const line of frame.split('\n'))
 *       if (line.startsWith('data: ')) handleEvent(JSON.parse(line.slice(6)));
 *
 * i.e. frames are delimited by "\n\n", only lines with the exact "data: "
 * prefix (colon + space) are parsed, one JSON event per data line, a
 * trailing partial frame stays buffered, and malformed JSON in a completed
 * frame throws (propagating to the caller like today).
 */
import { describe, it, expect } from 'vitest';
import { createSSEParser } from './sseParser';

describe('createSSEParser', () => {
  it('parses a single complete frame', () => {
    const p = createSSEParser();
    expect(p.push('data: {"type":"text-delta","text":"hi"}\n\n')).toEqual([
      { type: 'text-delta', text: 'hi' },
    ]);
  });

  it('buffers an incomplete frame and emits nothing until the delimiter arrives', () => {
    const p = createSSEParser();
    expect(p.push('data: {"type":"text-delta"')).toEqual([]);
    expect(p.push(',"text":"a"}')).toEqual([]);
    expect(p.push('\n\n')).toEqual([{ type: 'text-delta', text: 'a' }]);
  });

  it('emits multiple frames from a single chunk, in order', () => {
    const p = createSSEParser();
    expect(
      p.push('data: {"type":"tool-start","tool":"t"}\n\ndata: {"type":"tool-done","ok":true}\n\n')
    ).toEqual([
      { type: 'tool-start', tool: 't' },
      { type: 'tool-done', ok: true },
    ]);
  });

  it('handles the frame delimiter split across chunks', () => {
    const p = createSSEParser();
    expect(p.push('data: {"a":1}\n')).toEqual([]);
    expect(p.push('\n')).toEqual([{ a: 1 }]);
  });

  it('emits completed frames while keeping a trailing partial buffered', () => {
    const p = createSSEParser();
    expect(p.push('data: {"a":1}\n\ndata: {"b":2')).toEqual([{ a: 1 }]);
    expect(p.push('}\n\n')).toEqual([{ b: 2 }]);
  });

  it('emits one event per data line within a frame', () => {
    const p = createSSEParser();
    expect(p.push('data: {"a":1}\ndata: {"b":2}\n\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('ignores non-data lines (event names, comments, blank lines)', () => {
    const p = createSSEParser();
    expect(p.push('event: message\n: keep-alive\ndata: {"a":1}\n\n')).toEqual([{ a: 1 }]);
  });

  it('requires the exact "data: " prefix — "data:" without a space is ignored', () => {
    const p = createSSEParser();
    expect(p.push('data:{"a":1}\n\n')).toEqual([]);
  });

  it('emits nothing for a frame with no data lines', () => {
    const p = createSSEParser();
    expect(p.push('event: ping\n\n')).toEqual([]);
  });

  it('throws on malformed JSON in a completed frame (propagates like the original)', () => {
    const p = createSSEParser();
    expect(() => p.push('data: {nope\n\n')).toThrow();
  });

  it('parses a realistic assistant stream fed in arbitrary chunks', () => {
    const stream =
      'data: {"type":"text-delta","text":"Sure"}\n\n' +
      'data: {"type":"tool-start","tool":"update_rule"}\n\n' +
      'data: {"type":"tool-done","ok":true,"summary":"update_rule done"}\n\n' +
      'data: {"type":"done","changes":["rule updated"],"actionId":"a1"}\n\n';
    const p = createSSEParser();
    const events: unknown[] = [];
    // Feed in awkward 7-byte chunks to exercise every split point.
    for (let i = 0; i < stream.length; i += 7) {
      events.push(...p.push(stream.slice(i, i + 7)));
    }
    expect(events).toEqual([
      { type: 'text-delta', text: 'Sure' },
      { type: 'tool-start', tool: 'update_rule' },
      { type: 'tool-done', ok: true, summary: 'update_rule done' },
      { type: 'done', changes: ['rule updated'], actionId: 'a1' },
    ]);
  });
});
