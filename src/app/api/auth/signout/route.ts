import { NextResponse } from 'next/server';
import { sbSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function POST() {
  await sbSession().auth.signOut();
  return NextResponse.json({ ok: true });
}
