import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { claimRepresentativeRequest } from '@/lib/representative-request-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const idSchema = z.string().uuid();

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const access = await requireApiRole('representative');
  if (access.response) return access.response;

  const { requestId } = await params;
  if (!idSchema.safeParse(requestId).success) {
    return NextResponse.json({ error: 'מזהה הבקשה אינו תקין' }, { status: 400 });
  }

  try {
    const claimedRequestId = await claimRepresentativeRequest(requestId);
    return NextResponse.json({ requestId: claimedRequestId });
  } catch {
    return NextResponse.json(
      { error: 'הבקשה אינה זמינה או שכבר נתפסה' },
      { status: 409 }
    );
  }
}
