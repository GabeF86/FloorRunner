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

// Module const so the clear-on-return-to-today effect can recognize (and only
// ever clear) ITS OWN notice by identity — never an unrelated one (e.g. the
// undo 409 ordering-guard message).
const NON_TODAY_NOTICE = "Viewing a non-today date — the board won't live-update until reload.";

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

  // The notice slot has multiple writers; the policy is single-slot with
  // NON_TODAY_NOTICE as the AMBIENT DEFAULT and specific notices (e.g. the
  // undo 409 blocker) WINNING the slot:
  //   - On a date change to non-today, ambient is asserted only when the slot
  //     is free (null) or already ambient — a more specific notice (an
  //     unresolved 409 blocker) survives stepping between non-today dates.
  //     Acceptable consequence: once that specific notice is dismissed (or a
  //     date change lands while the slot is null), ambient re-asserts on the
  //     NEXT date change.
  //   - On returning to today, only ambient is cleared (identity check) — a
  //     specific notice is never clobbered.
  //   - undo() clears only non-ambient notices at its start (below), and its
  //     409 path may deliberately REPLACE ambient with the more specific
  //     blocker message.
  //
  // Deps are deliberately [boardDate, today] WITHOUT chat.notice: this effect
  // must fire only on date transitions. Including chat.notice would re-fire it
  // when the user dismisses the banner (notice → null) and immediately re-set
  // it on a non-today date, making the × button a no-op. Reading chat.notice
  // inside is still current, not stale: the effect runs after the render in
  // which the date changed, and chat is rebuilt each render around the latest
  // notice state.
  useEffect(() => {
    if (!isToday) {
      if (chat.notice === null || chat.notice === NON_TODAY_NOTICE) {
        chat.setNotice(NON_TODAY_NOTICE);
      }
    } else if (chat.notice === NON_TODAY_NOTICE) {
      chat.setNotice(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardDate, today]);

  const undo = async (actionId: string, msgIndex: number) => {
    if (chat.busy || undoingId) return; // one in-flight mutation at a time
    chat.setError(null);
    // Clear only a stale SPECIFIC notice (e.g. a previous 409 blocker) — the
    // ambient non-today banner must survive ordinary undos, since nothing
    // re-asserts it until the next date change (single-slot policy above).
    if (chat.notice !== NON_TODAY_NOTICE) chat.setNotice(null);
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
