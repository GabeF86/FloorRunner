// Block Targets panel — the VIEW logic behind the schedule page's third pool
// tab (2026-07-27). The data layer is blockTargets.ts; nothing here re-derives,
// re-resolves or re-validates anything it owns. This module exists because
// vitest runs `environment: 'node'` with no jsdom, so a page component is not
// unit-testable — every decision the panel makes that could be WRONG lives
// here, next to a test, and the component is left as markup over these
// functions.
//
// WHAT IS ACTUALLY DECIDED HERE
//
// 1. COLUMN VISIBILITY, AND THE SAFETY RULE THAT MAKES IT SAFE. Nine buckets
//    do not fit a modal he can read, and he does not speak in nine buckets: his
//    own words are "1 Saturday C1", "a Friday C1", "12 hrs on a Sunday C1",
//    "a neuro weekend". So FRI_C1/SAT_C1/SUN_C1/NEURO_FSS are shown by default
//    and the other five (M–Th C1, M–Th C2, and the three weekend C2s) sit
//    behind one toggle. That is only acceptable with a hard rule: a column is
//    FORCE-SHOWN whenever hiding it would hide something that matters — a cell
//    he typed, a cell an either-or claims, or a bucket the roster has
//    over-constrained. columnPlan() computes that, and columnPlan's test is the
//    one that keeps a hidden override from ever existing.
//
// 2. BLANK MEANS DERIVED, THROUGH A TEXT INPUT. The cells are strings while he
//    types (a half-entered "0." is not a number), so the panel holds one
//    cellText map and derives TargetOverrides from it — one source of truth per
//    cell, never a number and a string that can disagree. Blank is not zero:
//    blank deletes the key and the formula takes the cell back, while a typed
//    "0" is a real override of zero (resolveTargets draws exactly that line).
//
// 3. THE TWO LINKAGES, WITHOUT THE STRING GRAMMAR. He picks a provider, a day
//    and a call code from chips; bucketToSlotRef turns the bucket key he
//    clicked into the {scope, code} that blockTargets.linkageMember validates.
//    `FRI:C1` is never concatenated here or in the component. Only FRI/SAT/SUN
//    buckets are offerable: MTH is a workbook column, NOT a weekday code
//    (WEEKDAY_CODES has no 'MTH'), so a Mon–Thu linkage cannot be expressed in
//    the member grammar at weekday scope and is refused rather than faked.
//
// 4. THE 12h SPLIT IS TWO ROWS, NOT ONE. "Horan takes 12 hrs of a Sunday C1 and
//    Havildar takes the other 12" is one linkage on Horan's row PLUS a 0.5 in
//    Horan's SUN_C1 and a 0.5 in Havildar's SUN_C1 — a 12h segment is weight
//    0.5. Writing the linkage without both cells would leave Havildar deriving
//    a whole 0.75 Sunday and quietly asking for a second Sunday call.
//    applySplitTwelveHour does all three edits together so they cannot separate.
//
// 5. THE FOOTER STATES THE BLAST RADIUS, AND COUNTS IT THE WAY THE SAVE DOES.
//    Only rows with something stated are written (blockTargets.statedProviders
//    — the people he never touched stay UNCAPPED, see that module's header), so
//    the footer cannot say "every provider listed". summarizePanel counts
//    through the very same function buildBlockManifest writes from, and hands
//    back writtenProviderIds so the grid can mark exactly those rows: he sees
//    who he is about to constrain BEFORE he saves, not after.
//
// 6. AN IMPORTED MANIFEST IS NOT THE PANEL'S TO REWRITE. buildPanelRows carries
//    prohibitions, fixedAssignments and preferences through untouched (the
//    panel has no UI for them, and dropping a workbook's "no call 9/12" on save
//    would be a silent clinical change), and keeps an imported scenarioFte that
//    disagrees with the live profile — a workbook FTE was authored, a
//    panel-authored one is just a copy of the profile and should follow it.
//
// PURE — no I/O, no React. The component owns fetch, state and markup.

