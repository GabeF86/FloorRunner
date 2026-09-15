/**
 * The visual bindings on the staffing chips and the obligation table.
 *
 * These are one-line style expressions, which is exactly why they are pinned:
 * a chip's ring and a column's colour ARE the information here, and a binding
 * that stops firing looks like data rather than like a bug. Rendered with
 * renderToStaticMarkup — vitest runs in `environment: 'node'` with no jsdom, so
 * this asserts output, not interaction.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaffChips, ObligationCard } from './DashboardView';
import type { SiteCallObligation } from '@/lib/siteCallObligation';

describe('staffing chips', () => {
  const html = renderToStaticMarkup(
    <StaffChips people={[
      { id: '1', name: 'Ann Partner', short: 'Partner A.', fte: 1, call: true, partner: true },
      { id: '2', name: 'Ben Employed', short: 'Employed B.', fte: 1, call: true, partner: false },
      { id: '3', name: 'Cara Crna', short: 'Crna C.', fte: 1, call: false, crna: true },
      { id: '4', name: 'Dee Crna Partner', short: 'Partner D.', fte: 1, call: false, crna: true, partner: true },
    ]} />,
  );
  // Split on the anchor boundary rather than searching backwards from the
  // name: the name also appears in `title=`, which sits BEFORE `style=`, so a
  // backwards slice captures the tag up to the title and misses every style.
  // Looked up by the SHORT name, because that is what the chip prints. The
  // full name moved to the title attribute, which the last test asserts.
  const chip = (short: string) => {
    const one = html.split('<a class="fr-chip"').find(c => c.includes(`>${short}<`));
    if (!one) throw new Error(`no chip rendered for ${short}`);
    return one;
  };

  it('rings a partner in orange and leaves everyone else on the default border', () => {
    expect(chip('Partner A.')).toContain('border:1px solid var(--partner-ring)');
    expect(chip('Employed B.')).toContain('border:1px solid var(--border)');
  });

  it('gives CRNAs a different SHAPE, not a different colour', () => {
    // Shape rather than colour because the per-diem list mixes physicians and
    // CRNAs, and shape survives printing and colour-vision deficiency.
    expect(chip('Crna C.')).toContain('border-radius:var(--radius-sm)');
    expect(chip('Employed B.')).toContain('border-radius:999px');
  });

  it('lets the two markers combine — a CRNA partner is both', () => {
    const c = chip('Partner D.');
    expect(c).toContain('border-radius:var(--radius-sm)');
    expect(c).toContain('var(--partner-ring)');
  });

  it('names both markers in the tooltip, so the cue is not colour-only', () => {
    expect(html).toContain('title="Ann Partner — partner"');
    expect(html).toContain('title="Cara Crna — CRNA"');
    expect(html).toContain('title="Ben Employed"');
  });

  it('prints the compact name and keeps the full one in the tooltip', () => {
    // "Farkas G." is roughly half the width of "Gabriel Farkas", which is what
    // makes 288 chips fit. The full name must stay reachable — a dashboard
    // that only ever shows an abbreviation is one you have to decode.
    expect(html).toContain('>Partner A.<');
    expect(html).not.toContain('>Ann Partner<');
    expect(html).toContain('Ann Partner —');
  });
});

describe('annual call obligation', () => {
  const obligation: SiteCallObligation = {
    year: 2026, parLevel: 10, noSlate: false, totalSlots: 354, totalPerFte: 35.4,
    groups: [
      { bucket: 'weekday', label: 'M–Th', rows: [{ code: 'C1', slots: 200, perFte: 20 }], slots: 200, perFte: 20 },
      { bucket: 'friday', label: 'Friday', rows: [{ code: 'C1', slots: 50, perFte: 5 }], slots: 50, perFte: 5 },
      { bucket: 'saturday', label: 'Saturday', rows: [{ code: 'C1', slots: 52, perFte: 5.2 }], slots: 52, perFte: 5.2 },
      { bucket: 'sunday', label: 'Sunday', rows: [{ code: 'C1', slots: 52, perFte: 5.2 }], slots: 52, perFte: 5.2 },
    ],
  };
  const html = renderToStaticMarkup(<ObligationCard panel={{ error: null, data: obligation }} />);

  it('places the weekday total between Friday and Saturday, and the weekend total last', () => {
    const at = (s: string) => html.indexOf(s);
    expect(at('M–Th + F')).toBeGreaterThan(at('Friday'));
    expect(at('M–Th + F')).toBeLessThan(at('Saturday'));
    expect(at('Sat + Sun')).toBeGreaterThan(at('Sunday'));
  });

  // The layout is a TABLE now: codes are rows, day types are columns. A
  // "column" is therefore a cell, found by the title the cell carries.
  const cell = (label: string, code: string) => {
    const marker = `slots the site must cover on ${label}"`;
    const at = html.indexOf(marker);
    if (at < 0) throw new Error(`no cell for ${code} on ${label}`);
    const tdStart = html.lastIndexOf('<td', at);
    return html.slice(tdStart, html.indexOf('</td>', at));
  };

  it('prints the totals in red and the day columns in blue', () => {
    expect(cell('M–Th + F', 'C1')).toContain('var(--danger)');
    expect(cell('M–Th + F', 'C1')).not.toContain('var(--blue)');
    expect(cell('Friday', 'C1')).toContain('var(--blue)');
    expect(cell('Friday', 'C1')).not.toContain('var(--danger)');
  });

  it('keeps the site slot count reachable without printing it in every cell', () => {
    // 200 + 50 = 250. It used to sit beside every figure, six times over; the
    // table is the denser form precisely because that moved to the tooltip.
    expect(html).toContain('250 C1 slots the site must cover on M–Th + F');
  });

  it('gives a code that does not run on a day an em dash, not a zero', () => {
    // "Does not run here" and "owes none of it" are different facts.
    const weekend = renderToStaticMarkup(
      <ObligationCard panel={{ error: null, data: { ...obligation, groups: [
        { bucket: 'saturday', label: 'Saturday', rows: [
          { code: 'C1', slots: 52, perFte: 5.2 }, { code: 'C3', slots: 52, perFte: 5.2 },
        ], slots: 104, perFte: 10.4 },
        { bucket: 'sunday', label: 'Sunday', rows: [
          { code: 'C1', slots: 52, perFte: 5.2 },
        ], slots: 52, perFte: 5.2 },
      ] } }} />,
    );
    expect(weekend).toContain('—');
  });
});
