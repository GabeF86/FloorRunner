/**
 * Guard against `var(--typo)` — a custom property that is never defined.
 *
 * CSS fails silently here in a way nothing else in the toolchain catches. A
 * `var(--bg)` where the real token is `--bg-base` is not a TypeScript error,
 * not a lint error, and not a build error; the declaration simply becomes
 * invalid at computed-value time and the property falls back to `inherit` or
 * `unset`. The element paints *something*, so it rarely looks broken enough to
 * report — it just looks subtly wrong, and only in one theme.
 *
 * That is exactly what happened: a `<select>` in SpacingModal reached for
 * `var(--bg)` and rendered transparent for the life of the feature.
 *
 * This test deliberately checks only that a token is defined SOMEWHERE in the
 * source — not that it is in scope at the point of use. Scope would need a
 * cascade model to judge (a parent may set `--chip-ink` inline for a child
 * class to read, which is a legitimate and used pattern here). "Defined
 * nowhere" needs no such model and is always a bug.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every way this codebase legitimately defines a custom property. */
function definitionsIn(src: string): string[] {
  const found: string[] = [];
  // 1. A plain CSS declaration: `--token: value`. Covers globals.css and the
  //    per-page <style> blocks (the rules editor defines its category palette
  //    that way, light and dark).
  for (const m of src.matchAll(/(^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g)) found.push(m[2]);
  // 2. A React inline custom property: `['--chip-ink' as string]: value`.
  for (const m of src.matchAll(/['"](--[a-zA-Z0-9-]+)['"]\s*(?:as\s+string\s*)?\]?\s*:/g)) found.push(m[1]);
  // 3. next/font: `DM_Mono({ variable: '--font-mono' })` attaches the property
  //    to <html> at build time, so it is defined at runtime but appears in no
  //    stylesheet at all. The token sits on the RIGHT of the colon here, which
  //    is why it needs its own pattern — and why a stylesheet-only audit
  //    wrongly reports --font-mono (122 uses) as undefined.
  for (const m of src.matchAll(/variable\s*:\s*['"](--[a-zA-Z0-9-]+)['"]/g)) found.push(m[1]);
  return found;
}

// This file quotes `var(--…)` examples in its own prose and assertions, so it
// would otherwise report itself.
const files = sourceFiles(SRC).filter(f => !f.endsWith('cssTokens.test.ts'));
const defined = new Set<string>();
for (const f of files) for (const t of definitionsIn(readFileSync(f, 'utf8'))) defined.add(t);

/**
 * A `var(--token)` written in prose is documentation, not a use — boardTheme.ts
 * explains its own conventions that way. Comments are stripped before uses are
 * counted so the guard stays quiet about them.
 */
function stripComments(src: string, file: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // `//` is a comment in TS but not in CSS, and `https://` is neither.
  return /\.css$/.test(file) ? noBlocks : noBlocks.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('CSS custom properties', () => {
  it('defines every token that is used without a fallback', () => {
    const orphans: string[] = [];

    for (const file of files) {
      const src = stripComments(readFileSync(file, 'utf8'), file);
      // `var(--x)` with no comma — nothing catches it if --x is missing.
      // `var(--x, #fff)` is safe by construction, so it is not checked.
      for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
        if (!defined.has(m[1])) {
          orphans.push(`${m[1]} — used in ${file.slice(SRC.length + 1)}, defined nowhere`);
        }
      }
    }

    expect([...new Set(orphans)]).toEqual([]);
  });

  it('knows what a definition looks like', () => {
    // Guards the guard: if these patterns ever stop matching, the test above
    // starts passing vacuously, which is worse than no test at all.
    expect(definitionsIn(':root { --bg-base: #fff; }')).toContain('--bg-base');
    expect(definitionsIn("  --fs-xs: 11px; --fs-sm: 12.5px;")).toEqual(
      expect.arrayContaining(['--fs-xs', '--fs-sm']),
    );
    expect(definitionsIn("style={{ ['--chip-ink' as string]: c.color }}")).toContain('--chip-ink');
    expect(definitionsIn("DM_Mono({ variable: '--font-mono' })")).toContain('--font-mono');
    expect(definitionsIn('color: var(--text)')).toEqual([]);
  });

  it('finds the real stylesheet, not an empty directory', () => {
    expect(defined.has('--bg-base')).toBe(true);
    expect(defined.has('--text')).toBe(true);
    expect(defined.size).toBeGreaterThan(50);
  });
});

/**
 * The secondary text ramp must mean the same thing in both themes.
 *
 * The dark palette was originally written by mirroring light's slate steps,
 * which is the wrong operation: slate-700 reads as secondary text on white and
 * as 1.67:1 on #0d1b30 — text a sighted user simply cannot read. It also left
 * the ramp inverted, --text-dim less legible than --text-faint, so a component
 * that reached for the *more* prominent token got the *less* prominent one.
 * --text-dim had 197 uses across 50 files when this was found.
 *
 * What is asserted is the design rule, not the hex values: a token carries the
 * same weight in either theme, and the ramp orders the way its names promise.
 */
const THEME_CSS = readFileSync(join(SRC, 'app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function themeBlock(which: 'light' | 'dark'): Record<string, string> {
  // The dark selector also appears inside a comment above :root, which is why
  // comments are stripped before any index is taken.
  const darkAt = THEME_CSS.indexOf("[data-theme='dark']");
  const rootAt = THEME_CSS.indexOf(':root');
  if (rootAt < 0 || darkAt < rootAt) throw new Error('theme blocks not found in globals.css');
  const body = which === 'light' ? THEME_CSS.slice(rootAt, darkAt) : THEME_CSS.slice(darkAt);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  // Dark only overrides theme-variant tokens; the rest inherit from :root.
  return which === 'dark' ? { ...themeBlockLight, ...out } : out;
}

function relativeLuminance(hex: string): number {
  const ch = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const themeBlockLight = themeBlock('light');
const themes = { light: themeBlockLight, dark: themeBlock('dark') };

describe('secondary text ramp', () => {
  for (const theme of ['light', 'dark'] as const) {
    const t = themes[theme];
    const on = (tok: string) => contrast(t[tok], t['--bg-surface']);

    it(`orders muted > dim > faint in ${theme}`, () => {
      expect(t['--text-muted']).toBeTruthy();
      expect(on('--text-muted')).toBeGreaterThan(on('--text-dim'));
      expect(on('--text-dim')).toBeGreaterThan(on('--text-faint'));
    });

    it(`keeps body-weight text readable in ${theme}`, () => {
      // WCAG AA for normal-size text. --text-faint and --text-disabled are
      // exempt by role (decorative and disabled respectively).
      for (const tok of ['--text', '--text-muted', '--text-dim']) {
        expect.soft(on(tok), `${tok} on --bg-surface in ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`does not let disabled out-shout secondary text in ${theme}`, () => {
      expect(on('--text-disabled')).toBeLessThanOrEqual(on('--text-dim'));
    });
  }

  it('gives a token the same weight in both themes', () => {
    // The actual invariant the original bug broke. A component author picks a
    // token by how prominent it should be; that choice has to survive a theme
    // switch, or every screen needs per-theme review.
    for (const tok of ['--text-muted', '--text-dim', '--text-faint']) {
      const l = contrast(themes.light[tok], themes.light['--bg-surface']);
      const d = contrast(themes.dark[tok], themes.dark['--bg-surface']);
      expect.soft(d / l, `${tok}: light ${l.toFixed(2)}:1 vs dark ${d.toFixed(2)}:1`)
        .toBeGreaterThan(0.7);
    }
  });
});
