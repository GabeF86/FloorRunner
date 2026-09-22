/* ───────────────────────────────────────────────────────────────────────────
 * Master schedule — data layer.
 *
 * PAGED, NOT PLAIN. A twelve-month window across every site is 1,676 slots
 * today and grows with each block. PostgREST silently caps an un-ranged select
 * at 1,000 rows with `error: null`, and a truncated read here does not look
 * broken — it looks like a hospital that stopped scheduling in October. Every
 * read goes through readAllRows.
 *
 * PUBLISHED ONLY (clinical invariant 3), and SOFT-DELETED SCHEDULES EXCLUDED
 * (patch62): the master sheet is the schedule of record, so a draft is a
 * hypothetical and a deleted block is one somebody removed on purpose.
 * ─────────────────────────────────────────────────────────────────────────── */

import { readAllRows } from '@/lib/pagedRead';
import { embedArray } from '@/lib/embed';
import {
  buildMasterSchedule, masterWindow,
  type MasterSchedule, type MasterSlotRow, type MasterAwayRow, type MasterSiteRow,
} from '@/lib/masterSchedule';
import type { CoverageGroup, OpsProviderRow } from '@/lib/operationsBoard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchedulingClient = any;

const SLOT_SELECT =
  'site_id, slot_date,'
  + ' schedule_versions!inner(version_status, schedules!inner(deleted_at)),'
  + ' shift_types(code, display_order, category),'
  + ' assignments(provider_id)';

export interface MasterData {
  schedule: MasterSchedule;
  /** Per-read failures. A non-empty list means the sheet is showing less than
   *  the truth, and the page says so rather than quietly rendering short. */
  errors: string[];
}

export async function loadMasterSchedule(
  sb: SchedulingClient, group: CoverageGroup, today: string,
): Promise<MasterData> {
  const { from, to } = masterWindow(today);
  const errors: string[] = [];

  const [siteRes, slotRes, awayRes] = await Promise.all([
    readAllRows<MasterSiteRow>((f, t) => sb.from('sites')
      .select('id, name, short_name, display_order', { count: 'exact' })
      .order('display_order', { nullsFirst: false }).order('name').range(f, t), 'sites'),

    readAllRows<Record<string, unknown>>((f, t) => sb.from('schedule_slots')
      .select(SLOT_SELECT, { count: 'exact' })
      .eq('schedule_versions.version_status', 'published')
      .is('schedule_versions.schedules.deleted_at', null)
      .gte('slot_date', from).lte('slot_date', to)
      .order('slot_date').order('id').range(f, t), 'schedule slots'),

    // Any spell OVERLAPPING the window, not only one starting inside it — a
    // month of leave that began before the window still covers days in it.
    readAllRows<MasterAwayRow>((f, t) => sb.from('provider_availability')
      .select('provider_id, availability_type, approval_status, start_date, end_date',
        { count: 'exact' })
      .lte('start_date', to).gte('end_date', from)
      .order('start_date').order('provider_id').range(f, t), 'availability'),
  ]);

  for (const r of [siteRes, slotRes, awayRes]) if (r.error) errors.push(r.error);

  const slots: MasterSlotRow[] = slotRes.rows.map(row => ({
    site_id: String(row.site_id),
    slot_date: String(row.slot_date),
    shift: embedArray(row.shift_types as never)[0] ?? null,
    providerIds: embedArray(row.assignments as never)
      .map(a => (a as { provider_id?: string | null })?.provider_id)
      .filter((p): p is string => !!p),
  }));

  // Only the people who actually appear — the roster is 300 rows and the
  // window rarely touches all of them.
  const ids = [...new Set([
    ...slots.flatMap(s => s.providerIds),
    ...awayRes.rows.map(a => a.provider_id),
  ])];
  let providers: OpsProviderRow[] = [];
  if (ids.length > 0) {
    const provRes = await readAllRows<OpsProviderRow>((f, t) => sb.from('providers')
      .select('id, provider_type, first_name, last_name, short_display_name',
        { count: 'exact' })
      .in('id', ids).order('id').range(f, t), 'providers');
    if (provRes.error) errors.push(provRes.error);
    providers = provRes.rows;
  }

  return {
    schedule: buildMasterSchedule({
      group, from, to,
      sites: siteRes.rows, slots, away: awayRes.rows, providers,
    }),
    errors,
  };
}