import {
  BUCKET_KEYS,
  type BucketKey,
  type Linkage,
} from '@/lib/paoliBlock/manifest';
import {
  eitherOrLinkage,
  isPanelAuthored,
  readPanelProviders,
  resolveTargets,
  splitTwelveHourLinkage,
  statedProviders,
  type BlockTargetsProvider,
  type DerivationBasis,
  type LinkageSlotRef,
  type TargetOverrides,
} from '@/lib/blockTargets';
import { WEIGHT_EPSILON } from '@/lib/callBurden';

// ── labels and ordering ──────────────────────────────────────────────────────

/** Column headings, in his vocabulary (the workbook's own column names). */
export const BUCKET_LABELS: Record<BucketKey, string> = {
  MTH_C1: 'M–Th C1',
  MTH_C2: 'M–Th C2',
  FRI_C1: 'Fri C1',
  FRI_C2: 'Fri C2',
  SAT_C1: 'Sat C1',
  SAT_C2: 'Sat C2',
  SUN_C1: 'Sun C1',
  SUN_C2: 'Sun C2',
  NEURO_FSS: 'Neuro wknd',
};

/** Long form for tooltips and the feasibility strip. */
export const BUCKET_TITLES: Record<BucketKey, string> = {
  MTH_C1: 'Monday–Thursday first call',
  MTH_C2: 'Monday–Thursday late/second call',
  FRI_C1: 'Friday first call',
  FRI_C2: 'Friday late/second call',
  SAT_C1: 'Saturday first call',
  SAT_C2: 'Saturday late/second call',
  SUN_C1: 'Sunday first call',
  SUN_C2: 'Sunday late/second call',
  NEURO_FSS: 'Neuro F/S/S weekends, counted in WEEKEND UNITS (a Sat+Sun pair is 1, a lone day 0.5)',
};

/**
 * Display order: the weekend first, because that is the entire vocabulary of
 * what he overrides. BUCKET_KEYS order (M–Th first) is the manifest's storage
 * order and is deliberately NOT the panel's. Asserted a permutation of
 * BUCKET_KEYS in the test, so adding a tenth bucket cannot leave a column that
 * silently never renders.
 */
export const PANEL_BUCKET_ORDER: readonly BucketKey[] = [
  'FRI_C1', 'SAT_C1', 'SUN_C1', 'NEURO_FSS',
  'MTH_C1', 'MTH_C2', 'FRI_C2', 'SAT_C2', 'SUN_C2',
];

/** Shown without asking — the four he states out loud. */
export const PRIMARY_BUCKETS: readonly BucketKey[] = ['FRI_C1', 'SAT_C1', 'SUN_C1', 'NEURO_FSS'];

/** Behind the "show all nine" toggle, unless force-shown (see columnPlan). */
export const SECONDARY_BUCKETS: readonly BucketKey[] =
  PANEL_BUCKET_ORDER.filter(k => !PRIMARY_BUCKETS.includes(k));

/** Buckets a weekday-scoped linkage member can name. MTH is a workbook column,
 * not a weekday code, so it has no scope — see the module header. */
export const LINKABLE_BUCKETS: readonly BucketKey[] =
  ['FRI_C1', 'FRI_C2', 'SAT_C1', 'SAT_C2', 'SUN_C1', 'SUN_C2'];

/** A bucket key back into the {scope, code} pair linkageMember validates.
 * Throws on MTH_* and NEURO_FSS rather than inventing a scope for them. */
export function bucketToSlotRef(bucket: BucketKey): LinkageSlotRef {
  if (!LINKABLE_BUCKETS.includes(bucket)) {
    throw new Error(
      `bucketToSlotRef: ${bucket} cannot be named by a weekday-scoped linkage member `
      + `(only Fri/Sat/Sun C1 and C2 can)`);
  }
  const [scope, code] = bucket.split('_');
  return { scope: scope as LinkageSlotRef['scope'], code: code as LinkageSlotRef['code'] };
}

