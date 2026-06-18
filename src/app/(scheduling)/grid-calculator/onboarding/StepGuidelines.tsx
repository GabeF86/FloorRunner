'use client';

// Step 4 — Free-text guidelines + Claude parse preview.
// Owned by agent A15 (Onboarding Wizard).
// PRD: docs/PRD-Grid-Calculator.md §9, §14 (A15), §16 acceptance criterion 1.
//
// Flow:
//   1. User types department staffing guidelines in plain English.
//   2. (Optional) Expand the "see Paoli example" disclosure to crib the shape.
//   3. Click "Parse with Claude" — POSTs to /api/grid-calculator/normalize-rules
//      with { rawText, sites }.
//   4. On 200 we render the parsed CoverageRuleSet side-by-side with the raw
//      text. User can tweak text and re-parse as many times as they want.
//   5. Any unmapped sentences from the response are shown verbatim with an
//      acknowledge button — surfaces ambiguity for human clarification (PRD §9).
//
// On API error (500 — missing API key, 502 — LLM unparseable, etc.) we surface
// the message inline and keep the previous parse result so the user does not
// lose progress.

import { useState } from 'react';
import type { Dispatch } from 'react';

import type {
  CoverageRuleSet,
  GridSite,
  SiteRule,
} from '@/lib/gridCalculator/types';

import {
  PAOLI_EXAMPLE_GUIDELINES,
  type ParsedRulesState,
  type WizardAction,
} from './wizardState';

const CYAN = '#0ea5e9';
const AMBER = '#f59e0b';
const SLATE = '#64748b';

export interface StepGuidelinesProps {
  guidelines: string;
  parsedRules: ParsedRulesState;
  unmappedAcknowledged: boolean;
  sites: GridSite[];
  dispatch: Dispatch<WizardAction>;
}

