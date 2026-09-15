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

describe('CSS custom properties', () => {
  it('defines every token that is used without a fallback', () => {
    const orphans: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
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
