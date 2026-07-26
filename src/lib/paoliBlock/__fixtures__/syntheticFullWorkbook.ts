/**
 * Synthetic FULL-SHAPE workbook fixture for the Paoli 8/10–10/25 block import.
 *
 * Mirrors the real full workbook described in
 * Claude_Code_Paoli_Call_Schedule_Prompt.md: worksheet named `Sheet4`
 * (deliberately NOT first — a decoy sheet proves header-based location),
 * two header rows, provider data in columns A:M:
 *   A name, B FTE, C/D M-Th C1/C2, E/F Fri C1/C2, G/H Sat C1/C2,
 *   I/J Sun C1/C2, K Neuro F/S/S, L no-call free text, M mandatory free text.
 *
 * Contains EVERY provider-specific constraint enumerated in the prompt's
 * "Provider-specific instructions" section, including `Simon ` with a
 * trailing space, and column totals that match the prompt's import
 * checksums exactly (rows 10, FTE 8.75, M-Th C1 35, M-Th C2 35, Fri C1 9,
 * Fri C2 8, Sat C1 8, Sat C2 6, Sun C1 8.5, Sun C2 8, Neuro 10).
 */

import { buildXlsxBytes, type FixtureCell } from './buildXlsx';

export interface SyntheticProviderRow {
  name: string;
  fte: number;
  /** [MTH_C1, MTH_C2, FRI_C1, FRI_C2, SAT_C1, SAT_C2, SUN_C1, SUN_C2, NEURO_FSS] */
  targets: number[];
  noCall: string;
  mandatory: string;
}

export const SYNTHETIC_PROVIDERS: SyntheticProviderRow[] = [
  {
    name: 'Amusa',
    fte: 1,
    targets: [4, 4, 1, 1, 1, 1, 1, 1, 1],
    noCall: '8/13 C1, 8/24 C1, 9/18 F/S/S',
    mandatory: '',
  },
  {
    name: 'Farkas',
    fte: 1,
    targets: [4, 4, 1, 1, 1, 1, 1, 1, 1],
    noCall: 'No call 9/11-9/13 and 9/20-9/21',
    mandatory: '',
  },
  {
    name: 'Kalawadia',
    fte: 1,
    targets: [4, 4, 1, 1, 1, 1, 1, 1, 1],
    noCall: 'No Monday C1. Prefers Tuesday for C1.',
    mandatory: '',
  },
  {
    name: 'Mojica',
    fte: 1,
    targets: [4, 4, 1, 1, 1, 0.5, 1, 1, 1],
    noCall: 'No call 9/11-9/13, 9/18-9/20, and 10/17',
    mandatory: 'Must be C1 on 9/7.',
  },
  {
    name: 'Lin',
    fte: 1,
    targets: [4, 4, 1, 1, 1, 0.5, 1, 0.5, 1],
    noCall: '',
    mandatory: 'Must be C1 on 9/4 and Neuro on 9/5 and 9/6.',
  },
  {
    name: 'Havildar',
    fte: 0.75,
    targets: [3, 3, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 1],
    noCall: 'No call 9/18-9/20.',
    mandatory:
      'Neuro obligation is exactly one Saturday/Sunday Neuro pair on the same weekend, no additional Neuro dates.',
  },
  {
    name: 'Horan',
    fte: 0.5,
    targets: [2, 2, 1, 0, 0.5, 0, 1, 0.5, 1],
    noCall: '',
    mandatory:
      'Must be C1 on 9/5 and C2 on 9/6. His Friday C1 must be on the same weekend as his Saturday/Sunday Neuro.',
  },
  {
    name: 'Simon ', // trailing space is deliberate (matches the real workbook)
    fte: 0.75,
    targets: [3, 3, 1, 0.5, 1, 0.5, 1, 1, 1],
    noCall: 'No call 9/11-9/13.',
    mandatory:
      'Saturday C1 and Sunday C2 must be on the same weekend. ' +
      'He covers the 12 hour night portion of the Sunday when Horan covers the 12 hour day portion. ' +
      'His Neuro obligation is exactly one Saturday/Sunday pair, ideally on the same weekend as his Friday C1.',
  },
  {
    name: 'Hussain',
    fte: 0.75,
    targets: [3, 3, 0, 1, 0, 0, 0, 0.5, 1],
    noCall: '',
    mandatory:
      'Friday C2 is combined with Friday Neuro and must be on the same weekend as his Saturday/Sunday Neuro. ' +
      'Must take either one Saturday or one Sunday call.',
  },
  {
    name: 'Jones',
    fte: 1,
    targets: [4, 4, 1, 1, 1, 1, 1, 1, 1],
    noCall: 'No call 9/5 (Friday), 9/6, 9/7.', // 2026-09-05 is a SATURDAY — wrong weekday word on purpose
    mandatory: 'Must be C2 on 9/5, C1 on 9/6, and C2 on 9/7.',
  },
];

export function buildSyntheticFullWorkbook(): Buffer {
  const rows: FixtureCell[][] = [
    // Row 1 — day-group labels above the C1/C2 pairs.
    ['', '', 'M-Th', '', 'Friday', '', 'Saturday', '', 'Sunday', '', '', '', ''],
    // Row 2 — subheaders.
    [
      'Provider',
      'FTE',
      'C1',
      'C2',
      'C1',
      'C2',
      'C1',
      'C2',
      'C1',
      'C2',
      'Neuro F/S/S',
      'No Call Requests',
      'Must Be On Call / Exceptions',
    ],
  ];
  for (const p of SYNTHETIC_PROVIDERS) {
    rows.push([p.name, p.fte, ...p.targets, p.noCall, p.mandatory]);
  }
  rows.push([]); // row 13 blank — terminates the data block
  rows.push(['', 8.75]); // row 14 totals (name cell empty; must NOT import as a provider)

  return buildXlsxBytes([
    {
      name: 'Sheet1',
      rows: [['Notes'], ['This decoy sheet has no call grid headers.']],
    },
    { name: 'Sheet4', rows },
  ]);
}

/** Roster used by the paoliBlock tests: full names prove last-name-token matching. */
export const TEST_ROSTER = [
  { id: 'prov-amusa', name: 'Amusa' },
  { id: 'prov-farkas', name: 'Gabriel Farkas' },
  { id: 'prov-kalawadia', name: 'Kalawadia' },
  { id: 'prov-mojica', name: 'Mojica' },
  { id: 'prov-lin', name: 'Lin' },
  { id: 'prov-havildar', name: 'Havildar' },
  { id: 'prov-horan', name: 'Horan' },
  { id: 'prov-simon', name: 'Simon' },
  { id: 'prov-hussain', name: 'Hussain' },
  { id: 'prov-jones', name: 'Jones' },
];
