'use client';

// Generic SSE chat hook, extracted verbatim from AssistantPanel's
// fetch/reader/state logic. Consumes a fetch-POST SSE stream (EventSource
// can't POST) via ReadableStream reader + createSSEParser. Knows the event
// protocol (text-delta / tool-start / tool-done / done / error) but nothing
// about any particular backend: the caller supplies the endpoint and builds
// the request body, and receives the raw `done` payload via onDone.
import { useState } from 'react';
import { createSSEParser, SSEEvent } from './sseParser';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  imageName?: string;
  /** Raw payload of the stream's `done` event (plus any caller patches, e.g. a reverted flag). */
  extra?: Record<string, unknown>;
}

export interface ChatImage { media_type: string; data: string; name: string }

export interface UseSSEChatOptions {
  endpoint: string;
  /** Builds the POST body from the outgoing text, prior turns, and optional image. */
  buildBody: (args: {
    text: string;
    history: { role: 'user' | 'assistant'; content: string }[];
    image?: ChatImage;
  }) => unknown;
  /** Observes every parsed stream event (before internal handling). */
  onEvent?: (ev: SSEEvent) => void;
  /** Receives the raw `done` event payload. */
  onDone?: (payload: SSEEvent) => void;
}

export interface SSEChat {
  messages: ChatMessage[];
  /**
   * Starts a send. Returns false (no-op) when the text is blank or a send is
   * already in flight — so the caller knows whether to clear its composer.
   */
  send: (text: string, image?: ChatImage) => boolean;
  busy: boolean;
  status: string | null;
  error: string | null;
  notice: string | null;
  /** Patch a message by index (e.g. to mark an action reverted). */
  patchMessage: (
    index: number,
    patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>),
  ) => void;
  setError: (e: string | null) => void;
  setNotice: (n: string | null) => void;
}

export function useSSEChat({ endpoint, buildBody, onEvent, onDone }: UseSSEChatOptions): SSEChat {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const patchMessage = (
    index: number,
    patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>),
  ) => {
    setMessages(prev => {
      const target = prev[index];
      if (!target) return prev;
      const next = [...prev];
      next[index] = { ...target, ...(typeof patch === 'function' ? patch(target) : patch) };
      return next;
    });
  };

  const run = async (text: string, image?: ChatImage) => {
    const history = messages
      .filter(m => m.text.trim().length > 0)
      .map(m => ({ role: m.role, content: m.text }));

    setMessages(prev => [
      ...prev,
      { role: 'user', text, imageName: image?.name },
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
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody({ text, history, image })),
      });

      if (!res.ok || !res.body) {
        let msg = `Assistant request failed (${res.status})`;
        try { msg = (await res.json()).error ?? msg; } catch { /* keep default */ }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSSEParser();
      let sawDone = false;

      const handleEvent = (ev: SSEEvent) => {
        onEvent?.(ev);
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
          case 'done':
            sawDone = true;
            patchAssistant({ extra: ev });
            onDone?.(ev);
            break;
          case 'error':
            throw new Error(String(ev.message ?? 'Assistant error'));
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) handleEvent(ev);
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

  const send = (rawText: string, image?: ChatImage): boolean => {
    const text = rawText.trim();
    if (!text || busy) return false;
    setError(null);
    setBusy(true);
    void run(text, image);
    return true;
  };

  return { messages, send, busy, status, error, notice, patchMessage, setError, setNotice };
}