export default function StepGuidelines({
  guidelines,
  parsedRules,
  unmappedAcknowledged,
  sites,
  dispatch,
}: StepGuidelinesProps) {
  const [parsing, setParsing] = useState(false);
  const [exampleOpen, setExampleOpen] = useState(false);

  async function parseNow() {
    if (parsing) return;
    setParsing(true);
    try {
      const res = await fetch('/api/grid-calculator/normalize-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: guidelines, sites }),
      });
      if (!res.ok) {
        const body = await safeJson(res);
        const message =
          typeof body?.error === 'string'
            ? body.error
            : `Parse failed (HTTP ${res.status}).`;
        dispatch({
          type: 'setParsedRules',
          rules: parsedRules.rules,
          cacheHit: parsedRules.cacheHit,
          modelId: parsedRules.modelId,
          unmapped: parsedRules.unmapped,
          error: message,
        });
        return;
      }
      const body = (await res.json()) as {
        rules?: CoverageRuleSet;
        unmapped?: string[];
        promptCacheHit?: boolean;
        modelId?: string;
      };
      dispatch({
        type: 'setParsedRules',
        rules: body.rules ?? { siteRules: [], globalRules: [] },
        cacheHit: typeof body.promptCacheHit === 'boolean' ? body.promptCacheHit : null,
        modelId: typeof body.modelId === 'string' ? body.modelId : null,
        unmapped: Array.isArray(body.unmapped) ? body.unmapped : [],
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown parse error.';
      dispatch({
        type: 'setParsedRules',
        rules: parsedRules.rules,
        cacheHit: parsedRules.cacheHit,
        modelId: parsedRules.modelId,
        unmapped: parsedRules.unmapped,
        error: message,
      });
    } finally {
      setParsing(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Panel>
        <Header
          title="Department guidelines"
          subtitle="Paste or type how your group staffs each site. Claude turns the text into a structured rule set the solver consumes. You can re-parse as many times as you like."
        />

        <textarea
          value={guidelines}
          onChange={(e) =>
            dispatch({ type: 'setGuidelines', text: e.target.value })
          }
          placeholder="e.g. Endo is usually solo coverage by an Anesthesiologist. OB is staffed by a solo Anesthesiologist and helps with breaks when not busy. EP and Neuro labs are CRNAs supervised cross-site by a Main OR Anesthesiologist. We never supervise more than 1:3 at OB."
          rows={12}
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 13,
            lineHeight: 1.6,
            fontFamily: 'inherit',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--bg-base)',
            color: 'var(--text)',
            outline: 'none',
            resize: 'vertical',
            minHeight: 180,
          }}
        />

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={() => setExampleOpen((v) => !v)}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 11,
              color: SLATE,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 600,
            }}
            aria-expanded={exampleOpen}
          >
            {exampleOpen ? '▾' : '▸'} see Paoli example
          </button>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            {parsedRules.parsedAt !== null && (
              <span
                style={{
                  fontSize: 10,
                  color: SLATE,
                  fontFamily: 'var(--font-mono), ui-monospace, monospace',
                }}
              >
                last parsed {formatRelativeTime(parsedRules.parsedAt)}
                {parsedRules.cacheHit !== null && (
                  <>
                    {' · '}
                    cache {parsedRules.cacheHit ? 'hit' : 'miss'}
                  </>
                )}
                {parsedRules.modelId && (
                  <>
                    {' · '}
                    {parsedRules.modelId}
                  </>
                )}
              </span>
            )}
            <button
              type="button"
              onClick={parseNow}
              disabled={parsing || guidelines.trim().length === 0}
              style={primaryButtonStyle(parsing || guidelines.trim().length === 0)}
            >
              {parsing
                ? 'Parsing…'
                : parsedRules.rules
                ? 'Re-parse with Claude'
                : 'Parse with Claude'}
            </button>
          </div>
        </div>

        {exampleOpen && (
          <PaoliExample
            example={PAOLI_EXAMPLE_GUIDELINES}
            onUse={() => {
              dispatch({ type: 'setGuidelines', text: PAOLI_EXAMPLE_GUIDELINES });
              setExampleOpen(false);
            }}
          />
        )}

        {parsedRules.error && (
          <ErrorBanner message={parsedRules.error} />
        )}
      </Panel>

      {/* Parsed rules preview ─────────────────────────────────────────── */}
      <Panel>
        <Header
          title="What Claude understood"
          subtitle="Side-by-side preview of the normalized rules. Edit the text above and re-parse if something looks off."
        />
        {!parsedRules.rules ? (
          <EmptyState>
            Hit{' '}
            <strong style={{ color: 'var(--text-strong)' }}>Parse with Claude</strong>{' '}
            after writing your guidelines to see the structured rules here.
          </EmptyState>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 12,
            }}
          >
            <SiteRulesList rules={parsedRules.rules} sites={sites} />
            <GlobalRulesList rules={parsedRules.rules} />
          </div>
        )}

        {parsedRules.unmapped.length > 0 && !unmappedAcknowledged && (
          <UnmappedBanner
            sentences={parsedRules.unmapped}
            onAcknowledge={() => dispatch({ type: 'acknowledgeUnmapped' })}
          />
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paoli example disclosure.
// ---------------------------------------------------------------------------

function PaoliExample({
  example,
  onUse,
}: {
  example: string;
  onUse: () => void;
}) {
  return (
    <div
      style={{
        background: 'rgba(245,158,11,0.06)',
        border: '1px solid rgba(245,158,11,0.3)',
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: AMBER,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}
      >
        Paoli example guidelines (read-only)
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--text)' }}>
        {example}
      </p>
      <button
        type="button"
        onClick={onUse}
        style={{
          alignSelf: 'flex-start',
          background: 'transparent',
          border: `1px solid ${AMBER}55`,
          color: AMBER,
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 11,
          cursor: 'pointer',
          fontWeight: 700,
          fontFamily: 'inherit',
        }}
      >
        Use this example as my starting point
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Site rules list.
// ---------------------------------------------------------------------------

function SiteRulesList({ rules, sites }: { rules: CoverageRuleSet; sites: GridSite[] }) {
  if (rules.siteRules.length === 0) {
    return (
      <Card title="Site rules">
        <EmptyState>No site-specific rules parsed yet.</EmptyState>
      </Card>
    );
  }

  // Build a name -> site lookup for color/icon resolution. Falls back to a
  // neutral chip when the rule references a site the user did not declare.
  const lookup = new Map<string, GridSite>();
  for (const s of sites) lookup.set(s.name.toLowerCase(), s);

  return (
    <Card title={`Site rules (${rules.siteRules.length})`}>
      {rules.siteRules.map((rule, i) => (
        <SiteRuleCard
          key={`${rule.site}::${i}`}
          rule={rule}
          site={lookup.get(rule.site.toLowerCase())}
        />
      ))}
    </Card>
  );
}

function SiteRuleCard({ rule, site }: { rule: SiteRule; site?: GridSite }) {
  const color = site?.color ?? '#94a3b8';
  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        background: 'var(--bg-base)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`,
        marginBottom: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 5,
            background: hexA(color, 0.14),
            color,
            border: `1px solid ${hexA(color, 0.35)}`,
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {site?.icon ?? '◈'}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-strong)' }}>
          {rule.site}
        </span>
        {!site && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 9,
              fontFamily: 'var(--font-mono), ui-monospace, monospace',
              color: '#ef4444',
              fontWeight: 700,
              padding: '1px 5px',
              border: '1px solid rgba(239,68,68,0.4)',
              borderRadius: 3,
            }}
            title="No matching site found in step 2 — check the spelling."
          >
            unknown site
          </span>
        )}
      </div>
      <KV k="staffing" v={rule.defaultStaffing} />
      {rule.maxSupervisionRatio && (
        <KV k="max ratio" v={rule.maxSupervisionRatio} />
      )}
      {rule.supervisorFromSite && (
        <KV k="supervisor from" v={rule.supervisorFromSite} />
      )}
      {rule.auxiliaryRole && <KV k="aux role" v={rule.auxiliaryRole} />}
      {rule.fallbacks && rule.fallbacks.length > 0 && (
        <KV k="fallbacks" v={rule.fallbacks.join(', ')} />
      )}
      {rule.notes && (
        <p
          style={{
            margin: '2px 0 0',
            fontSize: 10,
            color: SLATE,
            lineHeight: 1.4,
            fontStyle: 'italic',
          }}
        >
          {rule.notes}
        </p>
      )}
    </div>
  );
}

