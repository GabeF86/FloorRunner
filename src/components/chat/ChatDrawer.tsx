'use client';

// Generic right-side chat drawer, extracted verbatim from AssistantPanel.
// Renders the message list (streaming text, status/error/notice lines) and
// the composer (textarea, image attach/paste with mime allowlist + 5MB cap).
// All state lives in the SSEChat instance the caller creates with useSSEChat,
// so callers can also patch messages / set error and notice from their own
// flows (e.g. an undo action) while this drawer renders the results.
import { useEffect, useRef, useState } from 'react';
import type { ChatImage, ChatMessage, SSEChat } from './useSSEChat';
import { useSpeechInput } from './useSpeechInput';

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
  /** Show a mic button (hidden automatically when SpeechRecognition is unsupported). */
  voice?: boolean;
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
  voice = false,
  open,
  onClose,
}: ChatDrawerProps) {
  const { messages, busy, status, error, notice, setError, setNotice } = chat;
  const [input, setInput] = useState('');
  const [image, setImage] = useState<ChatImage | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Set (via textarea onFocus) when the user starts editing while the mic is
  // still listening — the escape hatch from auto-send: the eventual final
  // transcript then lands in the input box instead of being sent.
  const editIntentRef = useRef(false);
  const speech = useSpeechInput((text) => {
    if (editIntentRef.current) {
      editIntentRef.current = false;
      setInput(text);
    } else {
      chat.send(text);
    }
  });

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
      <style>{`
        @keyframes chatMicPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.65; transform: scale(1.06); }
        }
      `}</style>

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
            background: m.role === 'user' ? 'color-mix(in srgb, var(--blue) 14%, transparent)' : 'var(--bg-deep)',
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
          background: 'var(--danger-bg)', border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)', color: 'var(--danger)',
        }}>{error}</div>
      )}

      {/* Warning line (e.g. incomplete re-validation after an undo) */}
      {notice && (
        <div style={{
          margin: '0 16px 8px', padding: '6px 10px', borderRadius: 8, fontSize: 11.5,
          background: 'var(--warn-bg)', border: '1px solid color-mix(in srgb, var(--warn) 30%, transparent)', color: 'var(--warn)',
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
          value={speech.listening ? speech.transcript : input}
          onChange={e => setInput(e.target.value)}
          onFocus={() => { if (speech.listening) editIntentRef.current = true; }}
          onPaste={handlePaste}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
          }}
          placeholder={busy ? 'Working…' : speech.listening ? 'Listening…' : placeholder}
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
          {voice && speech.supported && (
            <button
              onClick={() => (speech.listening ? speech.stop() : speech.start())}
              disabled={busy || locked}
              title={speech.listening ? 'Stop listening' : 'Speak your message'}
              style={{
                ...btnStyle,
                animation: speech.listening ? 'chatMicPulse 1.1s ease-in-out infinite' : undefined,
                background: speech.listening ? 'color-mix(in srgb, var(--danger) 16%, transparent)' : btnStyle.background,
                color: speech.listening ? 'var(--danger)' : btnStyle.color,
                border: speech.listening ? '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' : btnStyle.border,
                cursor: busy || locked ? 'not-allowed' : 'pointer',
              }}
            >
              🎤{speech.listening ? ' Listening…' : ''}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={handleSend}
            disabled={busy || input.trim().length === 0}
            style={{
              ...btnStyle,
              background: busy || input.trim().length === 0 ? 'var(--bg-deep)' : 'color-mix(in srgb, var(--indigo) 16%, transparent)',
              color: busy || input.trim().length === 0 ? 'var(--text-dim)' : 'var(--indigo)',
              border: '1px solid color-mix(in srgb, var(--indigo) 35%, transparent)',
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
