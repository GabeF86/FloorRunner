'use client';

/* ── Block Targets tab ───────────────────────────────────────────────────────
 * The third tab of the pool modal (Pool | Limits | Block Targets), and the
 * first thing in the app that WRITES schedules.scenario_manifest. The engine
 * has honored per-provider, per-block call targets since the scenario layer
 * shipped; until now the only producer was the workbook importer.
 *
 * Gabriel, verbatim: "Build a small panel to enter them per block." He
 * overrides about four people out of ten, so the panel is built around not
 * typing: every blank cell is the house formula, and only what he types is
 * his. Structure, styling and the save flow follow the Limits tab next door —
 * same grid-of-inputs shape, same CSS variables, same "blank = no override"
 * convention, same ride-along save.
 *
 * All the logic that could be wrong lives in blockTargetsPanel.ts (tested);
 * this file is markup, fetch and state. The data layer is blockTargets.ts.
 * ─────────────────────────────────────────────────────────────────────────── */

import { useMemo, useState } from 'react';
import type { BucketKey, Linkage } from '@/lib/paoliBlock/manifest';
import {
  checkFeasibility,
  derivedTargetsFor,
  resolveTargets,
  type DerivationBasis,
  type FeasibilityRow,
} from '@/lib/blockTargets';
import {
  BUCKET_LABELS,
  BUCKET_TITLES,
  FORCED_REASON_TEXT,
  LINKABLE_BUCKETS,
  applyEitherOr,
  applySplitTwelveHour,
  cellKey,
  clearEitherOr,
  clearSplitTwelveHour,
  columnPlan,
  describeLinkage,
  formatTarget,
  isPanelEditableLinkage,
  parseTargetCell,
  summarizePanel,
  type PanelRow,
} from '@/lib/blockTargetsPanel';

/* ── shared bits of styling (the modal's own idiom, not a new one) ────────── */

const tinyBtn: React.CSSProperties = {
  padding: '3px 9px', fontSize: 11, fontWeight: 700, borderRadius: 6,
  background: 'transparent', color: 'var(--text-muted)',
  border: '1px solid var(--border)', cursor: 'pointer',
};

const chipBtn = (active: boolean): React.CSSProperties => ({
  padding: '3px 9px', fontSize: 11, fontWeight: 700, borderRadius: 999,
  cursor: 'pointer', whiteSpace: 'nowrap',
  background: active ? 'var(--info-bg)' : 'transparent',
  color: active ? 'var(--info)' : 'var(--text-muted)',
  border: `1px solid ${active ? 'var(--info)' : 'var(--border)'}`,
});

/** Marks the row's linkage editor. null = closed. */
type LinkDraft =
  | { providerId: string; mode: 'either-or'; buckets: BucketKey[] }
  | { providerId: string; mode: 'split-12h'; partnerId: string; bucket: BucketKey };

export interface BlockTargetsTabProps {
  /** Rows with their live overrides already applied (rowsWithCellText). */
  liveRows: PanelRow[];
  /** The same rows WITHOUT overrides folded in — what the mutators edit. */
  rows: PanelRow[];
  basis: DerivationBasis;
  cellText: Record<string, string>;
  setCellText: (next: Record<string, string>) => void;
  /** Replaces the linkages of every row from the mutator's result. */
  commitRows: (next: PanelRow[]) => void;
  state: 'loading' | 'ready' | 'failed';
  /** A manifest exists and did NOT come from this panel (workbook import). */
  imported: boolean;
  importAcknowledged: boolean;
  setImportAcknowledged: (v: boolean) => void;
  /** Stored manifest rows with no provider id — reported, never silent. */
  droppedUnidentified: string[];
  hasStoredManifest: boolean;
  dirty: boolean;
  onClearAll: () => void;
  clearRequested: boolean;
  /** buildBlockManifest's own errors (blank / duplicate provider ids). */
  manifestErrors: string[];
}

