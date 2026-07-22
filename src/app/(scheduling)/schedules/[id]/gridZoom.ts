// Grid zoom (Gabriel 2026-07-22): "change resolution so you can view more
// schedule on one page". Pure helpers for the schedule-detail grid's zoom
// control — level list, coercion of untrusted stored values, and the
// localStorage round-trip. The page applies the chosen level as CSS `zoom`
// on the grid container ONLY (never toolbar/banners/print), so every inline
// sizing literal, sticky header offset, and the month name-fit relationship
// scale together by construction.
//
// Kept out of the page monolith so vitest can cover it (the page itself is
// untested by convention).

/** Available zoom percentages, in the order the segmented control shows. */
export const GRID_ZOOM_LEVELS = [100, 85, 70, 55] as const;

export type GridZoomLevel = (typeof GRID_ZOOM_LEVELS)[number];

export const DEFAULT_GRID_ZOOM: GridZoomLevel = 100;

/** localStorage key — per-browser preference, mirrors scheduling.generateFillMode. */
export const GRID_ZOOM_STORAGE_KEY = 'floorRunner.gridZoom';

/**
 * Coerce an untrusted value (localStorage string, stale key, garbage) to a
 * valid level. Non-numeric input falls back to the default; numeric input
 * snaps to the NEAREST level (ties round up toward the larger percentage),
 * so an old key from a future/removed level list still lands somewhere sane.
 */
export function coerceGridZoom(raw: unknown): GridZoomLevel {
  // Empty/whitespace strings mean "unset", not Number('') === 0 → snap-to-55.
  const n = typeof raw === 'number' ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw)
    : NaN;
  if (!Number.isFinite(n)) return DEFAULT_GRID_ZOOM;
  let best: GridZoomLevel = DEFAULT_GRID_ZOOM;
  let bestDist = Infinity;
  for (const level of GRID_ZOOM_LEVELS) {
    const dist = Math.abs(level - n);
    // Strict `<` + descending level order ⇒ ties prefer the larger level.
    if (dist < bestDist) {
      best = level;
      bestDist = dist;
    }
  }
  return best;
}

/** Minimal Storage surface so tests inject a plain fake (no jsdom). */
export interface ZoomStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): ZoomStorage | null {
  // Guarded for SSR and for browsers where storage access throws
  // (e.g. Safari private mode / blocked third-party contexts).
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Read the persisted level (default 100). Safe to call from a lazy useState
 * initializer: on the server it returns the default; on the client it runs
 * before first paint, so the restored level renders without a layout flash.
 */
export function loadGridZoom(storage: ZoomStorage | null = defaultStorage()): GridZoomLevel {
  if (!storage) return DEFAULT_GRID_ZOOM;
  try {
    return coerceGridZoom(storage.getItem(GRID_ZOOM_STORAGE_KEY));
  } catch {
    return DEFAULT_GRID_ZOOM;
  }
}

/** Persist a level. Non-fatal on storage failure (matches fill-mode persistence). */
export function saveGridZoom(
  level: GridZoomLevel,
  storage: ZoomStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(GRID_ZOOM_STORAGE_KEY, String(level));
  } catch {
    /* non-fatal */
  }
}