/** Formats a target for display: 0.5 stays 0.5, 4 stays 4, 2.64 stays 2.64. */
export function formatTarget(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n * 1e6) / 1e6);
}

// ── cell text (blank means derived) ──────────────────────────────────────────

/** cellText key. Provider ids are UUIDs, so '|' cannot collide. */
export function cellKey(providerId: string, bucket: BucketKey): string {
  return `${providerId}|${bucket}`;
}

export type TargetCellParse =
  | { ok: true; value: number | null }
  | { ok: false; error: string };

/**
 * One typed cell. Blank (or whitespace) is null — the cell is CLEARED back to
 * the derived formula, which is how he un-does an override. A typed "0" is a
 * real zero and stays an override.
 */
export function parseTargetCell(raw: string): TargetCellParse {
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  const n = Number(s);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `'${raw.trim()}' is not a number — targets are counts of calls (0, 1, 0.5)` };
  }
  if (n < 0) return { ok: false, error: 'a target cannot be negative' };
  return { ok: true, value: n };
}

/** The provider id half of a cellText key. */
export function providerIdOfCellKey(key: string): string {
  const i = key.lastIndexOf('|');
  return i < 0 ? key : key.slice(0, i);
}

/**
 * Every cell whose text will not parse. Save is blocked while this is
 * non-empty — never silently drop a value he typed.
 *
 * SCOPED, because cellText is keyed by provider and outlives the row: when a
 * provider leaves the pool their row disappears but their cells do not, and an
 * unscoped scan would then block Save over a cell that is nowhere on screen to
 * fix. Only cells belonging to a rendered row can block.
 */
export function invalidCellKeys(
  cellText: Readonly<Record<string, string>>,
  providerIds?: ReadonlySet<string>,
): string[] {
  return Object.keys(cellText)
    .filter(k => (providerIds ? providerIds.has(providerIdOfCellKey(k)) : true))
    .filter(k => !parseTargetCell(cellText[k] ?? '').ok)
    .sort();
}

/** The overrides for one provider: only the cells with a parseable, non-blank
 * value. Invalid text contributes nothing (and blocks the save separately). */
export function overridesFromCellText(
  providerId: string,
  cellText: Readonly<Record<string, string>>,
): TargetOverrides {
  const out: TargetOverrides = {};
  for (const bucket of BUCKET_KEYS) {
    const parsed = parseTargetCell(cellText[cellKey(providerId, bucket)] ?? '');
    if (parsed.ok && parsed.value !== null) out[bucket] = parsed.value;
  }
  return out;
}

/** Seed the cellText map from rows read back off a stored manifest, so
 * re-opening shows his typed cells as typed and everything else blank. */
export function cellTextFromRows(rows: ReadonlyArray<BlockTargetsProvider>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    for (const bucket of BUCKET_KEYS) {
      const v = row.overrides?.[bucket];
      if (typeof v === 'number' && Number.isFinite(v)) out[cellKey(row.providerId, bucket)] = String(v);
    }
  }
  return out;
}

/** Rows with their overrides taken from the live cellText — what gets handed
 * to buildBlockManifest, and what the panel resolves for display. */
export function rowsWithCellText<T extends BlockTargetsProvider>(
  rows: readonly T[],
  cellText: Readonly<Record<string, string>>,
): T[] {
  return rows.map(row => ({ ...row, overrides: overridesFromCellText(row.providerId, cellText) }));
}

// ── rows ─────────────────────────────────────────────────────────────────────

/** A provider as the schedule page knows them. */
export interface PoolMember {
  providerId: string;
  /** Manifest `sourceName` and split-12h linkage member — the last name, the
   * way the workbook and the generation report name people. */
  displayName: string;
  /** The live employment-profile FTE. */
  profileFte: number;
}