export function BlockTargetsTab(props: BlockTargetsTabProps) {
  const {
    liveRows, rows, basis, cellText, setCellText, commitRows, state,
    imported, importAcknowledged, setImportAcknowledged, droppedUnidentified,
    hasStoredManifest, dirty, onClearAll, clearRequested, manifestErrors,
  } = props;

  const [expanded, setExpanded] = useState(false);
  const [link, setLink] = useState<LinkDraft | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Resolution drives EVERYTHING below: the numbers, the derived/typed/claimed
  // styling, the columns and the feasibility strip all read the same resolve.
  const resolved = useMemo(
    () => liveRows.map(r => ({ row: r, res: resolveTargets(r, basis) })),
    [liveRows, basis]);

  const feasibility = useMemo(
    () => checkFeasibility(resolved.map(r => r.res.targets), basis.slotCounts),
    [resolved, basis.slotCounts]);

  const overBuckets = useMemo(
    () => feasibility.filter(f => f.overConstrained).map(f => f.bucket),
    [feasibility]);

  const plan = useMemo(
    () => columnPlan({
      expanded,
      resolved: resolved.map(r => r.res),
      overConstrained: overBuckets,
    }),
    [expanded, resolved, overBuckets]);

  const summary = useMemo(() => summarizePanel(liveRows, basis), [liveRows, basis]);

  if (state === 'loading') {
    return <Shell><div style={{ padding: 20, color: 'var(--text-dim)', fontSize: 13 }}>Loading block targets...</div></Shell>;
  }
  if (state === 'failed') {
    return (
      <Shell>
        <div style={{ padding: 20, color: 'var(--danger)', fontSize: 13 }}>
          Could not load the stored block targets — saving will leave them untouched.
          Close and reopen to retry.
        </div>
      </Shell>
    );
  }

  const gridCols = `minmax(120px, 1fr) 44px repeat(${plan.visible.length}, 62px)`;

  const setCell = (providerId: string, bucket: BucketKey, value: string) => {
    setCellText({ ...cellText, [cellKey(providerId, bucket)]: value });
  };

  const openLink = (row: PanelRow) => {
    setLinkError(null);
    setLink({ providerId: row.providerId, mode: 'either-or', buckets: [] });
  };

  const applyLink = () => {
    if (!link) return;
    try {
      if (link.mode === 'either-or') {
        commitRows(applyEitherOr(rows, link.providerId, link.buckets));
      } else {
        const next = applySplitTwelveHour(rows, cellText, {
          selfId: link.providerId, partnerId: link.partnerId, bucket: link.bucket,
        });
        commitRows(next.rows);
        setCellText(next.cellText);
      }
      setLink(null);
      setLinkError(null);
    } catch (e) {
      setLinkError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Shell>
      {/* ── notices ── */}
      {imported && (
        <Notice tone="warn">
          <strong>These targets came from a workbook import, not this panel.</strong>{' '}
          Saving replaces that manifest with what is shown here. Everything the panel cannot
          edit (no-call dates, fixed assignments, preferences) is carried through untouched,
          but every stated number is treated as typed.
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 7, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={importAcknowledged}
              onChange={e => setImportAcknowledged(e.target.checked)}
              style={{ accentColor: 'var(--warn)', width: 14, height: 14 }}
            />
            <span style={{ fontWeight: 700 }}>I understand — let me overwrite the imported manifest</span>
          </label>
        </Notice>
      )}
      {droppedUnidentified.length > 0 && (
        <Notice tone="warn">
          The stored manifest has {droppedUnidentified.length} row(s) with no matching provider
          ({droppedUnidentified.join(', ')}). The engine already ignores them; saving drops them.
        </Notice>
      )}
      {manifestErrors.map((e, i) => <Notice key={i} tone="danger">{e}</Notice>)}
      {clearRequested && (
        <Notice tone="danger">
          <strong>Block targets will be CLEARED on save.</strong> The engine will fall back to
          its ordinary FTE quota for every provider.
        </Notice>
      )}

      {/* ── legend: the three cell states, stated once ── */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12,
        fontSize: 11, color: 'var(--text-dim)', margin: '2px 0 8px',
      }}>
        <LegendSwatch kind="typed">1</LegendSwatch><span>you typed it</span>
        <LegendSwatch kind="derived">4</LegendSwatch><span>from the formula — clear a cell to get back here</span>
        <LegendSwatch kind="claimed">⇄</LegendSwatch><span>claimed by a linkage</span>
        <button
          onClick={() => setExpanded(v => !v)}
          style={{ ...tinyBtn, marginLeft: 'auto' }}
          title={expanded
            ? 'Hide the M–Th and second-call columns'
            : 'Show M–Th C1/C2 and the Friday/Saturday/Sunday second calls'}
        >
          {expanded ? 'Weekend only' : `Show all 9 columns (+${plan.hidden.length})`}
        </button>
      </div>

      {/* ── the grid ── */}
      <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <div style={{
          display: 'grid', gridTemplateColumns: gridCols, gap: 6,
          padding: '6px 12px', borderBottom: '1px solid var(--border)',
          background: 'var(--info-bg)', position: 'sticky', top: 0, zIndex: 1,
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>Provider</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textAlign: 'center' }}>FTE</span>
          {plan.visible.map(b => {
            const forced = plan.forced[b];
            return (
              <span
                key={b}
                title={`${BUCKET_TITLES[b]} — ${formatTarget(basis.slotCounts[b] ?? 0)} in this block`
                  + (forced ? `\n\nShown because ${FORCED_REASON_TEXT[forced]}.` : '')}
                style={{ textAlign: 'center', lineHeight: 1.25 }}
              >
                <span style={{
                  display: 'block', fontSize: 10.5, fontWeight: 700,
                  color: forced ? 'var(--warn)' : 'var(--text-muted)',
                }}>
                  {BUCKET_LABELS[b]}{forced ? ' •' : ''}
                </span>
                <span style={{ display: 'block', fontSize: 9.5, color: 'var(--text-faint)' }}>
                  {formatTarget(basis.slotCounts[b] ?? 0)}
                </span>
              </span>
            );
          })}
        </div>

        {resolved.length === 0 ? (
          <div style={{ padding: 20, color: 'var(--text-dim)', fontStyle: 'italic', fontSize: 13 }}>
            No call-takers in the current pool selection — block targets are per call taker.
          </div>
        ) : resolved.map(({ row, res }) => {
          const typed = new Set(res.overridden);
          const claimed = new Set(res.eitherOrCovered);
          const inert = !row.inPool;
          const links = row.linkages ?? [];
          return (
            <div key={row.providerId} style={{ borderBottom: '1px solid var(--border)', opacity: inert ? 0.55 : 1 }}>
              <div style={{
                display: 'grid', gridTemplateColumns: gridCols, gap: 6,
                alignItems: 'center', padding: '5px 12px',
              }}>
                <span style={{
                  fontSize: 12.5, color: 'var(--text)', whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {row.displayName}
                  {inert && <Tag tone="neutral">not in pool</Tag>}
                  {row.fteFromManifest && (
                    <Tag tone="warn" title={`The workbook states ${formatTarget(row.fte)} for this block; the employment profile says ${formatTarget(row.profileFte ?? 0)}. The workbook number is kept.`}>
                      workbook FTE
                    </Tag>
                  )}
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--text-dim)', textAlign: 'center' }}>
                  {formatTarget(row.fte)}
                </span>
                {plan.visible.map(b => {
                  const key = cellKey(row.providerId, b);
                  const raw = cellText[key] ?? '';
                  const invalid = !parseTargetCell(raw).ok;
                  if (claimed.has(b) && !typed.has(b)) {
                    return (
                      <span
                        key={b}
                        title={`Claimed by a linkage — ${links.filter(l => l.kind === 'either-or').map(describeLinkage).join('; ')}.\nThe engine caps the whole group at one call, so this bucket is held at 0. Type a number here only if you mean to raise that group ceiling.`}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                          height: 25, borderRadius: 6, fontSize: 12,
                          border: '1px dashed var(--warn)', background: 'var(--warn-bg)',
                          color: 'var(--warn)', fontWeight: 700, cursor: 'help',
                        }}
                      >⇄ 0</span>
                    );
                  }
                  const isTyped = typed.has(b);
                  return (
                    <input
                      key={b}
                      type="text"
                      inputMode="decimal"
                      value={raw}
                      placeholder={formatTarget(res.targets[b])}
                      disabled={inert}
                      onChange={e => setCell(row.providerId, b, e.target.value)}
                      title={isTyped
                        ? `${row.displayName} — ${BUCKET_TITLES[b]}: you typed ${raw}. Clear the box to go back to ${formatTarget(clearedValueOf(b, row.fte, basis, claimed))}.`
                        : `${row.displayName} — ${BUCKET_TITLES[b]}: ${formatTarget(res.targets[b])} from the formula (bucket slots ÷ par ${basis.parLevel} × FTE ${formatTarget(row.fte)}). Type here to override.`}
                      style={{
                        width: '100%', height: 25, padding: '2px 4px', fontSize: 12,
                        textAlign: 'center', borderRadius: 6,
                        border: invalid
                          ? '1px solid var(--danger)'
                          : isTyped ? '1px solid var(--info)' : '1px dashed var(--border)',
                        background: invalid
                          ? 'var(--danger-bg)'
                          : isTyped ? 'var(--info-bg)' : 'transparent',
                        color: invalid ? 'var(--danger)' : isTyped ? 'var(--text-strong)' : 'var(--text)',
                        fontWeight: isTyped ? 700 : 400,
                        fontStyle: 'normal',
                      }}
                    />
                  );
                })}
              </div>

              {/* linkage chips + the "link" affordance */}
              <div style={{
                display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
                padding: '0 12px 6px 12px',
              }}>
                {links.map((l, i) => (
                  <LinkChip
                    key={i}
                    linkage={l}
                    onRemove={inert || !isPanelEditableLinkage(l) ? null : () => {
                      commitRows(l.kind === 'either-or'
                        ? clearEitherOr(rows, row.providerId)
                        : clearSplitTwelveHour(rows, row.providerId));
                    }}
                  />
                ))}
                {!inert && (
                  <button
                    onClick={() => (link?.providerId === row.providerId ? setLink(null) : openLink(row))}
                    style={{ ...tinyBtn, fontSize: 10.5, padding: '2px 8px' }}
                    title="Link this provider's calls: an either-or the engine chooses between, or a 12-hour split with a partner"
                  >
                    {link?.providerId === row.providerId ? 'close' : '+ link'}
                  </button>
                )}
              </div>

              {link?.providerId === row.providerId && (
                <LinkEditor
                  row={row}
                  rows={rows}
                  draft={link}
                  setDraft={setLink}
                  onApply={applyLink}
                  onCancel={() => { setLink(null); setLinkError(null); }}
                  error={linkError}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* ── feasibility ── */}
      <Feasibility rows={feasibility} />

      {/* ── what happens next ── */}
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.5 }}>
        {summary.typedCellCount === 0 && summary.linkageCount === 0
          ? `Nothing overridden — all ${summary.providerCount} providers are on the formula.`
          : `${summary.touchedProviderCount} of ${summary.providerCount} providers overridden `
            + `· ${summary.typedCellCount} typed cell${summary.typedCellCount === 1 ? '' : 's'} `
            + `· ${summary.linkageCount} linkage${summary.linkageCount === 1 ? '' : 's'}.`}
        {' '}
        Saving states a target for <strong>every provider listed</strong>, and the engine treats
        each one as a ceiling — including the rows still on the formula.
        {' '}
        <strong style={{ color: 'var(--text-muted)' }}>
          Saving stores the targets; it does not change this draft. Run Auto-Generate for the
          engine to use them.
        </strong>
        {hasStoredManifest && !clearRequested && (
          <>
            {' '}
            <button
              onClick={onClearAll}
              style={{ ...tinyBtn, fontSize: 10, padding: '1px 7px', color: 'var(--danger)', borderColor: 'var(--danger)' }}
              title="Remove the stored block targets entirely on save — the engine returns to its ordinary FTE quota"
            >
              clear all targets
            </button>
          </>
        )}
      </div>
      {summary.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}
      {dirty && (
        <div style={{ fontSize: 11, color: 'var(--info)', marginTop: 4, fontWeight: 700 }}>
          Unsaved target changes — they save with the Pool button below.
        </div>
      )}
    </Shell>
  );
}

/* ── pieces ──────────────────────────────────────────────────────────────── */

function Shell({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{children}</div>;
}

/** What clearing a cell would put back. resolveTargets only reports the FINAL
 * number, so the derived value behind an override has to be recomputed — and
 * an either-or-claimed bucket falls back to 0, not to the formula, because the
 * group ceiling owns it. */
function clearedValueOf(
  bucket: BucketKey,
  fte: number,
  basis: DerivationBasis,
  claimed: Set<BucketKey>,
): number {
  return claimed.has(bucket) ? 0 : derivedTargetsFor(fte, basis)[bucket];
}

function LegendSwatch({ kind, children }: { kind: 'typed' | 'derived' | 'claimed'; children: React.ReactNode }) {
  const style: React.CSSProperties =
    kind === 'typed'
      ? { border: '1px solid var(--info)', background: 'var(--info-bg)', color: 'var(--text-strong)', fontWeight: 700 }
      : kind === 'claimed'
        ? { border: '1px dashed var(--warn)', background: 'var(--warn-bg)', color: 'var(--warn)', fontWeight: 700 }
        : { border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-faint)' };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 26, height: 19, borderRadius: 5, fontSize: 11, ...style,
    }}>{children}</span>
  );
}

