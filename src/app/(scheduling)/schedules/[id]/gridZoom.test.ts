import { describe, it, expect } from 'vitest';
import {
  GRID_ZOOM_LEVELS, DEFAULT_GRID_ZOOM, GRID_ZOOM_STORAGE_KEY,
  coerceGridZoom, loadGridZoom, saveGridZoom,
  type ZoomStorage,
} from './gridZoom';

function fakeStorage(initial: Record<string, string> = {}): ZoomStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
  };
}

describe('grid zoom levels', () => {
  it('offers 100/85/70/55 in control order (100 first)', () => {
    expect([...GRID_ZOOM_LEVELS]).toEqual([100, 85, 70, 55]);
  });
  it('defaults to 100%', () => {
    expect(DEFAULT_GRID_ZOOM).toBe(100);
    expect(GRID_ZOOM_LEVELS).toContain(DEFAULT_GRID_ZOOM);
  });
});

describe('coerceGridZoom', () => {
  it('passes through every valid level (number or stored string)', () => {
    for (const level of GRID_ZOOM_LEVELS) {
      expect(coerceGridZoom(level)).toBe(level);
      expect(coerceGridZoom(String(level))).toBe(level);
    }
  });
  it('falls back to default for null / undefined / garbage', () => {
    expect(coerceGridZoom(null)).toBe(DEFAULT_GRID_ZOOM);
    expect(coerceGridZoom(undefined)).toBe(DEFAULT_GRID_ZOOM);
    expect(coerceGridZoom('huge')).toBe(DEFAULT_GRID_ZOOM);
    expect(coerceGridZoom('')).toBe(DEFAULT_GRID_ZOOM);
    expect(coerceGridZoom(NaN)).toBe(DEFAULT_GRID_ZOOM);
    expect(coerceGridZoom({})).toBe(DEFAULT_GRID_ZOOM);
  });
  it('clamps out-of-range numbers to the nearest end', () => {
    expect(coerceGridZoom(500)).toBe(100);
    expect(coerceGridZoom(10)).toBe(55);
    expect(coerceGridZoom(-40)).toBe(55);
  });
  it('snaps in-between numbers to the nearest level (ties go larger)', () => {
    expect(coerceGridZoom(90)).toBe(85);
    expect(coerceGridZoom(96)).toBe(100);
    expect(coerceGridZoom(92.5)).toBe(100); // tie → larger
    expect(coerceGridZoom(60)).toBe(55);
    expect(coerceGridZoom(77.5)).toBe(85); // tie → larger
  });
});

describe('persistence round-trip', () => {
  it('save then load returns the same level for every level', () => {
    for (const level of GRID_ZOOM_LEVELS) {
      const storage = fakeStorage();
      saveGridZoom(level, storage);
      expect(storage.data[GRID_ZOOM_STORAGE_KEY]).toBe(String(level));
      expect(loadGridZoom(storage)).toBe(level);
    }
  });
  it('load with nothing stored returns the default', () => {
    expect(loadGridZoom(fakeStorage())).toBe(DEFAULT_GRID_ZOOM);
  });
  it('load with a corrupt stored value returns the default', () => {
    expect(loadGridZoom(fakeStorage({ [GRID_ZOOM_STORAGE_KEY]: 'banana' }))).toBe(DEFAULT_GRID_ZOOM);
  });
  it('load with a stale numeric value snaps to the nearest live level', () => {
    expect(loadGridZoom(fakeStorage({ [GRID_ZOOM_STORAGE_KEY]: '75' }))).toBe(70);
  });
  it('null storage (SSR / storage blocked) is safe on both paths', () => {
    expect(loadGridZoom(null)).toBe(DEFAULT_GRID_ZOOM);
    expect(() => saveGridZoom(85, null)).not.toThrow();
  });
  it('a throwing storage never propagates', () => {
    const bomb: ZoomStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(loadGridZoom(bomb)).toBe(DEFAULT_GRID_ZOOM);
    expect(() => saveGridZoom(70, bomb)).not.toThrow();
  });
});