export interface PanelRow extends BlockTargetsProvider {
  /** False = stored targets for someone no longer in the call pool. Rendered
   * inert and kept (the Limits-tab rule: never silently drop stored data). */
  inPool: boolean;
  /** null for an out-of-pool row with no live profile. */
  profileFte: number | null;
  /** True when `fte` came from an IMPORTED manifest and disagrees with the
   * live profile — an authored number the panel must not quietly overwrite. */
  fteFromManifest: boolean;
}

export interface PanelRowsResult {
  rows: PanelRow[];
  /** True when a READABLE manifest is stored that did NOT come from this panel. */
  imported: boolean;
  /**
   * True when the column holds ANYTHING — read off the raw value, never off
   * the row count. A manifest whose `providers` is missing, not an array or
   * empty yields zero rows, and treating that as "nothing stored" would hide
   * both the overwrite warning and the clear button, letting one edit
   * overwrite a column whose contents were never understood.
   */
  hasStoredManifest: boolean;
  /** Stored, non-null, but no rows could be read from it. Gated exactly like
   * `imported`: it is not the panel's to overwrite without being told. */
  unreadable: boolean;
  /** Stored provider rows with no provider id — unmatchable, so they are
   * dropped rather than round-tripped. Surfaced, never silent. */
  droppedUnidentified: string[];
}

/**
 * The panel's rows: one per call-pool member, in the order given, plus any
 * stored row for someone who has since left the pool.
 *
 * FTE. A panel-authored manifest's scenarioFte is only ever a copy of the
 * profile FTE at save time, so it FOLLOWS the profile. An imported manifest's
 * scenarioFte was authored in the workbook, so it is KEPT and flagged.
 */
export function buildPanelRows(opts: {
  pool: readonly PoolMember[];
  storedManifest: unknown;
  /** Display name for an out-of-pool provider id, when the page can still
   * resolve one. */
  nameFor?: (providerId: string) => string | null;
}): PanelRowsResult {
  const storedRows = readPanelProviders(opts.storedManifest);
  const hasStoredManifest = opts.storedManifest != null;
  const unreadable = hasStoredManifest && storedRows.length === 0;
  const imported = hasStoredManifest && !unreadable && !isPanelAuthored(opts.storedManifest);

  const storedById = new Map<string, BlockTargetsProvider>();
  const droppedUnidentified: string[] = [];
  for (const row of storedRows) {
    if (!row.providerId.trim()) {
      droppedUnidentified.push(row.displayName || '(unnamed)');
      continue;
    }
    storedById.set(row.providerId, row);
  }

  const used = new Set<string>();
  const rows: PanelRow[] = opts.pool.map(member => {
    const stored = storedById.get(member.providerId);
    used.add(member.providerId);
    const keepStoredFte =
      !!stored && imported && Math.abs(stored.fte - member.profileFte) > WEIGHT_EPSILON;
    return {
      providerId: member.providerId,
      displayName: member.displayName,
      fte: keepStoredFte ? stored!.fte : member.profileFte,
      overrides: stored?.overrides ?? {},
      linkages: stored?.linkages ?? [],
      prohibitions: stored?.prohibitions ?? [],
      fixedAssignments: stored?.fixedAssignments ?? [],
      preferences: stored?.preferences ?? [],
      inPool: true,
      profileFte: member.profileFte,
      fteFromManifest: keepStoredFte,
    };
  });

  for (const [providerId, stored] of storedById) {
    if (used.has(providerId)) continue;
    rows.push({
      ...stored,
      displayName: opts.nameFor?.(providerId) || stored.displayName,
      inPool: false,
      profileFte: null,
      fteFromManifest: false,
    });
  }

  return { rows, imported, hasStoredManifest, unreadable, droppedUnidentified };
}

// ── stranded edits, dirtiness, and the write decision ────────────────────────

export interface OrphanedSplit {
  providerId: string;
  displayName: string;
  partner: string;
}

