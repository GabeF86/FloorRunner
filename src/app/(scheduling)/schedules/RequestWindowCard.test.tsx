/**
 * Request-window card — view-state tests (2026-09-15).
 *
 * The card's fetch/effect path needs a DOM, which this suite does not have
 * (vitest runs environment:'node', no jsdom — see vitest.config.ts and the
 * note in BlockTargetsTab.test.tsx). So the one decision that matters is
 * pulled out as a pure selector and tested here: a FAILED read must never
 * render as "no open window", because that state also offers the
 * open-a-window form and hides a share link that may still be live.
 */
import { describe, it, expect } from 'vitest';
import { requestWindowView, type RequestWindow } from './RequestWindowCard';

const openWindow = (over: Partial<RequestWindow> = {}): RequestWindow => ({
  id: 'w1',
  site_id: 's1',
  block_start: '2026-10-05',
  block_end: '2026-12-13',
  max_no_call_requests: 3,
  max_call_requests: null,
  token: 'tok-123',
  status: 'open',
  opened_at: '2026-09-01T12:00:00Z',
  closed_at: null,
  ...over,
});

describe('requestWindowView', () => {
  it('reports loading first, even if a stale error is still held', () => {
    expect(requestWindowView(true, 'boom', [])).toEqual({ mode: 'loading' });
  });

  it('surfaces a read failure instead of an empty "no window" state', () => {
    expect(requestWindowView(false, 'Failed to load request windows (500)', []))
      .toEqual({ mode: 'error', message: 'Failed to load request windows (500)' });
  });

  it('does not let a read failure masquerade as "no open window"', () => {
    // The regression: a failed read used to produce [] and render the
    // open-a-window form, so the chief read intake as closed.
    expect(requestWindowView(false, 'NetworkError', []).mode).not.toBe('none');
  });

  it('prefers the error over any rows that survived a partial read', () => {
    expect(requestWindowView(false, 'NetworkError', [openWindow()]).mode).toBe('error');
  });

  it('returns the open window when the read succeeded', () => {
    const w = openWindow();
    expect(requestWindowView(false, null, [openWindow({ id: 'old', status: 'closed' }), w]))
      .toEqual({ mode: 'open', window: w });
  });

  it('returns none only for a successful read with no open window', () => {
    expect(requestWindowView(false, null, [openWindow({ status: 'closed' })]))
      .toEqual({ mode: 'none' });
    expect(requestWindowView(false, null, [])).toEqual({ mode: 'none' });
  });
});
