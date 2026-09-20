/* ───────────────────────────────────────────────────────────────────────────
 * How many people the schedule actually puts at a site on a day — split into
 * the ones on the daytime floor and the ones carrying overnight call.
 *
 * The staffing calculator asks "how many MDs and CRNAs do I have to build an
 * OR grid out of today". Until now the answer was typed in by hand and
 * defaulted to 12 and 14, numbers that belonged to nobody. This reads it off
 * the published schedule instead.
 *
 * ── WHY THE OVERNIGHT TEAM IS A SEPARATE BUCKET, NOT A SUBTRACTION ─────────
 * The overnight call team is ON the schedule and NOT on the floor: Paoli's C1
 * and Lankenau's C1 and C2 all run 15:00 → 07:00, so counting them among the
 * day's available staff overstates the floor and hides a real gap. But they
 * are the right answer to a different question — "who is in the building
 * tonight" — so they are counted separately and handed back, rather than
 * dropped. The caller decides; nothing is silently missing either way.
 *
 * ── WHY TIME, NOT SHIFT CODE ──────────────────────────────────────────────
 * The named exclusions are Paoli C1 and Lankenau C1/C2, and a `code === 'C1'`
 * test would deliver exactly those today. It would also break the moment a
 * site's first call is called something else, and it misses the split
 * segments entirely — Paoli's C1E8 starts at 15:00 and C1N12 at 19:00, and
 * neither is called C1. Splitting on the start hour catches all of them and
 * needs no per-site list. Verified against the live shift types: at Paoli and
 * Lankenau every active type starting at or after 15:00 is a call type, and
 * they are precisely C1 (both sites), Lankenau C2, and Paoli's evening/night
 * segments.
 *
 * ── WHY THE WEEKEND IS NOT EXEMPT HERE ────────────────────────────────────
 * The coverage matrix counts EVERYTHING on a Saturday, because there is no day
 * roster then and the call team IS the coverage — excluding first call there
 * would report every weekend as a body short. This module does not take that
 * exemption, and the difference is deliberate. The matrix grades a day against
 * a requirement; the calculator is asked "who can I build a grid out of", and
 * the answer at 08:00 on a Saturday does not change because it is a Saturday —
 * the person on 15:00 → 07:00 is still not there. The exemption is replaced by
 * the checkbox, which says so on screen instead of branching silently on the
 * day of the week.
 *
 * ── WHY A THIRD BUCKET ────────────────────────────────────────────────────
 * "Starts late" and "is the call team" are not the same predicate, and a
 * future 15:00 CRNA relief shift would be neither on the day floor nor part of
 * the overnight call team. Folding it into the call bucket would let the
 * "include overnight call team" checkbox add somebody who is not on that team;
 * folding it into the day bucket would put somebody on the floor who is not
 * there. It gets counted on its own and reported, so it can never be silently
 * added to either. Empty at both live sites today.
 * ─────────────────────────────────────────────────────────────────────────── */

import { startsOnTheFloor, providerName, type OpsProviderRow } from './operationsBoard';

/** Which side of the day a scheduled shift falls on. */
export type StaffBucket = 'day' | 'overnight_call' | 'late_other';

/** One person the schedule puts at the site that day. The calculator needs
 *  names, not only totals: a chip on the diagram gets a person put in it. */
export interface AvailablePerson {
  providerId: string;
  name: string;
  /** Schedule code, blank when it is only the name respaced. */
  code: string;
  type: 'MD' | 'CRNA';
  /** Every shift code they hold that day — usually one, occasionally two. */
  shiftCodes: string[];
  bucket: StaffBucket;
}

export interface AvailabilityShift {
  code?: string | null;
  category?: string | null;
  start_time?: string | null;
}

export interface AvailabilitySlot {
  site_id: string;
  slot_date: string;
  shift: AvailabilityShift | null;
  /** Provider ids standing this slot. Unfilled positions contribute nothing —
   *  the question is how many bodies there are, and a vacancy is not a body. */
  providerIds: ReadonlyArray<string>;
}

export interface StaffCount {
  mds: number;
  crnas: number;
}

export interface ScheduledAvailability {
  siteId: string;
  date: string;
  /** On the daytime floor: the staff an OR grid can actually be built from. */
  day: StaffCount;
  /** Carrying overnight call — on the schedule, off the daytime floor. */
  overnightCall: StaffCount;
  /** Starts late but is not call. Neither of the above; reported so it can
   *  never be quietly folded into one of them. */
  lateOther: StaffCount;
  /** Distinct shift codes behind each bucket, so the screen can name exactly
   *  who it left out rather than asking to be trusted. */
  dayCodes: string[];
  overnightCodes: string[];
  lateOtherCodes: string[];
  /** Everyone counted above, by name. Day staff first, then the overnight
   *  team, MDs before CRNAs, alphabetical inside each — the order somebody
   *  reads a list looking for a person to put in a room. */
  people: AvailablePerson[];
  /** Does the site have ANY published slot that day? Distinguishes "nobody is
   *  scheduled" from "no schedule exists" — a zero that means the calculator
   *  has nothing to read is not the same as a zero that means an empty day,
   *  and only one of them is a staffing fact. */
  scheduled: boolean;
}

