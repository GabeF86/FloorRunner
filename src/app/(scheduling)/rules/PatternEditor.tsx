'use client';

// Change the call structure by describing it.
//
// The flow is deliberately two-step and the steps are on separate routes:
// asking what a change would do must never be the same act as doing it. What
// you approve is the English diff — the same sentences the page above prints —
// not a JSON patch, because a chief can check "Saturday C1 also takes C2 on
// Sunday" against how the group actually runs and cannot check a JSON patch
// against anything.
//
// Nothing here writes a document. The server re-applies the same named edits
// to the pattern that is actually in force and re-validates the result.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, Button, Banner } from '@/components/ui';

export interface PatternEditorProps {
  siteId: string;
  siteName: string;
  /** JSON of the doc the page rendered, so apply can detect a mid-air change. */
  baselineFingerprint: string;
  /** False when no model key is configured on this deployment. */
  available: boolean;
  /** The most recently archived pattern, if there is one to go back to. */
  previous: { id: string; name: string | null; createdAt: string } | null;
}

interface Preview {
  edits: unknown[];
  added: string[];
  removed: string[];
  usingClassicBaseline: boolean;
  publishedCount: number;
}

export default function PatternEditor(p: PatternEditorProps) {
  const router = useRouter();
  const [request, setRequest] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [revert, setRevert] = useState<{ added: string[]; removed: string[] } | null>(null);

  async function previewRevert() {
    if (!p.previous) return;
    reset();
    setBusy('preview');
    try {
      const res = await fetch('/api/scheduling/call-patterns/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: p.siteId, pattern_id: p.previous.id, dry_run: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? `Could not read the previous pattern (${res.status}).`); return; }
      if (body?.identical) { setNote('The previous pattern behaves identically to the current one.'); return; }
      setRevert({ added: body.added ?? [], removed: body.removed ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server.');
    } finally { setBusy(null); }
  }

  async function doRevert() {
    if (!p.previous) return;
    setBusy('apply');
    setError(null);
    try {
      const res = await fetch('/api/scheduling/call-patterns/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: p.siteId, pattern_id: p.previous.id }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? `Could not revert (${res.status}).`); return; }
      setRevert(null);
      setDone('Reverted. The pattern you replaced is itself kept, so this can be undone again.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server.');
    } finally { setBusy(null); }
  }

  if (!p.available) {
    return (
      <Card title="Change the call structure">
        <Banner tone="info">
          Describing changes in plain English needs a language-model key configured on this
          deployment (<code>ANTHROPIC_API_KEY</code>). Everything else on this page works
          without one — the structure shown above is read directly from the database.
        </Banner>
      </Card>
    );
  }

  const reset = () => {
    setPreview(null); setNote(null); setError(null); setDone(null); setRevert(null);
  };

  async function propose() {
    reset();
    setBusy('preview');
    try {
      const res = await fetch('/api/scheduling/call-patterns/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: p.siteId, request }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? `Request failed (${res.status}).`); return; }
      // "Understood, but no" is not an error — it is an answer, and styling it
      // as a failure would send someone to retry a request that was fine.
      if (body?.unsupported) { setNote(body.unsupported); return; }
      setPreview(body as Preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy('apply');
    setError(null);
    try {
      const res = await fetch('/api/scheduling/call-patterns/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site_id: p.siteId,
          edits: preview.edits,
          baseline_fingerprint: p.baselineFingerprint,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? `Could not apply (${res.status}).`); return; }
      setPreview(null);
      setRequest('');
      setDone('Applied. The previous pattern is kept, so this can be reverted.');
      // Re-render the server component so the description above reflects the
      // change that was just made, rather than the one it was built with.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Change the call structure">
      <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 'var(--space-3)' }}>
        Describe the change in your own words. Nothing is saved until you have read what it
        would do.
      </p>

      <textarea
        className="fr-field"
        value={request}
        onChange={e => { setRequest(e.target.value); if (preview) reset(); }}
        placeholder={`e.g. Saturday C1 should also take C2 on Sunday\ne.g. Friday C1 covers neuro on Saturday and Sunday too`}
        rows={3}
        disabled={busy !== null}
        style={{
          width: '100%', padding: 'var(--space-3)', borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-input)', background: 'var(--bg-surface)',
          color: 'var(--text)', fontSize: 'var(--fs-sm)', lineHeight: 1.5,
          fontFamily: 'inherit', resize: 'vertical',
        }}
      />

      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Button onClick={propose} disabled={busy !== null || request.trim().length === 0}>
          {busy === 'preview' ? 'Working…' : 'Show me what this would do'}
        </Button>
        {(preview || note || error || done) && (
          <Button variant="ghost" onClick={reset} disabled={busy !== null}>Clear</Button>
        )}
      </div>

      {error && <div style={{ marginTop: 'var(--space-3)' }}><Banner tone="error">{error}</Banner></div>}
      {note && <div style={{ marginTop: 'var(--space-3)' }}><Banner tone="info">{note}</Banner></div>}
      {done && <div style={{ marginTop: 'var(--space-3)' }}><Banner tone="success">{done}</Banner></div>}

      {preview && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div style={{
            fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
            color: 'var(--text-dim)', fontWeight: 700, marginBottom: 'var(--space-2)',
          }}>
            What would change
          </div>

          <div style={{
            border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
          }}>
            {preview.removed.map((t, i) => (
              <DiffLine key={`r${i}`} sign="−" tone="removed" text={t} />
            ))}
            {preview.added.map((t, i) => (
              <DiffLine key={`a${i}`} sign="+" tone="added" text={t} />
            ))}
          </div>

          {/* The thing nobody would guess: a pattern change is not retroactive.
              Without saying so, "Friday C1 now covers neuro" reads as though
              the live schedule was just rewritten. */}
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Banner tone="info">
              This changes how {p.siteName} is scheduled from the next generation onward.
              {preview.publishedCount > 0 && ` The ${preview.publishedCount} published `
                + `schedule${preview.publishedCount === 1 ? '' : 's'} already built for this site `
                + 'will not change.'}
            </Banner>
          </div>

          {preview.usingClassicBaseline && (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Banner tone="warn">
                This site has no stored pattern and is running the built-in classic structure.
                Saving will turn that implicit default into an explicit pattern for this site.
              </Banner>
            </div>
          )}

          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
            <Button onClick={apply} disabled={busy !== null}>
              {busy === 'apply' ? 'Applying…' : 'Apply this change'}
            </Button>
            <Button variant="secondary" onClick={reset} disabled={busy !== null}>
              Discard
            </Button>
          </div>
        </div>
      )}
      {revert && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div style={{
            fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: 1,
            color: 'var(--text-dim)', fontWeight: 700, marginBottom: 'var(--space-2)',
          }}>
            Going back would change
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            {revert.removed.map((t, i) => <DiffLine key={`rr${i}`} sign="−" tone="removed" text={t} />)}
            {revert.added.map((t, i) => <DiffLine key={`ra${i}`} sign="+" tone="added" text={t} />)}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
            <Button onClick={doRevert} disabled={busy !== null}>
              {busy === 'apply' ? 'Reverting…' : 'Go back to this'}
            </Button>
            <Button variant="secondary" onClick={reset} disabled={busy !== null}>Keep the current pattern</Button>
          </div>
        </div>
      )}

      {p.previous && !preview && !revert && (
        <div style={{
          marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)',
          borderTop: '1px solid var(--border-faint)',
          display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
            Previous pattern saved {new Date(p.previous.createdAt).toLocaleDateString()}
          </span>
          {/* Previewed rather than applied on click. "Undo" sounds safe enough
              to press without reading, which is exactly why going back shows
              its consequences first — reverting a week-old pattern can discard
              several changes made since. */}
          <Button variant="ghost" size="sm" onClick={previewRevert} disabled={busy !== null}>
            Show what going back would do
          </Button>
        </div>
      )}
    </Card>
  );
}

function DiffLine({ sign, tone, text }: { sign: string; tone: 'added' | 'removed'; text: string }) {
  const added = tone === 'added';
  return (
    <div style={{
      display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline',
      padding: '7px var(--space-3)',
      background: added ? 'var(--ok-bg)' : 'var(--danger-bg)',
      borderLeft: `3px solid ${added ? 'var(--ok)' : 'var(--danger)'}`,
    }}>
      <span aria-hidden="true" style={{
        fontFamily: 'var(--font-mono), ui-monospace, monospace', fontWeight: 800,
        color: added ? 'var(--ok)' : 'var(--danger)', flexShrink: 0,
      }}>
        {sign}
      </span>
      <span style={{
        fontSize: 'var(--fs-sm)', lineHeight: 1.5,
        color: 'var(--text)',
        // Struck through rather than only coloured: the sign and the colour
        // both fail for a colour-blind reader in a hurry, and "what is going
        // away" is the half people misread.
        textDecoration: added ? 'none' : 'line-through',
        textDecorationColor: 'var(--danger)',
      }}>
        {text}
      </span>
    </div>
  );
}
