import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

// GET /api/auth/me — who the caller is, or nulls.
//
// Deliberately returns 200 with nulls for an anonymous caller rather than 401:
// this is how the UI decides whether to show a sign-out control at all, and an
// error status for the ordinary not-signed-in case would fill the console with
// noise on every page of an app that is, for now, mostly used signed out.
export async function GET() {
  const s = await currentSession();
  return NextResponse.json(
    { userId: s.userId, email: s.email, role: s.role, providerId: s.providerId },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