export interface StrandedEdits {
  /** Providers with typed cells but NO row on the panel — their numbers would
   * be dropped on save without a word. */
  cellProviderIds: string[];
  /** split-12h linkages whose named partner is no longer a row. The linkage
   * and the initiator's 0.5 survive; the other half of the call belongs to
   * nobody, and neither resolveTargets nor projectScenario can see it. */
  orphanedSplits: OrphanedSplit[];
}

/** Edits that no longer belong to any visible row — always surfaced, never
 * silently discarded (the pool selection can strand them at any time). */
export function strandedEdits(
  rows: readonly PanelRow[],
  cellText: Readonly<Record<string, string>>,
): StrandedEdits {
  const present = new Set(rows.map(r => r.providerId));
  const names = new Set(rows.map(r => r.displayName.trim().toLowerCase()));
  const cellProviderIds = [...new Set(
    Object.entries(cellText)
      .filter(([, v]) => v.trim() !== '')
      .map(([k]) => providerIdOfCellKey(k))
      .filter(pid => !present.has(pid)),
  )].sort();

  const orphanedSplits: OrphanedSplit[] = [];
  for (const row of rows) {
    for (const l of row.linkages ?? []) {
      if (l.kind !== 'split-12h') continue;
      for (const partner of l.members.slice(1)) {
        if (!names.has(partner.trim().toLowerCase())) {
          orphanedSplits.push({ providerId: row.providerId, displayName: row.displayName, partner });
        }
      }
    }
  }
  return { cellProviderIds, orphanedSplits };
}

/**
 * A stable signature of everything the panel would WRITE. Dirtiness is this
 * compared against the signature taken at seed time — never a one-way latch:
 * typing a value and deleting it again must not leave the panel armed, because
 * every stated number it does write is a HARD ceiling, and a panel armed with
 * nothing stated writes a CLEAR that deletes whatever was stored.
 *
 * Cells are counted whether or not their row is currently rendered (an edit
 * stranded by a pool change is still an edit), and linkages come off the rows,
 * so pool membership alone never moves the signature.
 */
