/* ───────────────────────────────────────────────────────────────────────────
 * The group handbook — pure logic behind the reference page.
 *
 * Rates, the hiring pipeline and the document library. Three small problems,
 * each with the same shape: a table of rows, and a question about them that
 * people currently answer by email.
 *
 *   "What is the current rate, and when did it move?"     resolveRates
 *   "Where does each candidate stand, and what is late?"  groupCandidates
 *   "Who is allowed to open this?"                        ACCESS_LABEL
 * ─────────────────────────────────────────────────────────────────────────── */

// ── Rates ──────────────────────────────────────────────────────────────────

export interface RateRow {
  id: string;
  site_id?: string | null;
  label: string;
  amount_cents: number | string;
  unit?: string | null;
  effective_date: string;
  notes?: string | null;
}

export interface RateLine {
  id: string;
  label: string;
  siteId: string | null;
  amountCents: number;
  unit: string;
  effectiveDate: string;
  /** The row this one replaced, when there is one. Drives the "↑ since" mark
   *  that answers half the question people actually email about. */
  previous: { amountCents: number; effectiveDate: string } | null;
  /** Rows dated AFTER today — agreed but not yet in force. Shown as pending
   *  rather than silently applied, because billing against a rate that starts
   *  next month is exactly the mistake this table exists to prevent. */
  pending: { amountCents: number; effectiveDate: string } | null;
  notes: string | null;
}

/** PostgREST hands bigint back as a string. */
function cents(v: number | string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? (n as number) : 0;
}

/**
 * Collapse the append-only rate log into one line per rate.
 *
 * CURRENT is the latest row dated on or before `today` — never simply the
 * latest row, or a raise agreed in March for July would be billed in April.
 * A rate whose every row is in the future has no current amount and is
 * reported as pending with `amountCents` 0 and `effectiveDate` unset rather
 * than borrowing tomorrow's number.
 */
