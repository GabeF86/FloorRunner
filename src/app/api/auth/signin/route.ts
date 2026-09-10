import { NextRequest, NextResponse } from 'next/server';
import { sbSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

// POST /api/auth/signin  { email, password }
//
// Public by classification (routeAccess PUBLIC_PREFIXES includes /api/auth) —
// it has to be, since the caller has no session yet by definition.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const { email, password } = body as { email?: unknown; password?: unknown };
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
  }

  const { data, error } = await sbSession().auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error || !data?.user) {
    // One message for every failure. Distinguishing "no such account" from
    // "wrong password" turns the login form into a directory of who works
    // here, which for a physician roster is worth withholding.
    return NextResponse.json({ error: 'Email or password is incorrect.' }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