/** Which bucket a shift belongs to. Exported for the tests and the API. */
export function bucketFor(shift: AvailabilityShift | null): StaffBucket {
  if (!shift) return 'day';
  if (startsOnTheFloor(shift.start_time)) return 'day';
  return shift.category === 'call' ? 'overnight_call' : 'late_other';
}

const empty = (): StaffCount => ({ mds: 0, crnas: 0 });

/**
 * Count the bodies at one site on one day.
 *
 * COUNTS PEOPLE, NOT ASSIGNMENTS. Somebody holding two slots the same day is
 * one person who can staff one room — the live schedule has a handful of these
 * (C1+D1, C2+DAY, D1+D5), and counting assignments would have reported them
 * twice and built a grid around staff who do not exist.
 *
 * DAY WINS OVER OVERNIGHT for anyone in both. A provider on C1 and D1 is on
 * the floor during the day; putting them in the overnight bucket would remove
 * a real body from the grid, and putting them in both would invent one.
 *
 * Group is read off the PROVIDER, not the shift type: a shift open to either
 * group, worked by a CRNA, is a CRNA on the floor whatever the type permits.
 */
export function scheduledAvailability(input: {
  siteId: string;
  date: string;
  slots: ReadonlyArray<AvailabilitySlot>;
  /** The providers standing those slots. Anyone absent is treated as a
   *  physician, matching how the coverage matrix and the bench split the
   *  roster; an unnamed provider still counts as a body. */
  providers: ReadonlyArray<OpsProviderRow>;
}): ScheduledAvailability {
  const provider = new Map<string, OpsProviderRow>();
  for (const p of input.providers) provider.set(p.id, p);

  const byBucket: Record<StaffBucket, Set<string>> = {
    day: new Set(), overnight_call: new Set(), late_other: new Set(),
  };
  const codes: Record<StaffBucket, Set<string>> = {
    day: new Set(), overnight_call: new Set(), late_other: new Set(),
  };
  const shiftsOf = new Map<string, Set<string>>();
  let scheduled = false;

  for (const slot of input.slots) {
    if (slot.site_id !== input.siteId || slot.slot_date !== input.date) continue;
    scheduled = true;
    const bucket = bucketFor(slot.shift);
    for (const pid of slot.providerIds) {
      if (!pid) continue;
      byBucket[bucket].add(pid);
      if (slot.shift?.code) {
        codes[bucket].add(slot.shift.code);
        const mine = shiftsOf.get(pid);
        if (mine) mine.add(slot.shift.code); else shiftsOf.set(pid, new Set([slot.shift.code]));
      }
    }
  }

  // Day wins: remove anyone already on the floor from the night buckets before
  // counting, so nobody is counted twice or moved off the grid.
  for (const pid of byBucket.day) {
    byBucket.overnight_call.delete(pid);
    byBucket.late_other.delete(pid);
  }

  const bare = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const personsIn = (bucket: StaffBucket): AvailablePerson[] =>
    [...byBucket[bucket]].map(pid => {
      const p = provider.get(pid);
      const name = p ? providerName(p) : '—';
      const code = p?.short_display_name?.trim() || '';
      return {
        providerId: pid,
        name,
        // Dropped when it is only the name with the spacing squeezed out —
        // printing both reads as two different people.
        code: code && bare(code) !== bare(name) ? code : '',
        type: p?.provider_type === 'crna' ? 'CRNA' : 'MD',
        shiftCodes: [...(shiftsOf.get(pid) ?? [])].sort(),
        bucket,
      } satisfies AvailablePerson;
    }).sort((a, b) =>
      (a.type === b.type ? 0 : a.type === 'MD' ? -1 : 1) || a.name.localeCompare(b.name));

  const count = (people: AvailablePerson[]): StaffCount => {
    const out = empty();
    for (const p of people) { if (p.type === 'CRNA') out.crnas++; else out.mds++; }
    return out;
  };

  const day = personsIn('day');
  const overnight = personsIn('overnight_call');
  const late = personsIn('late_other');
  const sorted = (s: Set<string>) => [...s].sort();

  return {
    siteId: input.siteId,
    date: input.date,
    day: count(day),
    overnightCall: count(overnight),
    lateOther: count(late),
    dayCodes: sorted(codes.day),
    overnightCodes: sorted(codes.overnight_call),
    lateOtherCodes: sorted(codes.late_other),
    people: [...day, ...overnight, ...late],
    scheduled,
  };
}

/** The people the calculator may draw on, for a given toggle state. The
 *  overnight team is offered only when they are being counted — a name that is
 *  not in the totals must not be assignable to a room. */
export function availablePeople(
  a: ScheduledAvailability,
  includeOvernightCall: boolean,
): AvailablePerson[] {
  return a.people.filter(p => p.bucket === 'day'
    || (includeOvernightCall && p.bucket === 'overnight_call'));
}

/** What the calculator's two steppers should read, for a given toggle state. */
export function availableStaff(
  a: ScheduledAvailability,
  includeOvernightCall: boolean,
): StaffCount {
  if (!includeOvernightCall) return { ...a.day };
  return {
    mds: a.day.mds + a.overnightCall.mds,
    crnas: a.day.crnas + a.overnightCall.crnas,
  };
}
