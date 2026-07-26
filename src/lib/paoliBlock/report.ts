/**
 * Human-readable import report for a Paoli block manifest — written next to
 * the manifest JSON by scripts/importPaoliBlock.ts so Gabriel can eyeball
 * exactly what was imported, every checksum comparison, and every
 * warning/conflict before anything touches the engine.
 */

import { BUCKET_KEYS, type PaoliBlockManifest } from './manifest';

function pad(s: string | number, width: number): string {
  const str = String(s);
  return str.length >= width ? str : ' '.repeat(width - str.length) + str;
}

function padRight(s: string | number, width: number): string {
  const str = String(s);
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

export function renderImportReport(manifest: PaoliBlockManifest): string {
  const lines: string[] = [];
  const rule = '='.repeat(72);
  lines.push(rule);
  lines.push('PAOLI BLOCK IMPORT REPORT');
  lines.push(rule);
  lines.push(`workbook:   ${manifest.source.workbook}`);
  lines.push(`worksheet:  ${manifest.source.sheetName} (located by headers; shape: ${manifest.source.shape})`);
  lines.push(`generated:  ${manifest.generatedAt}`);
  lines.push(`defaultYear:${manifest.defaultYear}  manifestVersion: ${manifest.manifestVersion}`);
  lines.push('');

  // Providers
  lines.push(`PROVIDERS (${manifest.providers.length})`);
  lines.push(
    padRight('name', 14) +
      padRight('provider id', 18) +
      pad('FTE', 6) +
      BUCKET_KEYS.map((k) => pad(k.replace('_', ' '), 9)).join(''),
  );
  for (const p of manifest.providers) {
    lines.push(
      padRight(JSON.stringify(p.sourceName), 14) +
        padRight(p.providerId ?? 'UNMATCHED', 18) +
        pad(p.scenarioFte, 6) +
        BUCKET_KEYS.map((k) => pad(p.targets[k] ?? 0, 9)).join(''),
    );
  }
  lines.push('');

  // Checksums
  lines.push('CHECKSUMS');
  if (manifest.checksums.expected === null) {
    lines.push('  (no expected checksums supplied — computed values only)');
    lines.push(`  provider_rows = ${manifest.checksums.computed.providerRows}`);
    lines.push(`  total_fte     = ${manifest.checksums.computed.totalFte}`);
    for (const k of BUCKET_KEYS) {
      lines.push(`  ${padRight(k, 13)} = ${manifest.checksums.computed.targets[k]}`);
    }
  } else {
    lines.push(
      padRight('  key', 17) + pad('expected', 10) + pad('actual', 10) + '   result',
    );
    for (const c of manifest.checksums.comparisons) {
      lines.push(
        padRight(`  ${c.key}`, 17) +
          pad(c.expected, 10) +
          pad(c.actual, 10) +
          `   ${c.ok ? 'OK' : 'MISMATCH'}`,
      );
    }
    lines.push(
      `  => ${
        manifest.checksums.ok
          ? 'ALL CHECKSUMS MATCH'
          : `${manifest.checksums.comparisons.filter((c) => !c.ok).length} MISMATCH(ES) — review before generation`
      }`,
    );
  }
  lines.push('');

  // Constraints per provider
  lines.push('CONSTRAINTS');
  let anyConstraint = false;
  for (const p of manifest.providers) {
    const blocks: string[] = [];
    for (const pr of p.prohibitions) {
      const scope = pr.dates
        ? pr.dates.length > 3
          ? `${pr.dates[0]}..${pr.dates[pr.dates.length - 1]}`
          : pr.dates.join(', ')
        : `every ${pr.recurrence!.weekday}`;
      const codes = pr.callCodes === 'all' ? 'ALL call types' : pr.callCodes.join('+');
      blocks.push(`    no-call   ${scope} — ${codes}   [${pr.source}]`);
    }
    for (const fa of p.fixedAssignments) {
      blocks.push(`    fixed     ${fa.date} ${fa.code}   [${fa.source}]`);
    }
    for (const l of p.linkages) {
      blocks.push(
        `    linkage   ${l.kind}: ${l.members.join(' + ')}${l.details ? ` (${l.details})` : ''}   [${l.source}]`,
      );
    }
    for (const pref of p.preferences) {
      const what =
        pref.kind === 'weekday'
          ? `${pref.weekday}${pref.callCodes ? ` ${pref.callCodes.join('+')}` : ''}`
          : pref.kind === 'same-weekend'
            ? `same weekend as ${pref.members?.join(' + ') ?? '(context)'}`
            : '(see source)';
      blocks.push(`    soft      ${pref.kind}: ${what}   [${pref.source}]`);
    }
    for (const c of p.conflicts) {
      blocks.push(
        `    CONFLICT  ${c.date} ${c.code}: mandatory vs no-call — ${c.resolution} (${c.sources.join(' | ')})`,
      );
    }
    for (const w of p.warnings) blocks.push(`    warning   ${w}`);
    if (blocks.length) {
      anyConstraint = true;
      lines.push(`  ${p.sourceName.trim()}:`);
      lines.push(...blocks);
    }
  }
  if (!anyConstraint) lines.push('  (none — no free-text constraint columns in this shape)');
  lines.push('');

  // Workbook-level warnings/errors
  if (manifest.warnings.length) {
    lines.push('WORKBOOK WARNINGS');
    for (const w of manifest.warnings) lines.push(`  - ${w}`);
    lines.push('');
  }
  lines.push(manifest.errors.length ? 'HARD ERRORS (import FAILED)' : 'HARD ERRORS: none');
  for (const e of manifest.errors) lines.push(`  - ${e}`);
  lines.push(rule);
  return lines.join('\n') + '\n';
}
