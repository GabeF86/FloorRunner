'use client';

// Thin wrapper over the generic chat layer for the Claude schedule assistant.
// The SSE protocol + drawer UI live in src/components/chat (useSSEChat +
// ChatDrawer); this file keeps only the schedule-specific parts: the
// endpoint + request body, undo/revert of assistant actions (change chips),
// onMutated wiring, and copy. page.tsx only mounts it and passes loadGrid
// as onMutated.
import { useState } from 'react';
import ChatDrawer from '@/components/chat/ChatDrawer';
import { useSSEChat, ChatMessage } from '@/components/chat/useSSEChat';

const ASSISTANT_ENDPOINT = '/api/scheduling/assistant';

/** Shape of the stream's `done` payload (stored on the message as `extra`). */
interface ActionExtra {
  changes?: unknown;
  actionId?: unknown;
  reverted?: boolean;
}

export default function AssistantPanel({
  scheduleId,
  onMutated,
  onClose,
}: {
  scheduleId: string;
  onMutated: () => void;
  onClose: () => void;
}) {
  const [undoingId, setUndoingId] = useState<string | null>(null);

  const chat = useSSEChat({
    endpoint: ASSISTANT_ENDPOINT,
    buildBody: ({ text, history, image }) => ({
      scheduleId,
      messages: [...history, { role: 'user', content: text }],
      ...(image ? { image: { media_type: image.media_type, data: image.data } } : {}),
    }),
    onDone: payload => {
      const changes = Array.isArray(payload.changes) ? payload.changes : [];
      if (changes.length > 0) onMutated();
    },
  });

  const undo = async (actionId: string, msgIndex: number) => {
    if (chat.busy || undoingId) return; // one in-flight mutation at a time
    chat.setError(null);
    chat.setNotice(null);
    setUndoingId(actionId);
    try {
      const res = await fetch(`/api/scheduling/assistant/actions/${actionId}/revert`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        const detail = body.error
          ?? (Array.isArray(body.errors) && body.errors.length > 0 ? body.errors.join('; ') : null);
        throw new Error(detail ?? `Undo failed (${res.status})`);
      }
      if (Array.isArray(body.validationErrors) && body.validationErrors.length > 0) {
        chat.setNotice(`Reverted, but re-validation was incomplete — some cells may show stale flags (${body.validationErrors.length} issue(s)).`);
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
    if (changes.length === 0) return null;
    const actionId = typeof extra.actionId === 'string' ? extra.actionId : null;
    const reverted = extra.reverted === true;
    const undoDisabled = chat.busy || undoingId !== null;
    return (
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
        {changes.map((c, j) => (
          <span key={j} style={{
            fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
            background: 'rgba(16,185,129,0.12)', color: '#34d399',
            border: '1px solid rgba(16,185,129,0.35)',
            textDecoration: reverted ? 'line-through' : 'none',
          }}>{c}</span>
        ))}
        {actionId && !reverted && (
          <button
            onClick={() => undo(actionId, i)}
            disabled={undoDisabled}
            style={{
              fontSize: 10.5, fontWeight: 800, padding: '2px 9px', borderRadius: 999,
              background: 'rgba(248,113,113,0.10)',
              color: undoDisabled ? 'var(--text-dim)' : '#f87171',
              border: '1px solid rgba(248,113,113,0.35)',
              cursor: undoDisabled ? 'not-allowed' : 'pointer',
            }}
          >{undoingId === actionId ? 'Undoing…' : 'Undo'}</button>
        )}
        {reverted && (
          <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>reverted</span>
        )}
      </div>
    );
  };

  return (
    <ChatDrawer
      open
      onClose={onClose}
      chat={chat}
      title="Assistant ✨"
      subtitle="structure edits · one-click undo"
      placeholder={'e.g. "Friday C1 should also take Sunday C2, then regenerate"'}
      emptyHint={
        <>
          Describe a change in plain language — restructure weekend call, add a shift type,
          tweak a rule, fix an assignment. You can paste a photo of a call-structure diagram.
          Every change is snapshotted and undoable.
        </>
      }
      locked={undoingId !== null}
      renderExtras={renderExtras}
    />
  );
}
