// Who the grid's provider-focus selector offers.
//
// This started as "everyone who already holds an assignment", which was a
// reasonable rule while focus was purely a HIGHLIGHT: naming a provider with
// nothing on the board just fades the whole grid. It became wrong the moment
// one-provider-at-a-time GENERATION was bound to the same control (Gabriel
// 2026-08) — on a fresh schedule the list is empty, and an empty list is
// precisely the case targeted generation exists for ("autogenerate the havildar
// placements first"). You cannot generate for someone the picker won't name.
//
// So the list is the UNION of two populations:
//   • GENERABLE — the schedule's saved pool when it states one, otherwise every
//     provider at this site carrying one of the two role flags the engines
//     intersect (call_taker for call generation, is_day_doc for day shifts).
//     Deliberately the saved pool VERBATIM when present: that pool is already a
//     narrowing decision, and re-filtering it by role here would hide a
//     provider the scheduler explicitly added.
//   • HOLDING WORK — anyone with an assignment in the block, so a provider
//     removed from the pool after being scheduled stays reachable instead of
//     vanishing from a board they are visibly on.
//
// Pure so it is testable: the page component is not (vitest runs
// environment:'node'), and an untestable filter is exactly what shipped the
// empty-list bug.

export interface FocusListProvider {
  id: string;
  short_display_name: string;
}

export interface FocusListProfile {
  provider_id: string;
  home_site_id: string | null;
  call_taker?: boolean | null;
  is_day_doc?: boolean | null;
}

export interface FocusListSlot {
  assignments?: ReadonlyArray<{ provider_id?: string | null }> | null;
}

export interface FocusListInput {
  providers: readonly FocusListProvider[];
  profiles: readonly FocusListProfile[];
  slots: readonly FocusListSlot[];
  siteId: string;
  /** schedules.included_provider_ids — null/empty = no stated pool. */
  includedProviderIds: readonly string[] | null | undefined;
}

export interface FocusListEntry extends FocusListProvider {
  /** False ⇒ nothing on the board yet; the option says so rather than looking
   *  identical to a fully-placed provider. */
  holdsWork: boolean;
}

/** Provider ids holding at least one assignment anywhere in the block. */
export function providersHoldingWork(slots: readonly FocusListSlot[]): Set<string> {
  const held = new Set<string>();
  for (const slot of slots) {
    for (const a of slot.assignments ?? []) if (a.provider_id) held.add(a.provider_id);
  }
  return held;
}

export function buildProviderFocusList(input: FocusListInput): FocusListEntry[] {
  const held = providersHoldingWork(input.slots);
  const stated = input.includedProviderIds;
  const pool = new Set<string>(
    stated && stated.length > 0
      ? stated
      : input.profiles
          .filter(pr => pr.home_site_id === input.siteId && (pr.call_taker || pr.is_day_doc))
          .map(pr => pr.provider_id),
  );
  return input.providers
    .filter(p => pool.has(p.id) || held.has(p.id))
    .map(p => ({ ...p, holdsWork: held.has(p.id) }))
    .sort((a, b) => a.short_display_name.localeCompare(b.short_display_name));
}
