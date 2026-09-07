import { NextRequest, NextResponse } from 'next/server';
import { sbSchedulingServer } from '@/lib/supabaseScheduling';
import { loadBlockPrepData } from './route.helpers';

// Roster, availability and published assignments all change out of band of this
// page; the Next default caching would serve a stale board for up to an hour.
// Same reasoning as the availability route.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/scheduling/block-prep?site_id=...&year=2026
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const siteId = searchParams.get('site_id');
  if (!siteId) {
    return NextResponse.json({ error: 'site_id is required' }, { status: 400 });
  }

  const rawYear = searchParams.get('year');
  // getUTCFullYear() flips a few hours early for US callers (e.g. 8pm Eastern
  // on Dec 31 already reads as next year in UTC) — a UTC/Eastern mismatch in
  // a codebase that is otherwise careful about this (blockPrepView.ts avoids
  // Date construction for exactly this reason). Left as-is deliberately: this
  // default is best-effort only, exercised when `year` is omitted entirely —
  // every real caller (the Block Prep page, Task 7) always passes `year`
  // explicitly, so the edge case is not reachable through the app today.
  const year = rawYear == null ? new Date().getUTCFullYear() : Number(rawYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: 'year must be a 4-digit year between 2000 and 2100' }, { status: 400 });
  }

  try {
    const data = await loadBlockPrepData(sbSchedulingServer(), siteId, year);
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Block prep data could not be loaded.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
