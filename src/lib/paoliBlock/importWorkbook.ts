/**
 * Paoli block workbook import orchestrator — pure (bytes + roster in,
 * manifest + report data out). No DB access and no engine coupling; the
 * manifest is the contract the engine-extension phase consumes.
 */

import { readXlsx, cellValue } from './xlsx';
import { locateTargetSheet, type LocatedSheet } from './locateSheet';
import { matchRoster, normalizeName, type RosterEntry } from './names';
import { parseConstraintText } from './constraints';
import { compareChecksums, computeChecksums, type ChecksumRow } from './checksums';
import {
  BUCKET_KEYS,
  PAOLI_BLOCK_MANIFEST_VERSION,
  validateManifest,
  type BucketKey,
  type ChecksumReport,
  type ChecksumValues,
  type PaoliBlockManifest,
  type ProviderManifest,
} from './manifest';

export interface ImportOptions {
  /** Label recorded in the manifest (workbook filename/path). */
  workbookLabel: string;
  roster: RosterEntry[];
  expectedChecksums?: ChecksumValues | null;
  defaultYear?: number;
}

export interface ImportResult {
  /** Present unless the workbook itself was unreadable/unlocatable. */
  manifest: PaoliBlockManifest | null;
  checksums: ChecksumReport;
  /** Hard import errors — a nonempty list must fail the import. */
  hardErrors: string[];
  warnings: string[];
}

interface RawRow {
  rowNumber: number;
  sourceName: string;
  fte: number;
  targets: Record<BucketKey, number>;
  noCallText: string | null;
  mandatoryText: string | null;
}

const CALL_CODE_LEGEND: Record<string, string> = {
  C1: 'Paoli first call (map to the canonical engine shift id in the engine-extension phase)',
  C2: 'Paoli late/second call (map to the canonical engine shift id in the engine-extension phase)',
  NEURO: 'Paoli Neuro/C3 weekend call (map to the canonical engine shift id in the engine-extension phase)',
};

const MAX_DATA_ROWS = 200;

function extractRows(
  wb: ReturnType<typeof readXlsx>,
  located: LocatedSheet,
  hardErrors: string[],
): RawRow[] {
  const sheet = wb.sheets.find((s) => s.name === located.sheetName)!;
  const rows: RawRow[] = [];
  for (let r = located.dataStartRow; r < located.dataStartRow + MAX_DATA_ROWS; r++) {
    const nameVal = cellValue(sheet, located.nameCol, r);
    if (typeof nameVal !== 'string' || !nameVal.trim()) break; // end of data block
    if (/^totals?$/i.test(nameVal.trim())) break;

    const fteVal = cellValue(sheet, located.fteCol, r);
    if (typeof fteVal !== 'number') {
      hardErrors.push(`row ${r}: provider "${nameVal}" has a non-numeric FTE cell`);
      continue;
    }

    const targets = {} as Record<BucketKey, number>;
    let rowOk = true;
    for (const key of BUCKET_KEYS) {
      const v = cellValue(sheet, located.buckets[key], r);
      if (v === null) targets[key] = 0;
      else if (typeof v === 'number') targets[key] = v;
      else {
        hardErrors.push(
          `row ${r}: provider "${nameVal}" has a non-numeric ${key} target (${JSON.stringify(v)})`,
        );
        rowOk = false;
      }
    }
    if (!rowOk) continue;

    const readText = (col: number | null): string | null => {
      if (col === null) return null;
      const v = cellValue(sheet, col, r);
      if (v === null) return null;
      if (typeof v !== 'string') {
        hardErrors.push(
          `row ${r}: provider "${nameVal}" has a non-text value in a free-text constraint column (${JSON.stringify(v)})`,
        );
        return null;
      }
      return v;
    };

    rows.push({
      rowNumber: r,
      sourceName: nameVal,
      fte: fteVal,
      targets,
      noCallText: readText(located.noCallCol),
      mandatoryText: readText(located.mandatoryCol),
    });
  }
  return rows;
}

export function importPaoliBlockWorkbook(
  bytes: Buffer | Uint8Array,
  opts: ImportOptions,
): ImportResult {
  const defaultYear = opts.defaultYear ?? 2026;
  const hardErrors: string[] = [];
  const warnings: string[] = [];
  const emptyChecksums = compareChecksums(computeChecksums([]), null);

  let wb: ReturnType<typeof readXlsx>;
  try {
    wb = readXlsx(bytes);
  } catch (e) {
    return {
      manifest: null,
      checksums: emptyChecksums,
      hardErrors: [`unreadable workbook: ${e instanceof Error ? e.message : String(e)}`],
      warnings,
    };
  }

  const { located, errors: locateErrors, warnings: locateWarnings } = locateTargetSheet(wb);
  warnings.push(...locateWarnings);
  if (!located) {
    return { manifest: null, checksums: emptyChecksums, hardErrors: locateErrors, warnings };
  }

  const rows = extractRows(wb, located, hardErrors);
  const { matches, errors: nameErrors } = matchRoster(
    rows.map((r) => r.sourceName),
    opts.roster,
  );
  hardErrors.push(...nameErrors);

  const rosterNames = opts.roster.map((r) => r.name);
  const providers: ProviderManifest[] = rows.map((row, i) => {
    const match = matches[i];
    const parsed = parseConstraintText({
      noCallText: row.noCallText,
      mandatoryText: row.mandatoryText,
      defaultYear,
      providerName: row.sourceName.trim(),
      rosterNames,
    });
    return {
      providerId: match.providerId,
      sourceName: row.sourceName,
      normalizedName: match.normalized,
      scenarioFte: row.fte,
      targets: row.targets,
      prohibitions: parsed.prohibitions,
      fixedAssignments: parsed.fixedAssignments,
      linkages: parsed.linkages,
      preferences: parsed.preferences,
      sourceText: { noCall: row.noCallText, mandatory: row.mandatoryText },
      warnings: parsed.warnings,
      conflicts: parsed.conflicts,
    };
  });

  const checksumRows: ChecksumRow[] = rows.map((r) => ({ fte: r.fte, targets: r.targets }));
  const checksums = compareChecksums(
    computeChecksums(checksumRows),
    opts.expectedChecksums ?? null,
  );

  const manifest: PaoliBlockManifest = {
    manifestVersion: PAOLI_BLOCK_MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      workbook: opts.workbookLabel,
      sheetName: located.sheetName,
      shape: located.shape,
    },
    defaultYear,
    callCodeLegend: CALL_CODE_LEGEND,
    checksums,
    providers,
    warnings,
    errors: hardErrors,
  };

  // Self-check: an invalid manifest here is an importer bug and must be loud
  // (never hand the engine phase a malformed contract).
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    hardErrors.push(
      ...validation.errors.map((e) => `internal: produced manifest failed validation: ${e}`),
    );
    manifest.errors = hardErrors;
  }

  return { manifest, checksums, hardErrors, warnings };
}

export { normalizeName };
