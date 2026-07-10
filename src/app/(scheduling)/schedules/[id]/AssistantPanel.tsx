'use client';

// Self-contained right-side drawer for the Claude schedule assistant.
// Consumes the SSE stream from POST /api/scheduling/assistant via fetch +
// ReadableStream reader (EventSource can't POST). Everything lives here —
// page.tsx only mounts it and passes loadGrid as onMutated.
import { useEffect, useRef, useState } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  imageName?: string;
  changes?: string[];
  actionId?: string | null;
  reverted?: boolean;
}

interface PendingImage { media_type: string; data: string; name: string }

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const btnStyle: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 8,
  border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text-muted)', cursor: 'pointer',
};

export default function AssistantPanel({
  scheduleId,
  onMutated,
  onClose,
}: {
  scheduleId: string;
  onMutated: () => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [image, setImage] = useState<PendingImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, status]);

  const attachFile = (file: File) => {
    if (!file.type.startsWith('image/')) { setError('Only image files can be attached.'); return; }
    if (file.size > MAX_IMAGE_BYTES) { setError('Image too large — 5MB max.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const base64 = url.slice(url.indexOf(',') + 1);
      setImage({ media_type: file.type, data: base64, name: file.name || 'pasted image' });
    };
    reader.readAsDataURL(file);
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) { e.preventDefault(); attachFile(file); }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    setBusy(true);
    setInput('');

    const history = messages
      .filter(m => m.text.trim().length > 0)
      .map(m => ({ role: m.role, content: m.text }));
    const outgoingImage = image ?? undefined;
    setImage(null);

    setMessages(prev => [
      ...prev,
      { role: 'user', text, imageName: outgoingImage?.name },
      { role: 'assistant', text: '' },
    ]);

    const patchAssistant = (patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) => {
      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') {
          next[next.length - 1] = { ...last, ...(typeof patch === 'function' ? patch(last) : patch) };
        }
        return next;
      });
    };

    try {
      const res = await fetch('/api/scheduling/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduleId,
          messages: [...history, { role: 'user', content: text }],
          ...(outgoingImage ? { image: { media_type: outgoingImage.media_type, data: outgoingImage.data } } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        let msg = `Assistant request failed (${res.status})`;
        try { msg = (await res.json()).error ?? msg; } catch { /* keep default */ }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawDone = false;

      const handleEvent = (ev: Record<string, unknown>) => {
        switch (ev.type) {
          case 'text-delta':
            patchAssistant(m => ({ text: m.text + String(ev.text ?? '') }));
            break;
          case 'tool-start':
            setStatus(`Running ${String(ev.tool)}…`);
            break;
          case 'tool-done':
            setStatus(ev.ok
              ? String(ev.summary ?? `${String(ev.tool)} done`)
              : `${String(ev.tool)} failed — retrying`);
            break;
          case 'done': {
            sawDone = true;
            const changes = Array.isArray(ev.changes) ? (ev.changes as string[]) : [];
            patchAssistant({ changes, actionId: (ev.actionId as string | null) ?? null });
            if (changes.length > 0) onMutated();
            break;
          }
          case 'error':
            throw new Error(String(ev.message ?? 'Assistant error'));
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (line.startsWith('data: ')) handleEvent(JSON.parse(line.slice(6)));
          }
        }
      }
      if (!sawDone) {
        patchAssistant(m => ({ text: m.text || '[Connection ended before the assistant finished.]' }));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Assistant request failed';
      setError(msg);
      patchAssistant(m => ({ text: m.text || `⚠ ${msg}` }));
    } finally {
      setStatus(null);
      setBusy(false);
    }
  };

  const undo = async (actionId: string, msgIndex: number) => {
    setError(null);
    try {
      const res = await fetch(`/api/scheduling/assistant/actions/${actionId}/revert`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        throw new Error(body.error ?? (body.errors ?? []).join('; ') ?? `Undo failed (${res.status})`);
      }
      setMessages(prev => prev.map((m, i) => (i === msgIndex ? { ...m, reverted: true } : m)));
      onMutated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Undo failed');
    }
  };

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 400, zIndex: 550,
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-surface)', borderLeft: '1px solid var(--border)',
      boxShadow: '-12px 0 32px rgba(15,23,42,0.25)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>Assistant ✨</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
          structure edits · one-click undo
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title="Close" style={{
          background: 'none', border: 'none', color: 'var(--text-dim)',
          cursor: 'pointer', fontSize: 16, lineHeight: 1,
        }}>×</button>
      </div>

      {/* Message list */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            Describe a change in plain language — restructure weekend call, add a shift type,
            tweak a rule, fix an assignment. You can paste a photo of a call-structure diagram.
            Every change is snapshotted and undoable.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '92%',
            padding: '8px 11px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.55,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: m.role === 'user' ? 'rgba(56,189,248,0.14)' : 'var(--bg-deep)',
            border: '1px solid var(--border)', color: 'var(--text)',
          }}>
            {m.imageName && (
              <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginBottom: 4 }}>🖼 {m.imageName}</div>
            )}
            {m.text || (busy && i === messages.length - 1 ? '…' : '')}
            {m.changes && m.changes.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                {m.changes.map((c, j) => (
                  <span key={j} style={{
                    fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: 'rgba(16,185,129,0.12)', color: '#34d399',
                    border: '1px solid rgba(16,185,129,0.35)',
                    textDecoration: m.reverted ? 'line-through' : 'none',
                  }}>{c}</span>
                ))}
                {m.actionId && !m.reverted && (
                  <button onClick={() => undo(m.actionId!, i)} style={{
                    fontSize: 10.5, fontWeight: 800, padding: '2px 9px', borderRadius: 999,
                    background: 'rgba(248,113,113,0.10)', color: '#f87171',
                    border: '1px solid rgba(248,113,113,0.35)', cursor: 'pointer',
                  }}>Undo</button>
                )}
                {m.reverted && (
                  <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>reverted</span>
                )}
              </div>
            )}
          </div>
        ))}
        {status && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>⚙ {status}</div>
        )}
      </div>

      {/* Error line */}
      {error && (
        <div style={{
          margin: '0 16px 8px', padding: '6px 10px', borderRadius: 8, fontSize: 11.5,
          background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171',
        }}>{error}</div>
      )}

      {/* Composer */}
      <div style={{ padding: '10px 16px 14px', borderTop: '1px solid var(--border)' }}>
        {image && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 11, color: 'var(--text-muted)' }}>
            <span>🖼 {image.name}</span>
            <button onClick={() => setImage(null)} style={{
              background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 12,
            }}>×</button>
          </div>
        )}
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder={busy ? 'Working…' : 'e.g. "Friday C1 should also take Sunday C2, then regenerate"'}
          rows={3}
          disabled={busy}
          style={{
            width: '100%', resize: 'none', padding: '8px 10px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg-deep)',
            color: 'var(--text)', fontSize: 12.5, lineHeight: 1.5, boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) attachFile(f); e.target.value = ''; }}
          />
          <button onClick={() => fileRef.current?.click()} disabled={busy} style={btnStyle} title="Attach an image (or paste one)">
            🖼 Image
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={send}
            disabled={busy || input.trim().length === 0}
            style={{
              ...btnStyle,
              background: busy || input.trim().length === 0 ? 'var(--bg-deep)' : 'rgba(99,102,241,0.16)',
              color: busy || input.trim().length === 0 ? 'var(--text-dim)' : '#a5b4fc',
              border: '1px solid rgba(99,102,241,0.35)',
              cursor: busy || input.trim().length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Working…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