function Tag({ tone, title, children }: { tone: 'neutral' | 'warn'; title?: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      style={{
        fontSize: 9, fontWeight: 800, marginLeft: 6, padding: '1px 5px', borderRadius: 4,
        background: tone === 'warn' ? 'var(--warn-bg)' : 'var(--tint-surface)',
        color: tone === 'warn' ? 'var(--warn)' : 'var(--text-dim)',
        textTransform: 'uppercase', letterSpacing: 0.5, cursor: title ? 'help' : 'default',
      }}
    >{children}</span>
  );
}

function Notice({ tone, children }: { tone: 'warn' | 'danger'; children: React.ReactNode }) {
  return (
    <div style={{
      background: tone === 'warn' ? 'var(--warn-bg)' : 'var(--danger-bg)',
      border: `1px solid ${tone === 'warn' ? 'var(--warn)' : 'var(--danger)'}`,
      color: tone === 'warn' ? 'var(--warn)' : 'var(--danger)',
      padding: '7px 10px', borderRadius: 8, marginBottom: 8, fontSize: 11.5, lineHeight: 1.45,
    }}>{children}</div>
  );
}

function LinkChip({ linkage, onRemove }: { linkage: Linkage; onRemove: (() => void) | null }) {
  return (
    <span
      title={linkage.source}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
        background: 'var(--warn-bg)', color: 'var(--warn)', border: '1px solid var(--warn)',
      }}
    >
      ⇄ {describeLinkage(linkage)}
      {onRemove ? (
        <button
          onClick={onRemove}
          title="Remove this linkage"
          style={{
            border: 'none', background: 'transparent', color: 'var(--warn)',
            cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0, fontWeight: 800,
          }}
        >×</button>
      ) : (
        <span title="Imported from the workbook — this panel has no editor for this kind" style={{ opacity: 0.7 }}>🔒</span>
      )}
    </span>
  );
}

