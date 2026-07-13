'use client';

// Board sibling of the scheduling AssistantPanel (src/app/(scheduling)/schedules/[id]/AssistantPanel.tsx),
// same structural template: useSSEChat over the SSE route + ChatDrawer for the
// message list/composer, change chips + one-click undo, usage footer. Two
// deliberate differences from the scheduling panel:
//   - No image support: /api/board/assistant doesn't accept one, so buildBody
//     never forwards the image the drawer may have attached.
//   - The revert route can 409 with a structured `newerAction` blocker (undo
//     must run newest-first for board actions — see snapshot.ts's ordering
//     guard); that case is surfaced as a notice, not a hard error, since it's
//     actionable ("undo that turn first") rather than a failure.
import { useEffect, useState } from 'react';
import ChatDrawer from '@/components/chat/ChatDrawer';
import { useSSEChat, ChatMessage } from '@/components/chat/useSSEChat';
import { formatUsageFooter, parseUsage } from '@/components/chat/usageCost';

const ASSISTANT_ENDPOINT = '/api/board/assistant';

/** Shape of the stream's `done` payload (stored on the message as `extra`). */
interface ActionExtra {
  changes?: unknown;
  actionId?: unknown;
  reverted?: boolean;
  usage?: unknown;
}

/** The revert route's 409 ordering-guard body (see snapshot.ts's revertBoardAction). */
interface NewerActionBlocker {
  id?: unknown;
  summary?: unknown;
}

export default function BoardAssistantPanel({
  boardDate,
  hospital,
  today,
  onMutated,
  onClose,
}: {
  boardDate: string;
  hospital: string;
  today: string;
  onMutated: () => void;
  onClose: () => void;
}) {
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const isToday = boardDate === today;

  const chat = useSSEChat({
    endpoint: ASSISTANT_ENDPOINT,
    buildBody: ({ text, history }) => ({
      boardDate,
      hospital: hospital || null,
      messages: [...history, { role: 'user', content: text }],
    }),
    onDone: payload => {
      const changes = Array.isArray(payload.changes) ? payload.changes : [];
      if (changes.length > 0) onMutated();
    },
  });

  // Re-arm whenever the viewed date changes (including on open, since this
  // effect also runs on mount) — a user-dismissed notice for the SAME date
  // stays dismissed; navigating to a different non-today date re-shows it.
  useEffect(() => {
    if (!isToday) {
      chat.setNotice("Viewing a past/future date — the board won't live-update until reload.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardDate, today]);

  const undo = async (actionId: string, msgIndex: number) => {
    if (chat.busy || undoingId) return; // one in-flight mutation at a time
    chat.setError(null);
    chat.setNotice(null);
    setUndoingId(actionId);
    try {
      const res = await fetch(`/api/board/assistant/actions/${actionId}/revert`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));

      // Undo-ordering guard (409 + newerAction): the older turn can't be
      // reverted while a newer one for the same date is still un-reverted.
      // This is actionable, not a dead-end failure — surface it as a notice
      // (with the blocking turn's own summary) rather than the error banner,
      // and leave the chip un-reverted so the user can retry after undoing
      // the newer turn first.
      const blocker = body?.newerAction as NewerActionBlocker | undefined;
      if (res.status === 409 && blocker) {
        chat.setNotice(
          typeof body.error === 'string'
            ? body.error
            : `Undo blocked — undo "${typeof blocker.summary === 'string' ? blocker.summary : 'a newer change'}" first.`,
        );
        return;
      }

      if (!res.ok || body.ok === false) {
        throw new Error(typeof body.error === 'string' ? body.error : `Undo failed (${res.status})`);
      }
      chat.patchMessage(msgIndex, m => ({ extra: { ...(m.extra ?? {}), reverted: true } }));
      onMutated();
    } catch (e: unknown) {
      chat.setError(e instanceof Error ? e.message : 'Undo failed');
    } finally {
      setUndoingId(null);
    }
  };

  const renderExtras = (m: ChatMessage, i: number) => {
    const extra = m.extra as ActionExtra | undefined;
    if (!extra) return null;
    const changes = Array.isArray(extra.changes) ? (extra.changes as string[]) : [];
    const usage = parseUsage(extra.usage);
    if (changes.length === 0 && !usage) return null;
    const actionId = typeof extra.actionId === 'string' ? extra.actionId : null;
    const reverted = extra.reverted === true;
    const undoDisabled = chat.busy || undoingId !== null;
    return (
      <>
        {changes.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
            {changes.map((c, j) => (
              <span key={j} style={{
                fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                background: 'var(--ok-bg)', color: 'var(--ok)',
                border: '1px solid color-mix(in srgb, var(--ok) 35%, transparent)',
                textDecoration: reverted ? 'line-through' : 'none',
              }}>{c}</span>
            ))}
            {actionId && !reverted && (
              <button
                onClick={() => undo(actionId, i)}
                disabled={undoDisabled}
                style={{
                  fontSize: 10.5, fontWeight: 800, padding: '2px 9px', borderRadius: 999,
                  background: 'var(--danger-bg)',
                  color: undoDisabled ? 'var(--text-dim)' : 'var(--danger)',
                  border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)',
                  cursor: undoDisabled ? 'not-allowed' : 'pointer',
                }}
              >{undoingId === actionId ? 'Undoing…' : 'Undo'}</button>
            )}
            {reverted && (
              <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>reverted</span>
            )}
          </div>
        )}
        {usage && (
          <div
            title="Token usage for this exchange (whole tool loop) · cost estimated at Claude Opus 4.8 rates"
            style={{ marginTop: 6, fontSize: 10, color: 'var(--text-dim)' }}
          >
            {formatUsageFooter(usage)}
          </div>
        )}
      </>
    );
  };

  return (
    <ChatDrawer
      open
      onClose={onClose}
      chat={chat}
      voice
      title="Board Assistant ✨"
      subtitle="speak or type · every change undoable"
      placeholder={'e.g. "Farkas supervising OR 1 and 2, Nina in OR 3"'}
      emptyHint={
        <>
          Speak or type a roster/assignment command — e.g. &ldquo;Working today: Farkas, Nina,
          Simon — Farkas supervising OR 1 and 2, Nina in OR 3.&rdquo; Or ask for advice — e.g.
          &ldquo;Who should go home first?&rdquo; Every change is snapshotted and undoable.
        </>
      }
      locked={undoingId !== null}
      renderExtras={renderExtras}
    />
  );
}