export function resolveRates(rows: ReadonlyArray<RateRow>, today: string): RateLine[] {
  const byKey = new Map<string, RateRow[]>();
  for (const r of rows) {
    const key = `${r.site_id ?? ''}|${r.label}`;
    const list = byKey.get(key);
    if (list) list.push(r); else byKey.set(key, [r]);
  }

  const out: RateLine[] = [];
  for (const list of byKey.values()) {
    const sorted = [...list].sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    const inForce = sorted.filter(r => r.effective_date <= today);
    const future = sorted.filter(r => r.effective_date > today);
    const current = inForce[inForce.length - 1];
    const previous = inForce[inForce.length - 2];
    const head = current ?? sorted[0];

    out.push({
      id: head.id,
      label: head.label,
      siteId: head.site_id ?? null,
      amountCents: current ? cents(current.amount_cents) : 0,
      unit: head.unit || 'shift',
      effectiveDate: current ? current.effective_date : '',
      previous: previous
        ? { amountCents: cents(previous.amount_cents), effectiveDate: previous.effective_date }
        : null,
      pending: future.length > 0
        ? { amountCents: cents(future[0].amount_cents), effectiveDate: future[0].effective_date }
        : null,
      notes: current?.notes ?? null,
    });
  }

  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Whole dollars — every rate in this group is a round figure, and cents on a
 *  call rate read as an error. A fractional amount keeps its cents. */
export function formatMoney(amountCents: number): string {
  const dollars = amountCents / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString('en-US')}`
    : `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Candidate pipeline ─────────────────────────────────────────────────────

export const PIPELINE_STAGES = [
  'screened', 'interviewed', 'references',
  'contract_sent', 'credentialing', 'start_date_set',
] as const;

export type PipelineStage = typeof PIPELINE_STAGES[number];

export const STAGE_LABEL: Record<PipelineStage, string> = {
  screened: 'Screened',
  interviewed: 'Interviewed',
  references: 'References',
  contract_sent: 'Contract sent',
  credentialing: 'Credentialing',
  start_date_set: 'Start date set',
};

export interface CandidateRow {
  id: string;
  initials: string;
  stage: string;
  stage_on: string;
  expires_on?: string | null;
  note?: string | null;
  status?: string | null;
  home_site_id?: string | null;
}

export interface CandidateLine {
  id: string;
  initials: string;
  stage: PipelineStage;
  stageOn: string;
  daysInStage: number;
  expiresOn: string | null;
  note: string | null;
  homeSiteId: string | null;
  /** Needs a human this week, with the reason. Empty when it does not. */
  attention: string;
}

export interface PipelineStageGroup {
  stage: PipelineStage;
  label: string;
  candidates: CandidateLine[];
}

/** A contract this close to lapsing is this week's problem. */
const EXPIRY_WINDOW_DAYS = 14;
/** Credentialing past this has stopped being "in progress". */
const CREDENTIALING_STALE_DAYS = 60;

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The pipeline, by stage, with the items that need somebody this week called
 * out on their own.
 *
 * Only ACTIVE candidates: a hire or a withdrawal is history, and leaving them
 * in makes "10 active" mean nothing. Anything with an unrecognised stage is
 * dropped rather than bucketed into the first one, which would move a real
 * person to the wrong column.
 */
export function groupCandidates(
  rows: ReadonlyArray<CandidateRow>, today: string,
): { stages: PipelineStageGroup[]; active: number; needAttention: CandidateLine[] } {
  const valid = new Set<string>(PIPELINE_STAGES);
  const lines: CandidateLine[] = [];

  for (const r of rows) {
    if ((r.status || 'active') !== 'active') continue;
    if (!valid.has(r.stage)) continue;
    const stage = r.stage as PipelineStage;
    const daysInStage = daysBetween(r.stage_on, today);

    let attention = '';
    if (r.expires_on && r.expires_on < today) {
      attention = `lapsed ${r.expires_on}`;
    } else if (r.expires_on && daysBetween(today, r.expires_on) <= EXPIRY_WINDOW_DAYS) {
      attention = `expires ${r.expires_on}`;
    } else if (stage === 'credentialing' && daysInStage >= CREDENTIALING_STALE_DAYS) {
      attention = `day ${daysInStage} of credentialing`;
    }

    lines.push({
      id: r.id,
      initials: r.initials,
      stage,
      stageOn: r.stage_on,
      daysInStage,
      expiresOn: r.expires_on ?? null,
      note: r.note ?? null,
      homeSiteId: r.home_site_id ?? null,
      attention,
    });
  }

  const stages = PIPELINE_STAGES.map<PipelineStageGroup>(stage => ({
    stage,
    label: STAGE_LABEL[stage],
    candidates: lines
      .filter(l => l.stage === stage)
      .sort((a, b) => a.initials.localeCompare(b.initials)),
  }));

  return { stages, active: lines.length, needAttention: lines.filter(l => l.attention) };
}

// ── Documents ──────────────────────────────────────────────────────────────

export const ACCESS_LABEL: Record<string, string> = {
  all_staff: 'All staff',
  partners: 'Partners',
  admin: 'Admin only',
};

// ── Committee ──────────────────────────────────────────────────────────────

export interface MeetingRow {
  id: string;
  meets_on: string;
  meets_at?: string | null;
  location?: string | null;
  agenda_posted_on?: string | null;
  minutes_status?: string | null;
  topics?: string | null;
  minutes_url?: string | null;
  committee_action_items?: ReadonlyArray<{ status?: string | null }> | null;
}

/**
 * Split the meeting list into the next one and the ones already held.
 *
 * "Next" is the earliest meeting dated today or later — a meeting happening
 * TODAY is still ahead of you, and dropping it into the history the morning of
 * is precisely when somebody needs the room number.
 */
export function splitMeetings(rows: ReadonlyArray<MeetingRow>, today: string): {
  next: MeetingRow | null;
  past: MeetingRow[];
} {
  const sorted = [...rows].sort((a, b) => a.meets_on.localeCompare(b.meets_on));
  const upcoming = sorted.filter(m => m.meets_on >= today);
  const past = sorted.filter(m => m.meets_on < today).reverse();
  return { next: upcoming[0] ?? null, past };
}

/** Open action items across every meeting — the figure the header carries. */
export function openActionCount(rows: ReadonlyArray<MeetingRow>): number {
  let open = 0;
  for (const m of rows) {
    for (const item of m.committee_action_items || []) {
      if ((item.status || 'open') === 'open') open++;
    }
  }
  return open;
}