function LinkEditor({
  row, rows, draft, setDraft, onApply, onCancel, error,
}: {
  row: PanelRow;
  rows: PanelRow[];
  draft: LinkDraft;
  setDraft: (d: LinkDraft) => void;
  onApply: () => void;
  onCancel: () => void;
  error: string | null;
}) {
  const partners = rows.filter(r => r.providerId !== row.providerId && r.inPool);
  const canApply = draft.mode === 'either-or'
    ? draft.buckets.length >= 2
    : !!draft.partnerId;

  const preview = draft.mode === 'either-or'
    ? draft.buckets.length >= 2
      ? `The engine places exactly ONE of ${draft.buckets.map(b => BUCKET_LABELS[b]).join(' or ')} `
        + `for ${row.displayName}, and holds all of them at 0 so the group ceiling is one call.`
      : 'Pick at least two calls for the engine to choose between.'
    : draft.partnerId
      ? `${row.displayName} and ${partners.find(p => p.providerId === draft.partnerId)?.displayName} `
        + `each take 12 hrs of one ${BUCKET_LABELS[draft.bucket]}. `
        + `Sets ${BUCKET_LABELS[draft.bucket]} = 0.5 for BOTH of them.`
      : 'Pick the partner who takes the other 12 hours.';

  return (
    <div style={{
      margin: '0 12px 8px', padding: 10, borderRadius: 8,
      border: '1px solid var(--border)', background: 'var(--tint-surface-faint)',
    }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button
          onClick={() => setDraft({ providerId: row.providerId, mode: 'either-or', buckets: [] })}
          style={chipBtn(draft.mode === 'either-or')}
        >Engine picks one of…</button>
        <button
          onClick={() => setDraft({
            providerId: row.providerId, mode: 'split-12h',
            partnerId: partners[0]?.providerId ?? '', bucket: 'SUN_C1',
          })}
          style={chipBtn(draft.mode === 'split-12h')}
        >Split a 12-hour call…</button>
      </div>

      {draft.mode === 'either-or' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 3 }}>Choose between:</span>
          {LINKABLE_BUCKETS.map(b => {
            const on = draft.buckets.includes(b);
            return (
              <button
                key={b}
                onClick={() => setDraft({
                  ...draft,
                  buckets: on ? draft.buckets.filter(x => x !== b) : [...draft.buckets, b],
                })}
                style={chipBtn(on)}
              >{BUCKET_LABELS[b]}</button>
            );
          })}
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>with</span>
          <select
            value={draft.partnerId}
            onChange={e => setDraft({ ...draft, partnerId: e.target.value })}
            style={{
              fontSize: 11.5, padding: '3px 6px', borderRadius: 6,
              border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text)',
            }}
          >
            <option value="">select a partner…</option>
            {partners.map(p => (
              <option key={p.providerId} value={p.providerId}>{p.displayName}</option>
            ))}
          </select>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>on a</span>
          {LINKABLE_BUCKETS.map(b => (
            <button
              key={b}
              onClick={() => setDraft({ ...draft, bucket: b })}
              style={chipBtn(draft.bucket === b)}
            >{BUCKET_LABELS[b]}</button>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '8px 0', lineHeight: 1.45 }}>
        {preview}
      </div>
      {error && <div style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 6 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={onApply}
          disabled={!canApply}
          style={{
            ...tinyBtn,
            background: canApply ? 'var(--info-bg)' : 'transparent',
            color: canApply ? 'var(--info)' : 'var(--text-faint)',
            borderColor: canApply ? 'var(--info)' : 'var(--border)',
            cursor: canApply ? 'pointer' : 'not-allowed',
          }}
        >Apply</button>
        <button onClick={onCancel} style={tinyBtn}>Cancel</button>
      </div>
    </div>
  );
}

function Feasibility({ rows }: { rows: FeasibilityRow[] }) {
  const over = rows.filter(r => r.overConstrained);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {rows.map(r => {
          const tone = r.status === 'over'
            ? { fg: 'var(--danger)', bg: 'var(--danger-bg)', bd: 'var(--danger)' }
            : r.status === 'exact'
              ? { fg: 'var(--ok)', bg: 'var(--ok-bg)', bd: 'var(--ok)' }
              : { fg: 'var(--text-dim)', bg: 'var(--tint-surface)', bd: 'transparent' };
          return (
            <span
              key={r.bucket}
              title={`${BUCKET_TITLES[r.bucket]}\nStated across the roster: ${formatTarget(r.stated)}\nIn the block: ${formatTarget(r.slots)}\n`
                + (r.status === 'over'
                  ? 'OVER — the roster is asking for more of these than exist. Scenario ceilings are hard, so slots go unfilled or providers sit capped.'
                  : r.status === 'exact'
                    ? 'Exactly covered.'
                    : 'Under — normal here. The pool runs below par by design and the remainder is taken as paid pickups.')}
              style={{
                display: 'inline-flex', alignItems: 'baseline', gap: 4,
                fontSize: 10.5, padding: '2px 7px', borderRadius: 999,
                background: tone.bg, color: tone.fg, border: `1px solid ${tone.bd}`,
                fontWeight: r.status === 'over' ? 800 : 600, cursor: 'help',
              }}
            >
              <span>{BUCKET_LABELS[r.bucket]}</span>
              <span style={{ fontFamily: 'var(--font-mono), ui-monospace, monospace' }}>
                {formatTarget(r.stated)}/{formatTarget(r.slots)}
              </span>
            </span>
          );
        })}
      </div>
      <div style={{ fontSize: 10.5, color: over.length > 0 ? 'var(--danger)' : 'var(--text-faint)', marginTop: 5, lineHeight: 1.45 }}>
        {over.length > 0
          ? `Over-constrained: ${over.map(o => `${BUCKET_LABELS[o.bucket]} (+${formatTarget(o.delta)})`).join(', ')}. `
            + 'The block does not contain that many of these calls — something will go unfilled.'
          : 'Stated / in the block. Under-target is normal — the pool runs below par and the remainder is taken as paid pickups.'}
      </div>
    </div>
  );
}
