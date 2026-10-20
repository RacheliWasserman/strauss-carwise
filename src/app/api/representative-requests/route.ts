import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { listRepresentativeQueue } from '@/lib/representative-request-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const access = await requireApiRole('representative');
  if (access.response) return access.response;

  try {
    const requests = await listRepresentativeQueue();
    return NextResponse.json({ requests });
  } catch {
    return NextResponse.json({ error: 'לא ניתן לטעון את תור הבקשות' }, { status: 500 });
  }
}
