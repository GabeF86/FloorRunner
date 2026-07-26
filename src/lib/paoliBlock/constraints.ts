/**
 * Free-text constraint parser for the Paoli block workbook — implements the
 * prompt's "Normalize the free-text constraints" + "parsing rules" sections
 * exactly:
 *
 *  - Column L text inherits NO-CALL/PROHIBITION semantics even when it only
 *    lists a date and call type ("8/13 C1" prohibits C1 on 2026-08-13).
 *  - Column M text inherits MANDATORY/EXCEPTION semantics.
 *  - `prefers` / `ideally` mark soft preferences (in either column).
 *  - ISO dates; an omitted year defaults to the caller's defaultYear (2026).
 *  - The weekday is ALWAYS derived from the date. A weekday word that
 *    contradicts its date surfaces as a warning and the DATE wins.
 *  - Ranges ("9/11-9/13", "9/11 through 9/13") are inclusive.
 *  - "9/18 F/S/S" normalizes to the Friday-through-Sunday weekend
 *    (2026-09-18..20) and the normalization is documented in warnings.
 *  - A call-type-specific item ("8/24 C1") prohibits only that call type on
 *    that date; a general "No Call" date/range prohibits all call types.
 *  - A fixed mandatory assignment that collides with a no-call entry is
 *    RETAINED and the collision is recorded as a conflict — neither source
 *    rule is silently erased.
 *
 * Anything non-empty the parser cannot classify becomes an "unparsed"
 * warning, never a silent drop.
 */

import type {
  CallCode,
  Conflict,
  FixedAssignment,
  Linkage,
  Preference,
  Prohibition,
  WeekdayCode,
} from './manifest';

export interface ParseInput {
  noCallText: string | null;
  mandatoryText: string | null;
  defaultYear: number;
  providerName: string;
  /** Display names used to recognize other providers in split instructions. */
  rosterNames?: string[];
}

export interface ParsedConstraints {
  prohibitions: Prohibition[];
  fixedAssignments: FixedAssignment[];
  linkages: Linkage[];
  preferences: Preference[];
  warnings: string[];
  conflicts: Conflict[];
}

// ---------------------------------------------------------------------------
// Date helpers (UTC-only; weekday ALWAYS derived from the date)
// ---------------------------------------------------------------------------

const WEEKDAY_BY_UTC_DAY: WeekdayCode[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const WEEKDAY_FULL: Record<WeekdayCode, string> = {
  MON: 'Monday',
  TUE: 'Tuesday',
  WED: 'Wednesday',
  THU: 'Thursday',
  FRI: 'Friday',
  SAT: 'Saturday',
  SUN: 'Sunday',
};

function toIso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.toISOString().slice(0, 10);
}

