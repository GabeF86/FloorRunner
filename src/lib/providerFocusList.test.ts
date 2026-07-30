// Provider focus list — the regression that motivated extracting it.
//
// Gabriel, 2026-08: "where do i select her ? the focus provider dropdown? it
// doesnt allow". The original filter was "providers who already hold an
// assignment", which is empty on a fresh schedule — the exact case
// one-provider-at-a-time generation is for.
import { describe, it, expect } from 'vitest';
import {
  buildProviderFocusList, providersHoldingWork,
  type FocusListInput, type FocusListProfile,
} from './providerFocusList';

const SITE = 'paoli';

const prov = (id: string, name = id.toUpperCase()) => ({ id, short_display_name: name });

const profile = (
  provider_id: string, over: Partial<FocusListProfile> = {},
): FocusListProfile => ({
  provider_id, home_site_id: SITE, call_taker: true, is_day_doc: false, ...over,
});

const held = (pid: string) => ({ assignments: [{ provider_id: pid }] });

const build = (over: Partial<FocusListInput> = {}) => buildProviderFocusList({
  providers: [prov('havildar'), prov('amusa')],
  profiles: [profile('havildar'), profile('amusa')],
  slots: [],
  siteId: SITE,
  includedProviderIds: null,
  ...over,
});

const ids = (list: ReturnType<typeof buildProviderFocusList>) => list.map(e => e.id);

describe('provider focus list', () => {
  it('offers the pool on a FRESH schedule with no assignments at all', () => {
    // THE BUG: the old rule returned [] here, so targeted generation could not
    // be started from a blank block.
    expect(ids(build({ slots: [] })).sort()).toEqual(['amusa', 'havildar']);
  });

  it('marks who has nothing on the board yet', () => {
    const list = build({ slots: [held('amusa')] });
    expect(list.find(e => e.id === 'amusa')!.holdsWork).toBe(true);
    expect(list.find(e => e.id === 'havildar')!.holdsWork).toBe(false);
  });

  it('uses the saved pool VERBATIM when the schedule states one', () => {
    // The saved pool is already a narrowing decision; re-filtering it by role
    // would hide someone the scheduler explicitly added.
    const list = build({
      providers: [prov('havildar'), prov('amusa'), prov('chamchad')],
      profiles: [profile('havildar'), profile('amusa'),
                 profile('chamchad', { call_taker: false, is_day_doc: true })],
      includedProviderIds: ['havildar', 'chamchad'],
    });
    expect(ids(list).sort()).toEqual(['chamchad', 'havildar']);
  });

  it('falls back to BOTH role flags, not just call takers', () => {
    // Day-shift generation intersects is_day_doc, so a day doc has to be
    // targetable — the reason is_day_doc had to be added to the grid payload.
    const list = build({
      providers: [prov('amusa'), prov('chamchad'), prov('orji')],
      profiles: [
        profile('amusa'),
        profile('chamchad', { call_taker: false, is_day_doc: true }),
        profile('orji', { call_taker: false, is_day_doc: false }),  // per diem
      ],
      includedProviderIds: null,
    });
    expect(ids(list).sort()).toEqual(['amusa', 'chamchad']);
  });

  it('keeps a provider who holds work but is NOT in the pool', () => {
    // Removed from the pool after being scheduled: they are visibly on the
    // board, so the picker must still name them.
    const list = build({
      providers: [prov('havildar'), prov('retired')],
      profiles: [profile('havildar')],
      slots: [held('retired')],
      includedProviderIds: ['havildar'],
    });
    expect(ids(list).sort()).toEqual(['havildar', 'retired']);
    expect(list.find(e => e.id === 'retired')!.holdsWork).toBe(true);
  });

  it('excludes another site’s providers from the role fallback', () => {
    const list = build({
      providers: [prov('amusa'), prov('elsewhere')],
      profiles: [profile('amusa'), profile('elsewhere', { home_site_id: 'other' })],
    });
    expect(ids(list)).toEqual(['amusa']);
  });

  it('an empty saved pool array is “no stated pool”, not “nobody”', () => {
    expect(ids(build({ includedProviderIds: [] })).sort()).toEqual(['amusa', 'havildar']);
  });

  it('never lists a provider twice when they are both pooled and holding work', () => {
    const list = build({ includedProviderIds: ['amusa'], slots: [held('amusa')] });
    expect(ids(list)).toEqual(['amusa']);
  });

  it('sorts by display name, not id order', () => {
    const list = buildProviderFocusList({
      providers: [prov('z1', 'Alpha'), prov('a1', 'Zulu')],
      profiles: [profile('z1'), profile('a1')],
      slots: [], siteId: SITE, includedProviderIds: null,
    });
    expect(list.map(e => e.short_display_name)).toEqual(['Alpha', 'Zulu']);
  });
});

describe('providersHoldingWork', () => {
  it('ignores open placeholder rows (null provider)', () => {
    expect([...providersHoldingWork([
      { assignments: [{ provider_id: null }] },
      { assignments: [{ provider_id: 'amusa' }] },
      { assignments: null },
      {},
    ])]).toEqual(['amusa']);
  });
});
