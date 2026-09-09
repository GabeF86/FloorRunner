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

/** Everything that does not take a caller-supplied colour, rendered at once. */
function renderAll(): string {
  return [
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

  it('still lets ChipPill carry the shared provider-type hue', () => {
    // The one deliberate exception: provider TYPE colours are shared verbatim
    // with the providers list page, so this primitive takes them as props.
    const pill = renderToStaticMarkup(<ChipPill text="Physician" fg="#f59e0b" bg="rgba(245,158,11,0.15)" />);
    expect(pill).toContain('#f59e0b');
  });
});
