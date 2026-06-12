import type { NextRequest } from 'next/server';

// Parse a request body as JSON, returning null instead of throwing on
// malformed input so handlers can answer 400 rather than crash with a 500.
export async function safeJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return (body && typeof body === 'object') ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// Names of required keys that are absent, null, undefined, or empty string.
// 0 and false are valid values and are NOT reported missing.
export function missingFields(obj: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter(k => {
    const v = obj[k];
    return v === undefined || v === null || v === '';
  });
}

// Next ordering position for an append: max(position)+1, 0 when empty.
export function nextPosition(rows: Array<{ position: number | null }>): number {
  let max = -1;
  for (const r of rows) {
    if (typeof r.position === 'number' && r.position > max) max = r.position;
  }
  return max + 1;
}