export function weekdayOfIso(iso: string): WeekdayCode {
  return WEEKDAY_BY_UTC_DAY[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

function addDaysIso(iso: string, days: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function isoRange(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  for (let d = startIso; d <= endIso; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

function normYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

// ---------------------------------------------------------------------------
// Token scanners
// ---------------------------------------------------------------------------

interface DateItem {
  start: number;
  end: number;
  dates: string[];
  raw: string;
}

interface CodeToken {
  start: number;
  end: number;
  code: CallCode;
}

interface WeekdayToken {
  start: number;
  end: number;
  weekday: WeekdayCode;
  raw: string;
}

const MAX_RANGE_DAYS = 62;

function scanDates(text: string, defaultYear: number, warnings: string[]): DateItem[] {
  const items: DateItem[] = [];
  const re = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    let end = m.index + m[0].length;
    const m1 = parseInt(m[1], 10);
    const d1 = parseInt(m[2], 10);
    const y1 = m[3] ? normYear(parseInt(m[3], 10)) : defaultYear;
    const startIso = toIso(y1, m1, d1);
    if (!startIso) {
      warnings.push(`invalid date "${m[0]}" ignored`);
      continue;
    }

    // Inclusive range? ("9/11-9/13", "9/11 through 9/13", "9/18-20")
    const connector = /^\s*(?:-|–|—|through|thru|to)\s*/i.exec(text.slice(end));
    let dates: string[] | null = null;
    if (connector) {
      const after = text.slice(end + connector[0].length);
      const e = /^(\d{1,2})(?:\/(\d{1,2}))?(?:\/(\d{2,4}))?/.exec(after);
      if (e) {
        let m2: number;
        let d2: number;
        let y2 = defaultYear;
        if (e[2] !== undefined) {
          m2 = parseInt(e[1], 10);
          d2 = parseInt(e[2], 10);
          if (e[3]) y2 = normYear(parseInt(e[3], 10));
        } else {
          m2 = m1;
          d2 = parseInt(e[1], 10);
        }
        let endIso = toIso(y2, m2, d2);
        if (!endIso) {
          warnings.push(`invalid range end "${e[0]}" ignored; using ${startIso} only`);
        } else {
          let lo = startIso;
          let hi = endIso;
          if (hi < lo) {
            warnings.push(`range "${text.slice(start, end + connector[0].length + e[0].length)}" runs backwards; endpoints swapped`);
            [lo, hi] = [hi, lo];
          }
          const span = isoRange(lo, hi);
          if (span.length > MAX_RANGE_DAYS) {
            warnings.push(`range ${lo}..${hi} exceeds ${MAX_RANGE_DAYS} days; ignored as a likely input error`);
            continue;
          }
          dates = span;
          end += connector[0].length + e[0].length;
          re.lastIndex = end;
        }
      }
    }

    if (!dates) {
      // F/S/S weekend shorthand?
      const fss = /^\s*,?\s*\(?F\/S\/S\)?/i.exec(text.slice(end));
      if (fss) {
        const wd = weekdayOfIso(startIso);
        let friday: string;
        if (wd === 'FRI') friday = startIso;
        else if (wd === 'SAT') friday = addDaysIso(startIso, -1);
        else if (wd === 'SUN') friday = addDaysIso(startIso, -2);
        else {
          friday = addDaysIso(
            startIso,
            (5 - new Date(`${startIso}T00:00:00Z`).getUTCDay() + 7) % 7,
          );
          warnings.push(
            `F/S/S anchor ${startIso} is a ${WEEKDAY_FULL[wd]}; used the containing/following weekend starting ${friday}`,
          );
        }
        dates = [friday, addDaysIso(friday, 1), addDaysIso(friday, 2)];
        end += fss[0].length;
        re.lastIndex = end;
        warnings.push(
          `Normalized "${text.slice(start, end).trim()}" to ${dates[0]} through ${dates[2]} (Friday-Sunday weekend)`,
        );
      } else {
        dates = [startIso];
      }
    }

    items.push({ start, end, dates, raw: text.slice(start, end) });
  }
  return items;
}

function scanCodes(text: string): CodeToken[] {
  const out: CodeToken[] = [];
  const re = /\b(?:c\s*([123])|neuro)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const code: CallCode = !m[1] || m[1] === '3' ? 'NEURO' : (`C${m[1]}` as CallCode);
    out.push({ start: m.index, end: m.index + m[0].length, code });
  }
  return out;
}

const WEEKDAY_RE =
  /\b(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?\b/gi;

function scanWeekdays(text: string): WeekdayToken[] {
  const out: WeekdayToken[] = [];
  const re = new RegExp(WEEKDAY_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const weekday = m[1].slice(0, 3).toUpperCase() as WeekdayCode;
    out.push({ start: m.index, end: m.index + m[0].length, weekday, raw: m[0] });
  }
  return out;
}

/** Slot descriptors: "Friday C1" → FRI:C1, "Saturday/Sunday Neuro" → SAT:NEURO + SUN:NEURO. */
function scanDescriptors(text: string): string[] {
  const out: string[] = [];
  const re =
    /\b(fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?:\s*\/\s*(fri(?:day)?|sat(?:urday)?|sun(?:day)?))?\s+(c\s*[123]|neuro)\b/gi;
  let m: RegExpExecArray | null;
  const codeOf = (s: string): CallCode => {
    const c = s.replace(/\s+/g, '').toUpperCase();
    return c === 'NEURO' || c === 'C3' ? 'NEURO' : (c as CallCode);
  };
  while ((m = re.exec(text))) {
    const d1 = m[1].slice(0, 3).toUpperCase();
    const code = codeOf(m[3]);
    out.push(`${d1}:${code}`);
    if (m[2]) out.push(`${m[2].slice(0, 3).toUpperCase()}:${code}`);
  }
  return [...new Set(out)];
}

/** Codeless day/day pattern ("Saturday/Sunday pair") + a code found elsewhere in the segment. */
function pairDescriptors(text: string): string[] {
  const m =
    /\b(fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s*\/\s*(fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i.exec(
      text,
    );
  if (!m) return [];
  const codes = scanCodes(text);
  if (!codes.length) return [];
  const code = codes[0].code;
  return [`${m[1].slice(0, 3).toUpperCase()}:${code}`, `${m[2].slice(0, 3).toUpperCase()}:${code}`];
}

function hasContent(text: string): boolean {
  return /[a-z0-9]{2,}/i.test(text);
}

// ---------------------------------------------------------------------------
// Weekday-word validation: the date always wins
// ---------------------------------------------------------------------------

function validateWeekdayWords(
  weekdays: WeekdayToken[],
  items: DateItem[],
  warnings: string[],
): void {
  if (!items.length) return;
  for (const wt of weekdays) {
    const center = (wt.start + wt.end) / 2;
    let nearest = items[0];
    let best = Infinity;
    for (const item of items) {
      const dist = Math.min(Math.abs(center - item.start), Math.abs(center - item.end));
      if (dist < best) {
        best = dist;
        nearest = item;
      }
    }
    const actual = new Set(nearest.dates.map(weekdayOfIso));
    if (!actual.has(wt.weekday)) {
      const first = nearest.dates[0];
      warnings.push(
        `weekday word "${wt.raw}" does not match ${first}${
          nearest.dates.length > 1 ? `..${nearest.dates[nearest.dates.length - 1]}` : ''
        } (${nearest.dates.map((d) => WEEKDAY_FULL[weekdayOfIso(d)]).join('/')}); the date wins`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Soft-preference split
// ---------------------------------------------------------------------------

function splitSoft(segment: string): { hard: string; soft: string | null } {
  const m = /\bideally\b/i.exec(segment);
  if (m) {
    return {
      hard: segment.slice(0, m.index).replace(/[\s,;]+$/, ''),
      soft: segment.slice(m.index + m[0].length).trim(),
    };
  }
  if (/\bprefer(?:s|red)?\b/i.test(segment)) return { hard: '', soft: segment };
  return { hard: segment, soft: null };
}

function buildPreference(softText: string, source: string): Preference {
  if (/same\s+weekend/i.test(softText)) {
    const members = scanDescriptors(softText);
    return { kind: 'same-weekend', ...(members.length ? { members } : {}), source };
  }
  const weekdays = scanWeekdays(softText);
  if (weekdays.length) {
    const codes = [...new Set(scanCodes(softText).map((c) => c.code))];
    return {
      kind: 'weekday',
      weekday: weekdays[0].weekday,
      ...(codes.length ? { callCodes: codes } : {}),
      source,
    };
  }
  return { kind: 'other', source };
}

// ---------------------------------------------------------------------------
// Column L — prohibition semantics
// ---------------------------------------------------------------------------

function parseNoCallSegment(
  segment: string,
  defaultYear: number,
  out: ParsedConstraints,
): void {
  const { hard, soft } = splitSoft(segment);
  if (soft && hasContent(soft)) out.preferences.push(buildPreference(soft, segment.trim()));
  if (!hasContent(hard)) return;

  const items = scanDates(hard, defaultYear, out.warnings);
  const codes = scanCodes(hard);
  const weekdays = scanWeekdays(hard);
  const source = segment.trim();

  if (items.length) {
    validateWeekdayWords(weekdays, items, out.warnings);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const nextStart = i + 1 < items.length ? items[i + 1].start : Infinity;
      const itemCodes = codes.filter(
        (c) =>
          (c.start >= item.end && c.start < nextStart) ||
          (i === 0 && c.end <= item.start),
      );
      const callCodes = itemCodes.length
        ? [...new Set(itemCodes.map((c) => c.code))]
        : ('all' as const);
      out.prohibitions.push({ dates: item.dates, callCodes, source });
    }
    return;
  }

  // Recurring: "No Monday C1" — weekday word(s), no dates.
  if (weekdays.length && /\bno\b/i.test(hard)) {
    const callCodes = codes.length ? [...new Set(codes.map((c) => c.code))] : ('all' as const);
    for (const wt of weekdays) {
      out.prohibitions.push({ recurrence: { weekday: wt.weekday }, callCodes, source });
    }
    return;
  }

  out.warnings.push(`unparsed no-call text (kept for review, no rule emitted): "${source}"`);
}

// ---------------------------------------------------------------------------
// Column M — mandatory semantics
// ---------------------------------------------------------------------------

function parseMandatorySegment(
  segment: string,
  defaultYear: number,
  providerName: string,
  rosterNames: string[],
  out: ParsedConstraints,
): void {
  const { hard, soft } = splitSoft(segment);
  if (soft && hasContent(soft)) out.preferences.push(buildPreference(soft, segment.trim()));
  if (!hasContent(hard)) return;

  const source = segment.trim();
  let emitted = false;

  // 12-hour split coverage → members are provider names.
  if (/12[\s-]*h(?:ou)?rs?\b/i.test(hard) || /\bsplit\b/i.test(hard)) {
    const self = providerName.trim();
    const others = rosterNames
      .map((n) => n.trim())
      .filter((n) => n && n.toLowerCase() !== self.toLowerCase())
      .filter((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(hard));
    out.linkages.push({
      kind: 'split-12h',
      members: [self, ...new Set(others)],
      details: hard.trim(),
      source,
    });
    emitted = true;
  }

  // Either/or.
  const eitherM = /\beither\b([\s\S]*?)\bor\b([\s\S]*)$/i.exec(hard);
  if (eitherM) {
    const branchMember = (branch: string): string | null => {
      const desc = scanDescriptors(branch);
      if (desc.length) return desc[0];
      const wd = scanWeekdays(branch);
      if (wd.length) return `${wd[0].weekday}:ANY`;
      return null;
    };
    const b1 = branchMember(eitherM[1]);
    const b2 = branchMember(eitherM[2]);
    if (b1 && b2) {
      out.linkages.push({ kind: 'either-or', members: [b1, b2], source });
      emitted = true;
    }
  }

  // Same-date ("combined with", "same day/date").
  if (/\bcombined\b|\bsame\s+(day|date)\b/i.test(hard)) {
    const desc = scanDescriptors(hard);
    if (desc.length >= 2) {
      const day = desc[0].split(':')[0];
      const members = desc.filter((d) => d.startsWith(`${day}:`));
      if (members.length >= 2) {
        out.linkages.push({ kind: 'same-date', members, source });
        emitted = true;
      }
    }
  }

  // Same-weekend (explicit phrase, or a "Saturday/Sunday … pair").
  const hasPair =
    /\bpair\b/i.test(hard) &&
    /\b(fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s*\/\s*(fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i.test(
      hard,
    );
  if (/same\s+weekend/i.test(hard) || hasPair) {
    let members = scanDescriptors(hard);
    if (!members.length) members = pairDescriptors(hard);
    if (members.length >= 2) {
      const details: string[] = [];
      if (/\b(exactly|only)\s+one\b/i.test(hard)) details.push('exactly-one-pair');
      if (/\bno\s+additional\b/i.test(hard)) details.push('no additional dates');
      out.linkages.push({
        kind: 'same-weekend',
        members,
        ...(details.length ? { details: details.join('; ') } : {}),
        source,
      });
      emitted = true;
    }
  }

  // Fixed assignments: pair call codes to dates in reading order.
  const faCountBefore = out.fixedAssignments.length;
  const items = scanDates(hard, defaultYear, out.warnings);
  if (items.length) {
    validateWeekdayWords(scanWeekdays(hard), items, out.warnings);
    const codes = scanCodes(hard);
    const tokens: Array<
      { kind: 'code'; start: number; code: CallCode } | { kind: 'date'; start: number; item: DateItem }
    > = [
      ...codes.map((c) => ({ kind: 'code' as const, start: c.start, code: c.code })),
      ...items.map((item) => ({ kind: 'date' as const, start: item.start, item })),
    ].sort((a, b) => a.start - b.start);

    let pendingCode: CallCode | null = null;
    const held: DateItem[] = [];
    for (const tok of tokens) {
      if (tok.kind === 'code') {
        if (held.length) {
          for (const item of held.splice(0)) {
            for (const date of item.dates) {
              out.fixedAssignments.push({ date, code: tok.code, source });
            }
          }
        }
        pendingCode = tok.code;
      } else if (pendingCode) {
        for (const date of tok.item.dates) {
          out.fixedAssignments.push({ date, code: pendingCode, source });
        }
      } else {
        held.push(tok.item);
      }
    }
    if (held.length) {
      out.warnings.push(
        `mandatory text lists date(s) ${held
          .map((h) => h.dates.join(','))
          .join('; ')} without a call code: "${source}"`,
      );
    }
    if (out.fixedAssignments.length > faCountBefore) emitted = true;
  }

  if (!emitted && !(soft && hasContent(soft))) {
    out.warnings.push(`unparsed mandatory text (kept for review, no rule emitted): "${source}"`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function segments(text: string): string[] {
  return text
    .split(/[.;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseConstraintText(input: ParseInput): ParsedConstraints {
  const out: ParsedConstraints = {
    prohibitions: [],
    fixedAssignments: [],
    linkages: [],
    preferences: [],
    warnings: [],
    conflicts: [],
  };
  const rosterNames = input.rosterNames ?? [];

  if (input.noCallText && input.noCallText.trim()) {
    for (const seg of segments(input.noCallText)) {
      parseNoCallSegment(seg, input.defaultYear, out);
    }
  }
  if (input.mandatoryText && input.mandatoryText.trim()) {
    for (const seg of segments(input.mandatoryText)) {
      parseMandatorySegment(seg, input.defaultYear, input.providerName, rosterNames, out);
    }
  }

  // Mandatory vs no-call collisions: mandatory wins, conflict recorded,
  // neither rule erased (constraint-precedence rule 2 over rule 3).
  for (const fa of out.fixedAssignments) {
    for (const p of out.prohibitions) {
      const dateHit = p.dates
        ? p.dates.includes(fa.date)
        : p.recurrence!.weekday === weekdayOfIso(fa.date);
      const codeHit = p.callCodes === 'all' || p.callCodes.includes(fa.code);
      if (dateHit && codeHit) {
        out.conflicts.push({
          kind: 'mandatory-vs-prohibition',
          date: fa.date,
          code: fa.code,
          resolution: 'mandatory-retained',
          sources: [`no-call: ${p.source}`, `mandatory: ${fa.source}`],
        });
      }
    }
  }

  return out;
}
