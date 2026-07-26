/**
 * Paoli block-import MANIFEST — the versioned contract between this import
 * layer and the engine-extension phase that will consume it.
 *
 * Everything the engine phase needs from the workbook lives here:
 * scenario FTEs, per-bucket call-category targets, normalized prohibitions
 * (date-specific and recurring), fixed mandatory assignments, linkage
 * constraints (same-weekend / same-date / 12h-split / either-or), soft
 * preferences, plus the original source text and every parser warning and
 * conflict so nothing is silently dropped.
 *
 * Call codes are workbook-level (`C1`/`C2`/`NEURO`); mapping to the
 * canonical Paoli shift identifiers (e.g. C1 → pPaoliCall) is deliberately
 * deferred to the engine phase — see `callCodeLegend`.
 *
 * Linkage/preference members use a small slot-descriptor grammar:
 *   `FRI:C1`, `SAT:NEURO`, `SUN:ANY`  — weekday-scoped slots
 *   `2026-09-05:C2`                    — date-scoped slots
 *   provider display names             — only for kind `split-12h`
 */

import { z } from 'zod';

export const PAOLI_BLOCK_MANIFEST_VERSION = 1 as const;

export const BUCKET_KEYS = [
  'MTH_C1',
  'MTH_C2',
  'FRI_C1',
  'FRI_C2',
  'SAT_C1',
  'SAT_C2',
  'SUN_C1',
  'SUN_C2',
  'NEURO_FSS',
] as const;
export type BucketKey = (typeof BUCKET_KEYS)[number];

export const CALL_CODES = ['C1', 'C2', 'NEURO'] as const;
export type CallCode = (typeof CALL_CODES)[number];

export const WEEKDAY_CODES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');

const callCodesField = z.union([z.literal('all'), z.array(z.enum(CALL_CODES)).min(1)]);

const prohibitionSchema = z
  .object({
    dates: z.array(isoDate).min(1).optional(),
    recurrence: z.object({ weekday: z.enum(WEEKDAY_CODES) }).optional(),
    callCodes: callCodesField,
    source: z.string(),
  })
  .refine((p) => (p.dates ? !p.recurrence : !!p.recurrence), {
    message: 'prohibition must have exactly one of dates or recurrence',
  });

const fixedAssignmentSchema = z.object({
  date: isoDate,
  code: z.enum(CALL_CODES),
  source: z.string(),
});

export const LINKAGE_KINDS = ['same-weekend', 'same-date', 'split-12h', 'either-or'] as const;

const linkageSchema = z.object({
  kind: z.enum(LINKAGE_KINDS),
  members: z.array(z.string()).min(1),
  details: z.string().optional(),
  source: z.string(),
});

const preferenceSchema = z.object({
  kind: z.enum(['weekday', 'same-weekend', 'other']),
  weekday: z.enum(WEEKDAY_CODES).optional(),
  callCodes: z.array(z.enum(CALL_CODES)).optional(),
  members: z.array(z.string()).optional(),
  source: z.string(),
});

const conflictSchema = z.object({
  kind: z.enum(['mandatory-vs-prohibition']),
  date: isoDate,
  code: z.union([z.enum(CALL_CODES), z.literal('all')]),
  resolution: z.enum(['mandatory-retained']),
  sources: z.array(z.string()).min(1),
});

const targetsSchema = z.record(z.enum(BUCKET_KEYS), z.number());

const providerSchema = z.object({
  providerId: z.string().nullable(),
  sourceName: z.string(),
  normalizedName: z.string(),
  scenarioFte: z.number().nonnegative(),
  targets: targetsSchema,
  prohibitions: z.array(prohibitionSchema),
  fixedAssignments: z.array(fixedAssignmentSchema),
  linkages: z.array(linkageSchema),
  preferences: z.array(preferenceSchema),
  sourceText: z.object({
    noCall: z.string().nullable(),
    mandatory: z.string().nullable(),
  }),
  warnings: z.array(z.string()),
  conflicts: z.array(conflictSchema),
});

const checksumValuesSchema = z.object({
  providerRows: z.number(),
  totalFte: z.number(),
  targets: targetsSchema,
});

const checksumReportSchema = z.object({
  computed: checksumValuesSchema,
  expected: checksumValuesSchema.nullable(),
  comparisons: z.array(
    z.object({
      key: z.string(),
      expected: z.number(),
      actual: z.number(),
      ok: z.boolean(),
    }),
  ),
  ok: z.boolean().nullable(),
});

export const paoliBlockManifestSchema = z.object({
  manifestVersion: z.literal(PAOLI_BLOCK_MANIFEST_VERSION),
  generatedAt: z.string(),
  source: z.object({
    workbook: z.string(),
    sheetName: z.string(),
    shape: z.enum(['full', 'grid']),
  }),
  defaultYear: z.number().int(),
  callCodeLegend: z.record(z.string(), z.string()),
  checksums: checksumReportSchema,
  providers: z.array(providerSchema),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});

export type Prohibition = z.infer<typeof prohibitionSchema>;
export type FixedAssignment = z.infer<typeof fixedAssignmentSchema>;
export type Linkage = z.infer<typeof linkageSchema>;
export type Preference = z.infer<typeof preferenceSchema>;
export type Conflict = z.infer<typeof conflictSchema>;
export type ProviderManifest = z.infer<typeof providerSchema>;
export type ChecksumValues = z.infer<typeof checksumValuesSchema>;
export type ChecksumReport = z.infer<typeof checksumReportSchema>;
export type PaoliBlockManifest = z.infer<typeof paoliBlockManifestSchema>;

/** JSON-schema-ish structural validation; returns human-readable errors. */
export function validateManifest(value: unknown): { ok: boolean; errors: string[] } {
  const res = paoliBlockManifestSchema.safeParse(value);
  if (res.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
