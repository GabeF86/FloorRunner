/**
 * Design-invariant tests for the provider profile primitives.
 *
 * Node environment, no jsdom, no new deps — render output is asserted through
 * react-dom/server's renderToStaticMarkup, the strategy set by
 * src/components/ui/Modal.test.tsx. There are no clicks here because there is
 * no DOM to click in; what IS checked is the thing a visual pass actually
 * regresses, which is the painted output.
 *
 * These primitives back ~145 call sites across a 3,900-line page, so a single
 * hardcoded hex or a 9px label reintroduced here reappears everywhere at once.
 * That is exactly the class of drift this file exists to catch:
 *
 *   1. No colour literals. Every hex on this page used to be a DARK-theme
 *      value being painted on the LIGHT default (globals.css deliberately
 *      gives --blue a deeper value in light so small accent text clears AA),
 *      so a literal is a both-themes bug, not a style preference.
 *   2. Nothing below --fs-xs (11px), the floor of the type scale.
 *   3. No sub-pixel borders — 0.5px renders as 1px on some DPRs and vanishes
 *      on others.
 *   4. Fields opt into the .fr-field state layer, which is the only thing
 *      giving them a keyboard focus ring now that outline:none is gone.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChipPill, ChipRow, Field, Hint, InfoTip, NoneYet, PreviewNote, RemovableChip,
  SaveBar, SaveButton, SaveIndicator, SectionLabel, Stack, StatTile, TabStack,
  Toggle, FormGrid,
} from './ui';

/**
 * Every primitive, rendered at once.
 *
 * ChipPill used to be excluded as "the one that takes a caller-supplied
 * colour", which was really an exemption for the caller: the provider-type map
 * it is fed was seven literals. That map is tokens now, so the exemption is
 * gone and the invariants below cover the whole module.
 */
function renderAll(): string {
  return [
    renderToStaticMarkup(
      <ChipPill text="Physician" fg="var(--warn)" bg="color-mix(in srgb, var(--warn) 15%, transparent)" />,
    ),
    renderToStaticMarkup(<SectionLabel>Standing</SectionLabel>),
    renderToStaticMarkup(<Hint>Soft preferences used by the scheduler.</Hint>),
    renderToStaticMarkup(<NoneYet>No PTO entries yet.</NoneYet>),
    renderToStaticMarkup(<PreviewNote>Blocks the week plus the following Monday.</PreviewNote>),
    renderToStaticMarkup(<StatTile value={12} label="Weekend Call" detail="7 C2 · 3 C1" />),
    renderToStaticMarkup(<StatTile value={4} label="Total Call" emphasis />),
    renderToStaticMarkup(<SaveIndicator state="saving" />),
    renderToStaticMarkup(<SaveIndicator state="saved" />),
    renderToStaticMarkup(<InfoTip text="Calendar-day count." />),
    renderToStaticMarkup(<Toggle label="Partner" checked onChange={() => {}} />),
    renderToStaticMarkup(<Toggle label="Day Doc" checked={false} onChange={() => {}} />),
    renderToStaticMarkup(<Field label="First name" value="Ada" onChange={() => {}} />),
    renderToStaticMarkup(<Field label="Email" value="x" onChange={() => {}} error="Not a valid email" />),
    renderToStaticMarkup(<Field label="FTE" value="1" onChange={() => {}} hint="0.1–1.0" />),
    renderToStaticMarkup(<RemovableChip label="General Surgery" tone="ok" onRemove={() => {}} />),
    renderToStaticMarkup(<RemovableChip label="Cardiac" note="(legacy)" onRemove={() => {}} />),
    renderToStaticMarkup(<SaveButton onClick={() => {}} canSave saveState="idle" />),
    renderToStaticMarkup(<SaveButton onClick={() => {}} canSave saveState="saved" />),
    renderToStaticMarkup(<TabStack><span>body</span></TabStack>),
    renderToStaticMarkup(<Stack><span>a</span></Stack>),
    renderToStaticMarkup(<SaveBar><span>a</span></SaveBar>),
    renderToStaticMarkup(<FormGrid cols="1fr 1fr"><span>a</span></FormGrid>),
    renderToStaticMarkup(<ChipRow><span>a</span></ChipRow>),
  ].join('\n');
}

