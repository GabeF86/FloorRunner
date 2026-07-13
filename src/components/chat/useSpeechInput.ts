'use client';
// Chrome/Edge SpeechRecognition wrapper. supported=false hides the mic
// entirely (Safari/Firefox); the drawer then behaves exactly as before.
import { useEffect, useRef, useState } from 'react';

// TS's `dom` lib ships SpeechRecognitionResult/ResultList/Alternative but not
// the SpeechRecognition interface, its event type, or the Window constructors
// (support varies by TS version and lib target). Minimal ambient additions —
// intentionally NOT redeclaring the Result types, which already exist.
declare global {
  interface SpeechRecognitionEvent extends Event {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultList;
  }
  interface SpeechRecognitionErrorEvent extends Event {
    readonly error: string; // 'not-allowed' | 'audio-capture' | 'no-speech' | 'network' | ...
  }
  interface SpeechRecognition extends EventTarget {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onend: (() => void) | null;
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
  }
  interface Window {
    SpeechRecognition?: { new (): SpeechRecognition };
    webkitSpeechRecognition?: { new (): SpeechRecognition };
  }
}

export interface SpeechInput {
  supported: boolean;
  listening: boolean;
  /** Live transcript (interim + final so far) while listening. */
  transcript: string;
  /** Last recognition error code ('not-allowed', 'audio-capture', …); cleared on start(). 'no-speech' is not reported (normal silence timeout). */
  error: string | null;
  start: () => void;
  stop: () => void;   // manual stop — final transcript still fires onFinal
  /** Hard cancel — discards the transcript; onFinal never fires. */
  abort: () => void;
}

export function useSpeechInput(onFinal: (text: string) => void): SpeechInput {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognition | null>(null);
  const finalRef = useRef('');
  // rec.abort() suppresses further results, but onend still fires — and
  // finalRef may already hold finalized text from earlier in the utterance.
  // This flag makes abort's discard deterministic regardless of engine timing.
  const discardRef = useRef(false);
  const Ctor = typeof window !== 'undefined'
    ? (window.SpeechRecognition ?? window.webkitSpeechRecognition)
    : undefined;

  useEffect(() => () => { discardRef.current = true; recRef.current?.abort(); }, []);
  if (!Ctor) {
    return { supported: false, listening: false, transcript: '', error: null, start: () => {}, stop: () => {}, abort: () => {} };
  }

  const start = () => {
    if (listening) return;
    const rec = new Ctor();
    rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
    finalRef.current = '';
    discardRef.current = false;
    setError(null);
    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      setTranscript(finalRef.current + interim);
    };
    rec.onend = () => {
      setListening(false);
      const text = finalRef.current.trim();
      setTranscript('');
      if (discardRef.current) { discardRef.current = false; return; }
      if (text) onFinal(text);
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      // 'no-speech' is Chrome's normal silence timeout, not a fault — end
      // quietly. Everything else (not-allowed, audio-capture, network, …)
      // surfaces so the UI can tell the user WHY the mic stopped.
      if (e.error && e.error !== 'no-speech') setError(e.error);
      discardRef.current = true; // never auto-send a partial transcript after an error
      setListening(false); setTranscript('');
    };
    recRef.current = rec; setListening(true); rec.start();
  };
  const stop = () => recRef.current?.stop();
  const abort = () => {
    if (!recRef.current) return;
    discardRef.current = true;
    recRef.current.abort();
    // Clear UI state immediately — engines may delay onend after abort.
    setListening(false);
    setTranscript('');
  };
  return { supported: true, listening, transcript, error, start, stop, abort };
}