export function targetEditFingerprint(
  rows: readonly PanelRow[],
  cellText: Readonly<Record<string, string>>,
): string {
  const cells = Object.entries(cellText)
    .map(([k, v]) => [k, v.trim()] as const)
    .filter(([, v]) => v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const links = rows
    .filter(r => (r.linkages?.length ?? 0) > 0)
    .map(r => [r.providerId, r.linkages] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({ cells, links });
}

export type TargetWriteAction = 'omit' | 'clear' | 'manifest';

export interface TargetWritePlan {
  /** 'omit' = do not send the key at all; 'clear' = send null; 'manifest' =
   * send the built artifact. */
  write: TargetWriteAction;
  /** Non-null = Save must be disabled, and this is why (shown as the button's
   * title). */
  blocked: string | null;
}

/**
 * Whether this save touches scenario_manifest, and whether it may proceed.
 *
 * Lifted out of the component deliberately: this is the entire guarantee
 * behind "a pool-only save never rewrites a stored manifest" and "a failed
 * fetch never clobbers one", and it belongs next to a test like every other
 * decision the panel makes.
 *
 * NOTHING STATED ⇒ CLEAR, NOT AN EMPTY MANIFEST (2026-07-27). Since only stated
 * providers are written, emptying the panel now yields `providers: []` — legal,
 * but it steers nobody AND buildPanelRows reads a zero-row manifest back as
 * `unreadable`, which would greet the next open with a red "none of it could be
 * read" banner over something this panel wrote itself. Storing null instead says
 * the same thing honestly. It is checked AFTER the invalid-cell and error gates
 * so an unparseable cell (which contributes no override, and so could leave
 * nothing stated) still blocks the save rather than silently clearing.
 */
export function targetWritePlan(input: {
  manifestState: 'loading' | 'ready' | 'failed';
  dirty: boolean;
  clearRequested: boolean;
  imported: boolean;
  unreadable: boolean;
  importAcknowledged: boolean;
  invalidCellCount: number;
  manifestErrors: readonly string[];
  /** Rows that would be written — summarizePanel's writtenProviderCount. */
  statedProviderCount: number;
}): TargetWritePlan {
  // Never write what was never read. A load that failed or has not landed
  // leaves the column exactly as it is.
  if (input.manifestState !== 'ready') return { write: 'omit', blocked: null };
  if (!input.dirty && !input.clearRequested) return { write: 'omit', blocked: null };

  const needsAck = input.imported || input.unreadable;
  if (needsAck && !input.importAcknowledged) {
    return {
      write: input.clearRequested ? 'clear' : 'manifest',
      blocked: input.unreadable
        ? 'The stored block targets could not be read — acknowledge replacing them on the Block Targets tab first'
        : 'Acknowledge overwriting the imported manifest on the Block Targets tab first',
    };
  }
  if (input.clearRequested) return { write: 'clear', blocked: null };
  if (input.invalidCellCount > 0) {
    return { write: 'manifest', blocked: 'Fix the highlighted block-target values (numbers ≥ 0)' };
  }
  if (input.manifestErrors.length > 0) {
    return { write: 'manifest', blocked: input.manifestErrors[0] };
  }
  if (input.statedProviderCount === 0) return { write: 'clear', blocked: null };
  return { write: 'manifest', blocked: null };
}

// ── column plan ──────────────────────────────────────────────────────────────

export type ForcedReason = 'typed' | 'linked' | 'over';

export const FORCED_REASON_TEXT: Record<ForcedReason, string> = {
  typed: 'a value was typed here',
  linked: 'an either-or linkage claims this call',
  over: 'the roster asks for more of these than the block has',
};

export interface ColumnPlan {
  /** Columns to render, in PANEL_BUCKET_ORDER. */
  visible: readonly BucketKey[];
  /** Secondary columns the toggle is currently hiding. */
  hidden: readonly BucketKey[];
  /** Secondary columns shown despite the toggle, and why. */
  forced: Readonly<Partial<Record<BucketKey, ForcedReason>>>;
}

/**
 * Which of the nine columns to show.
 *
 * The four primaries always. The other five only when expanded — EXCEPT that a
 * secondary column is force-shown when hiding it would hide something that
 * matters. Without that rule a collapsed panel could hold an override he can
 * neither see nor clear, which is the exact failure this panel exists to
 * prevent. Precedence when several reasons apply: typed > linked > over (the
 * most specific thing he can act on).
 */
export function columnPlan(opts: {
  expanded: boolean;
  resolved: ReadonlyArray<{
    overridden: readonly BucketKey[];
    eitherOrCovered: readonly BucketKey[];
  }>;
  overConstrained?: readonly BucketKey[];
}): ColumnPlan {
  const forced: Partial<Record<BucketKey, ForcedReason>> = {};
  const mark = (bucket: BucketKey, reason: ForcedReason) => {
    if (PRIMARY_BUCKETS.includes(bucket)) return;
    const rank: Record<ForcedReason, number> = { typed: 0, linked: 1, over: 2 };
    const cur = forced[bucket];
    if (cur === undefined || rank[reason] < rank[cur]) forced[bucket] = reason;
  };
  for (const r of opts.resolved) {
    for (const b of r.overridden) mark(b, 'typed');
    for (const b of r.eitherOrCovered) mark(b, 'linked');
  }
  for (const b of opts.overConstrained ?? []) mark(b, 'over');

  const visible = PANEL_BUCKET_ORDER.filter(
    b => PRIMARY_BUCKETS.includes(b) || opts.expanded || forced[b] !== undefined);
  const hidden = PANEL_BUCKET_ORDER.filter(b => !visible.includes(b));
  return { visible, hidden, forced };
}

// ── linkages ─────────────────────────────────────────────────────────────────

/** Every linkage this panel writes carries this in `source`, so the generation
 * report says where the constraint came from. */
export const PANEL_LINKAGE_SOURCE = 'Block Targets panel';

export function eitherOrSourceText(name: string, refs: readonly LinkageSlotRef[]): string {
  const list = refs.map(r => slotRefLabel(r)).join(' or ');
  return `${name}: one of ${list} — engine's choice (${PANEL_LINKAGE_SOURCE})`;
}

export function splitSourceText(selfName: string, partnerName: string, bucket: BucketKey): string {
  return `${selfName} and ${partnerName} split one ${BUCKET_LABELS[bucket]} 12/12 (${PANEL_LINKAGE_SOURCE})`;
}

const SCOPE_LABEL: Record<string, string> = { FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' };

function slotRefLabel(ref: LinkageSlotRef): string {
  const scope = String(ref.scope);
  return `${SCOPE_LABEL[scope] ?? scope} ${ref.code}`;
}

/** Plain English for ANY linkage kind, including the same-date/same-weekend
 * kinds only the workbook importer produces — an imported linkage must be
 * VISIBLE in the panel, never invisible just because there is no editor. */
export function describeLinkage(linkage: Linkage): string {
  switch (linkage.kind) {
    case 'either-or':
      return `Engine picks ONE of: ${linkage.members.map(memberLabel).join(' or ')}`;
    case 'split-12h':
      return `Splits a 12h/12h call with ${linkage.members.slice(1).join(', ') || '(no partner)'}`
        + (linkage.details ? ` — ${linkage.details}` : '');
    case 'same-weekend':
      return `Same weekend: ${linkage.members.map(memberLabel).join(' + ')}`;
    case 'same-date':
      return `Same day: ${linkage.members.map(memberLabel).join(' + ')}`;
    default:
      return `${linkage.kind}: ${linkage.members.join(', ')}`;
  }
}

/** `FRI:C1` → `Fri C1`; anything else (a provider name) passes through. */
function memberLabel(raw: string): string {
  const idx = raw.lastIndexOf(':');
  if (idx < 0) return raw;
  const scope = raw.slice(0, idx);
  const code = raw.slice(idx + 1);
  return `${SCOPE_LABEL[scope] ?? scope} ${code}`;
}

/** True for a linkage this panel knows how to edit and remove. */
export function isPanelEditableLinkage(l: Linkage): boolean {
  return l.kind === 'either-or' || l.kind === 'split-12h';
}

function replaceLinkage(row: PanelRow, kind: Linkage['kind'], next: Linkage | null): PanelRow {
  const kept = (row.linkages ?? []).filter(l => l.kind !== kind);
  return { ...row, linkages: next ? [...kept, next] : kept };
}

/**
 * "Take either of these, not both." Buckets covered by the group are zeroed by
 * resolveTargets, so the engine ceiling lands on exactly one call.
 */
export function applyEitherOr(
  rows: readonly PanelRow[],
  providerId: string,
  buckets: readonly BucketKey[],
): PanelRow[] {
  if (buckets.length < 2) {
    throw new Error('applyEitherOr: pick at least two calls for the engine to choose between');
  }
  const row = rows.find(r => r.providerId === providerId);
  if (!row) throw new Error(`applyEitherOr: no panel row for provider ${providerId}`);
  const refs = buckets.map(bucketToSlotRef);
  const linkage = eitherOrLinkage(refs, { source: eitherOrSourceText(row.displayName, refs) });
  return rows.map(r => (r.providerId === providerId ? replaceLinkage(r, 'either-or', linkage) : r));
}

export function clearEitherOr(rows: readonly PanelRow[], providerId: string): PanelRow[] {
  return rows.map(r => (r.providerId === providerId ? replaceLinkage(r, 'either-or', null) : r));
}

export interface SplitTwelveHourEdit {
  rows: PanelRow[];
  cellText: Record<string, string>;
}

/**
 * "These two split one 24h call 12/12."
 *
 * Three edits that must never separate: the linkage on the initiator's row,
 * and a 0.5 in the shared bucket for BOTH providers (a 12h segment is weight
 * 0.5). Writing only the linkage would leave the partner deriving a whole call
 * in that bucket and quietly asking for a second one.
 */
export function applySplitTwelveHour(
  rows: readonly PanelRow[],
  cellText: Readonly<Record<string, string>>,
  opts: { selfId: string; partnerId: string; bucket: BucketKey },
): SplitTwelveHourEdit {
  const self = rows.find(r => r.providerId === opts.selfId);
  const partner = rows.find(r => r.providerId === opts.partnerId);
  if (!self) throw new Error(`applySplitTwelveHour: no panel row for provider ${opts.selfId}`);
  if (!partner) throw new Error(`applySplitTwelveHour: no panel row for provider ${opts.partnerId}`);
  if (self.providerId === partner.providerId) {
    throw new Error('applySplitTwelveHour: a call cannot be split with oneself');
  }
  bucketToSlotRef(opts.bucket); // validates the bucket is nameable; throws otherwise

  const linkage = splitTwelveHourLinkage(self.displayName, [partner.displayName], {
    source: splitSourceText(self.displayName, partner.displayName, opts.bucket),
    details: `${BUCKET_LABELS[opts.bucket]} 12/12 split`,
  });
  return {
    rows: rows.map(r => (r.providerId === opts.selfId ? replaceLinkage(r, 'split-12h', linkage) : r)),
    cellText: {
      ...cellText,
      [cellKey(opts.selfId, opts.bucket)]: '0.5',
      [cellKey(opts.partnerId, opts.bucket)]: '0.5',
    },
  };
}

/** Removes the split linkage only. The two 0.5 cells are LEFT ALONE on
 * purpose: they are ordinary typed targets now, and silently reverting numbers
 * he can see is worse than leaving them for him to clear. */
export function clearSplitTwelveHour(rows: readonly PanelRow[], selfId: string): PanelRow[] {
  return rows.map(r => (r.providerId === selfId ? replaceLinkage(r, 'split-12h', null) : r));
}

// ── summary ──────────────────────────────────────────────────────────────────

export interface PanelSummary {
  /** Rows ON THE PANEL — the call pool plus any stored out-of-pool row. NOT
   * the number written: see writtenProviderCount. */
  providerCount: number;
  /**
   * Rows that will actually land in the manifest's `providers[]`. Counted with
   * blockTargets.statedProviders — the same function buildBlockManifest writes
   * from, so the footer cannot promise a different blast radius than the save
   * delivers. Everyone else is absent and keeps ordinary FTE targets.
   */
  writtenProviderCount: number;
  /** Their provider ids, so the panel can mark exactly those rows. */
  writtenProviderIds: string[];
  /** Rows with at least one typed cell or a linkage. Differs from
   * writtenProviderCount at the edges: an imported row carrying only
   * prohibitions is written but was never touched here, and a split partner can
   * be pulled in by name alone. */
  touchedProviderCount: number;
  typedCellCount: number;
  linkageCount: number;
  /** resolveTargets warnings across every row, prefixed with the provider. */
  warnings: string[];
}

/** What the footer states before he saves. Rows must already carry their live
 * overrides (rowsWithCellText). */
export function summarizePanel(
  rows: readonly PanelRow[],
  basis: DerivationBasis,
): PanelSummary {
  let typedCellCount = 0;
  let touchedProviderCount = 0;
  let linkageCount = 0;
  const warnings: string[] = [];
  for (const row of rows) {
    const resolved = resolveTargets(row, basis);
    const links = row.linkages?.length ?? 0;
    typedCellCount += resolved.overridden.length;
    linkageCount += links;
    if (resolved.overridden.length > 0 || links > 0) touchedProviderCount += 1;
    for (const w of resolved.warnings) warnings.push(`${row.displayName}: ${w}`);
  }
  const written = statedProviders(rows).written;
  return {
    providerCount: rows.length,
    writtenProviderCount: written.length,
    writtenProviderIds: written.map(r => r.providerId),
    touchedProviderCount,
    typedCellCount,
    linkageCount,
    warnings,
  };
}
