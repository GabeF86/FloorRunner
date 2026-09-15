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
      { id: '1', name: 'Ann Partner', fte: 1, call: true, partner: true },
      { id: '2', name: 'Ben Employed', fte: 1, call: true, partner: false },
      { id: '3', name: 'Cara Crna', fte: 1, call: false, crna: true },
      { id: '4', name: 'Dee Crna Partner', fte: 1, call: false, crna: true, partner: true },
    ]} />,
  );
  // Split on the anchor boundary rather than searching backwards from the
  // name: the name also appears in `title=`, which sits BEFORE `style=`, so a
  // backwards slice captures the tag up to the title and misses every style.
  const chip = (name: string) => {
    const one = html.split('<a class="fr-chip"').find(c => c.includes(`>${name}<`));
    if (!one) throw new Error(`no chip rendered for ${name}`);
    return one;
  };

  it('rings a partner in orange and leaves everyone else on the default border', () => {
    expect(chip('Ann Partner')).toContain('border:1px solid var(--partner-ring)');
    expect(chip('Ben Employed')).toContain('border:1px solid var(--border)');
  });

  it('gives CRNAs a different SHAPE, not a different colour', () => {
    // Shape rather than colour because the per-diem list mixes physicians and
    // CRNAs, and shape survives printing and colour-vision deficiency.
    expect(chip('Cara Crna')).toContain('border-radius:var(--radius-sm)');
    expect(chip('Ben Employed')).toContain('border-radius:999px');
  });

  it('lets the two markers combine — a CRNA partner is both', () => {
    const c = chip('Dee Crna Partner');
    expect(c).toContain('border-radius:var(--radius-sm)');
    expect(c).toContain('var(--partner-ring)');
  });

  it('names both markers in the tooltip, so the cue is not colour-only', () => {
    expect(html).toContain('title="Ann Partner — partner"');
    expect(html).toContain('title="Cara Crna — CRNA"');
    expect(html).toContain('title="Ben Employed"');
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

  // Each column is a `<div style="min-width:0">`. Splitting on that is exact,
  // whereas slicing between two header LABELS is not: a column's style
  // attribute precedes its own text, so such a slice swallows the next
  // column's heading and reports its colour as belonging to this one.
  const column = (label: string) => {
    const one = html.split('<div style="min-width:0">').find(c => c.includes(`>${label}<`));
    if (!one) throw new Error(`no column rendered for ${label}`);
    return one;
  };

  it('prints the totals in red and the day columns in blue', () => {
    expect(column('M–Th + F')).toContain('var(--danger)');
    expect(column('M–Th + F')).not.toContain('var(--blue)');
    expect(column('Friday')).toContain('var(--blue)');
    expect(column('Friday')).not.toContain('var(--danger)');
  });

  it('shows the summed figure, not one of its parts', () => {
    // 200 + 50 = 250 slots, ÷ par 10 = 25.
    expect(column('M–Th + F')).toContain('of 250');
  });
});
