'use client';

// Generic right-side chat drawer, extracted verbatim from AssistantPanel.
// Renders the message list (streaming text, status/error/notice lines) and
// the composer (textarea, image attach/paste with mime allowlist + 5MB cap).
// All state lives in the SSEChat instance the caller creates with useSSEChat,
// so callers can also patch messages / set error and notice from their own
// flows (e.g. an undo action) while this drawer renders the results.
import { useEffect, useRef, useState } from 'react';
import type { ChatImage, ChatMessage, SSEChat } from './useSSEChat';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Mirrors the media types the Claude API accepts for base64 image blocks.
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const btnStyle: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 8,
  border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text-muted)', cursor: 'pointer',
};

export interface ChatDrawerProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  placeholder: string;
  /** Shown in the message list while the conversation is empty. */
  emptyHint?: React.ReactNode;
  /** The chat instance (from useSSEChat) this drawer renders and drives. */
  chat: SSEChat;
  /** Extra content rendered inside an assistant bubble (e.g. change chips + undo). */
  renderExtras?: (msg: ChatMessage, index: number) => React.ReactNode;
  /** While true, send is a no-op (e.g. an undo is in flight). */
  locked?: boolean;
  open: boolean;
  onClose: () => void;
}

export default function ChatDrawer({
  title,
  subtitle,
  placeholder,
  emptyHint,
  chat,
  renderExtras,
  locked = false,
  open,
  onClose,
}: ChatDrawerProps) {
  const { messages, busy, status, error, notice, setError, setNotice } = chat;
  const [input, setInput] = useState('');
  const [image, setImage] = useState<ChatImage | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, status]);

  if (!open) return null;

  const attachFile = (file: File) => {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setError('Only JPEG, PNG, GIF or WebP images can be attached.');
      return;
    }
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

  const handleSend = () => {
    if (locked) return; // one in-flight mutation at a time
    if (chat.send(input, image ?? undefined)) {
      setInput('');
      setImage(null);
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
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{title}</span>
        {subtitle && (
          <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{subtitle}</span>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title="Close" style={{
          background: 'none', border: 'none', color: 'var(--text-dim)',
          cursor: 'pointer', fontSize: 16, lineHeight: 1,
        }}>×</button>
      </div>

      {/* Message list */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && emptyHint && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            {emptyHint}
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
            {renderExtras?.(m, i)}
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

      {/* Warning line (e.g. incomplete re-validation after an undo) */}
      {notice && (
        <div style={{
          margin: '0 16px 8px', padding: '6px 10px', borderRadius: 8, fontSize: 11.5,
          background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.3)', color: '#b45309',
          display: 'flex', justifyContent: 'space-between', gap: 8,
        }}>
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} style={{
            background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 12,
          }}>×</button>
        </div>
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
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
          }}
          placeholder={busy ? 'Working…' : placeholder}
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
            onClick={handleSend}
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
