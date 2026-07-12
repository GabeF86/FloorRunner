import type { BadgeTone } from './Badge';

/**
 * Single source of truth for schedule-status Badge presentation.
 *
 * Three pages (dashboard, schedules list, schedule detail) previously carried
 * near-identical local maps that drifted: draft was neutral/neutral/warn,
 * review was info/warn/absent, and only the detail page knew `locked`
 * (as danger). Unified semantics, chosen so tones carry meaning consistently:
 *
 *   published        → ok       (live, the good resting state)
 *   review / revised → warn     (in-flight, needs scheduler attention)
 *   draft / archived → neutral  (resting states — a draft is normal work in
 *                                progress, not a fault, so not warn)
 *   locked           → info     (immutability is informational, not an
 *                                error, so not danger)
 *
 * Unknown statuses fall back to neutral.
 */

/** Canonical workflow statuses, in lifecycle order (filter dropdowns etc.). */
export const SCHEDULE_STATUSES = ['draft', 'review', 'published', 'revised', 'archived'] as const;

const TONES: Record<string, BadgeTone> = {
  draft: 'neutral',
  review: 'warn',
  published: 'ok',
  revised: 'warn',
  archived: 'neutral',
  locked: 'info',
};

export function scheduleStatusTone(status: string): BadgeTone {
  return TONES[status] ?? 'neutral';
}

/** Display label for a schedule status (capitalized raw status). */
export function scheduleStatusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
