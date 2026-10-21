import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { getRequestForRepresentative } from '@/lib/representative-request-repository';
// Relative path: runs for real in the route tests (the test runner has no '@/' alias).
import { revealRequestNationalId } from '../../../../../lib/identity/identity-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Never cached anywhere: not by the browser, a proxy or Next.js. */
const PRIVATE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0' };
/** One answer for every refusal, so it reveals nothing about the request, the employee or the ID. */
const UNAVAILABLE = () => NextResponse.json({ error: 'הפרט אינו זמין עבור הפנייה הזו.' }, { status: 404, headers: PRIVATE });

const reveals = new Map<string, number[]>();
function allow(userId: string, now = Date.now()) {
  const recent = (reveals.get(userId) ?? []).filter(time => now - time < 10 * 60_000);
  if (recent.length >= 20 || (!reveals.has(userId) && reveals.size >= 4096)) return false;
  reveals.set(userId, [...recent, now]);
  return true;
}

/**
 * The full national ID of a request's owner, only for the representative who personally claimed THIS request and
 * only while it is exactly 'claimed'. Checked here (role, request, assignment, status) and again inside the
 * database function, which also records the access. POST, so it is never prefetched or cached as a page read.
 * The ID is never logged; logs carry the outcome only.
 */
export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return NextResponse.json({ error: 'אין הרשאה לפעולה הזו.' }, { status: 403, headers: PRIVATE });
  const access = await requireApiRole('representative');
  if (access.response) { access.response.headers.set('Cache-Control', PRIVATE['Cache-Control']); return access.response; }
  const { requestId } = await params;
  if (!z.string().uuid().safeParse(requestId).success) return UNAVAILABLE();
  if (!allow(access.profile.userId)) return NextResponse.json({ error: 'יותר מדי בקשות. אפשר לנסות שוב בעוד כמה דקות.' }, { status: 429, headers: PRIVATE });

  let row;
  try { row = await getRequestForRepresentative(requestId); } catch { row = null; }
  const assigned = Boolean(row && row.id === requestId && row.assigned_representative_id === access.profile.userId && row.status === 'claimed');
  if (!assigned) { console.info('[carwise.identity]', { phase: 'reveal', outcome: 'not_assigned_or_not_claimed' }); return UNAVAILABLE(); }

  const nationalId = await revealRequestNationalId(requestId);
  if (!nationalId) return UNAVAILABLE();
  console.info('[carwise.identity]', { phase: 'reveal', outcome: 'revealed' });
  return NextResponse.json({ nationalId }, { headers: PRIVATE });
}