describe('provider profile primitives — design invariants', () => {
  it('paints no colour literals, only tokens', () => {
    const found = renderAll().match(/#[0-9a-fA-F]{3,8}\b/g);
    expect(found).toBeNull();
  });

  it('never renders type below the --fs-xs floor', () => {
    const sizes = [...renderAll().matchAll(/font-size:\s*([0-9.]+)px/g)].map(m => Number(m[1]));
    // Every size should come through as a var(); any literal that does slip in
    // must still clear 11px.
    expect(sizes.filter(px => px < 11)).toEqual([]);
  });

  it('uses no sub-pixel borders', () => {
    // Scoped to border declarations on purpose: sub-pixel LETTER-SPACING is a
    // deliberate tracking value on the stat figure, and a blanket "0.5px"
    // search flags it as if it were a hairline that half the displays in the
    // building would drop.
    const borders = renderAll().match(/border(?:-[a-z]+)?:[^;"]*\b0?\.\d+px/g);
    expect(borders).toBeNull();
  });

  it('opts every text field into the .fr-field state layer', () => {
    // outline:none with no replacement was the accessibility regression; the
    // ring now comes from .fr-field:focus-visible in globals.css, so the class
    // is load-bearing rather than cosmetic.
    const field = renderToStaticMarkup(<Field label="NPI" value="" onChange={() => {}} />);
    expect(field).toContain('class="fr-field"');
    expect(field).not.toContain('outline:none');
  });

  it('marks an errored field for assistive tech, not just in red', () => {
    const bad = renderToStaticMarkup(<Field label="Email" value="x" onChange={() => {}} error="Not a valid email" />);
    expect(bad).toContain('aria-invalid="true"');
    expect(bad).toContain('Not a valid email');
    const good = renderToStaticMarkup(<Field label="Email" value="a@b.co" onChange={() => {}} />);
    expect(good).not.toContain('aria-invalid');
  });

  it('keeps a real checkbox inside the toggle pill', () => {
    // The pill is drawn on the LABEL; the input keeps every bit of the native
    // semantics, so this must never become a div with a click handler.
    const on = renderToStaticMarkup(<Toggle label="Partner" checked onChange={() => {}} />);
    expect(on).toContain('type="checkbox"');
    expect(on).toContain('checked');
    expect(on).toContain('data-on="true"');
    expect(on).toContain('class="fr-toggle"');
    const off = renderToStaticMarkup(<Toggle label="Partner" checked={false} onChange={() => {}} />);
    expect(off).toContain('data-on="false"');
  });

  it('gives the chip remove control an accessible name', () => {
    const chip = renderToStaticMarkup(<RemovableChip label="Paoli Hospital" onRemove={() => {}} />);
    expect(chip).toContain('aria-label="Remove Paoli Hospital"');
  });

  it('reports save state in words', () => {
    expect(renderToStaticMarkup(<SaveButton onClick={() => {}} canSave saveState="saving" />)).toContain('Saving');
    expect(renderToStaticMarkup(<SaveButton onClick={() => {}} canSave saveState="saved" />)).toContain('Saved');
    expect(renderToStaticMarkup(<SaveButton onClick={() => {}} canSave saveState="idle" />)).toContain('Save Changes');
    // Idle renders nothing at all, so the header cannot jitter on every save.
    expect(renderToStaticMarkup(<SaveIndicator state="idle" />)).toBe('');
  });

  it('keeps the InfoTip popover on the themed surface', () => {
    // It used to hardcode #1e293b on #e2e8f0 — a dark box floating in the
    // light default. The trigger renders collapsed under SSR; what matters is
    // that neither piece carries a literal.
    const tip = renderToStaticMarkup(<InfoTip text="Counting rule." />);
    expect(tip).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(tip).toContain('var(--info');
  });

  it('carries the shared provider-type hue through as a token', () => {
    // ChipPill is the one primitive that takes its colour from the caller: the
    // provider TYPE map, held verbatim by providers/page.tsx,
    // providers/[id]/page.tsx and requests/page.tsx. That map used to be seven
    // dark-theme hexes (#f59e0b was ~2.2:1 on the light default); it is tokens
    // now, so what arrives here is a var() and it must survive untouched.
    const pill = renderToStaticMarkup(
      <ChipPill text="Physician" fg="var(--warn)" bg="color-mix(in srgb, var(--warn) 15%, transparent)" />,
    );
    expect(pill).toContain('color:var(--warn)');
    expect(pill).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('derives ChipPill’s hairline with color-mix, never an alpha suffix', () => {
    // This is the regression that made the token migration above possible.
    // `${fg}33` only works while fg is a 6-digit hex — once the provider-type
    // map went to tokens, `var(--warn)33` is not a colour and the border
    // silently vanishes. color-mix takes either.
    const pill = renderToStaticMarkup(
      <ChipPill text="Physician" fg="var(--warn)" bg="color-mix(in srgb, var(--warn) 15%, transparent)" />,
    );
    expect(pill).toContain('border:1px solid color-mix(in srgb, var(--warn) 22%, transparent)');
    expect(pill).not.toMatch(/var\(--warn\)[0-9a-fA-F]{2}/);
  });

  it('lets .fr-btn own the motion contract for SaveButton', () => {
    // An inline `transition` REPLACES the shorthand from .fr-btn, which covers
    // background, colour, border, shadow, filter and the press transform at
    // the motion tokens. A hand-written `background .2s` here therefore does
    // not add a transition, it removes five — and the save button becomes the
    // one control in the app whose hover and 1px press snap.
    for (const state of ['idle', 'saving', 'saved'] as const) {
      const btn = renderToStaticMarkup(<SaveButton onClick={() => {}} canSave saveState={state} />);
      expect(btn).toContain('fr-btn');
      expect(btn).not.toMatch(/transition/);
    }
  });
});