function GlobalRulesList({ rules }: { rules: CoverageRuleSet }) {
  return (
    <Card title={`Global rules (${rules.globalRules.length})`}>
      {rules.globalRules.length === 0 ? (
        <EmptyState>No cross-site or top-level rules parsed.</EmptyState>
      ) : (
        rules.globalRules.map((rule, i) => (
          <div
            key={`${rule.kind}::${i}`}
            style={{
              padding: '8px 10px',
              borderRadius: 6,
              background: 'var(--bg-base)',
              border: '1px solid var(--border)',
              marginBottom: 6,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--text-strong)',
                fontFamily: 'var(--font-mono), ui-monospace, monospace',
              }}
            >
              {rule.kind}
            </span>
            <pre
              style={{
                margin: 0,
                fontSize: 10,
                lineHeight: 1.4,
                color: SLATE,
                fontFamily: 'var(--font-mono), ui-monospace, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {JSON.stringify(rule.payload, null, 2)}
            </pre>
          </div>
        ))
      )}
    </Card>
  );
}

function UnmappedBanner({
  sentences,
  onAcknowledge,
}: {
  sentences: string[];
  onAcknowledge: () => void;
}) {
  return (
    <div
      style={{
        background: 'rgba(245,158,11,0.06)',
        border: '1px solid rgba(245,158,11,0.3)',
        borderRadius: 8,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: AMBER,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
        }}
      >
        {sentences.length} sentence{sentences.length === 1 ? '' : 's'} not mapped
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: 'var(--text)' }}>
        {sentences.map((s, i) => (
          <li key={i} style={{ marginBottom: 2, lineHeight: 1.5 }}>
            {s}
          </li>
        ))}
      </ul>
      <p style={{ margin: 0, fontSize: 10, color: SLATE, lineHeight: 1.5 }}>
        Try rephrasing these sentences and re-parsing. If they truly belong in
        the rule set, A4 (the normalizer agent) will flag them for review.
      </p>
      <button
        type="button"
        onClick={onAcknowledge}
        style={{
          alignSelf: 'flex-start',
          background: 'transparent',
          border: `1px solid ${AMBER}55`,
          color: AMBER,
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 11,
          cursor: 'pointer',
          fontWeight: 700,
          fontFamily: 'inherit',
        }}
      >
        Acknowledge
      </button>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        background: 'rgba(239,68,68,0.06)',
        border: '1px solid rgba(239,68,68,0.3)',
        borderRadius: 8,
        padding: 10,
        fontSize: 11,
        color: '#dc2626',
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: '#b91c1c',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          marginBottom: 2,
        }}
      >
        Parse error
      </div>
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local UI helpers.
// ---------------------------------------------------------------------------

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--text-strong)',
          letterSpacing: -0.1,
          marginBottom: 2,
        }}
      >
        {title}
      </h2>
      <p
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: SLATE,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        fontSize: 11,
        color: 'var(--text)',
      }}
    >
      <span
        style={{
          minWidth: 84,
          color: SLATE,
          fontFamily: 'var(--font-mono), ui-monospace, monospace',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        {k}
      </span>
      <span style={{ fontWeight: 600 }}>{v}</span>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '14px 12px',
        color: SLATE,
        fontSize: 11,
        textAlign: 'center',
        lineHeight: 1.6,
        background: 'var(--bg-base)',
        border: '1px dashed var(--border)',
        borderRadius: 6,
      }}
    >
      {children}
    </div>
  );
}

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 32,
    padding: '0 14px',
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 6,
    background: disabled ? '#cbd5e1' : CYAN,
    color: 'white',
    border: `1px solid ${disabled ? '#cbd5e1' : CYAN}`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    fontFamily: 'inherit',
  };
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(epochMs).toLocaleString();
}

function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(100,116,139,${alpha})`;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
