import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { listOwnRepresentativeMessages, listRepresentativeQueue } from '@/lib/representative-request-repository';
import { latestOwnAnswers } from '@/lib/representative-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The calling representative's own submitted answers for requests they answered. Returns only the structured
 * answer fields (field, value, note, time) — never message text, conversations or employee details.
 */
export async function GET() {
  const access = await requireApiRole('representative');
  if (access.response) return access.response;
  try {
    const mine = (await listRepresentativeQueue())
      .filter(request => request.assigned_representative_id === access.profile.userId && request.status === 'answered');
    const messages = await listOwnRepresentativeMessages(access.profile.userId, [...new Set(mine.map(request => request.conversation_id))]);
    const answers = latestOwnAnswers(messages, mine.map(request => request.id))
      .map(({ requestId, field, value, note, answeredAt }) => ({ requestId, field, value, ...(note ? { note } : {}), answeredAt }));
    return NextResponse.json({ answers }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'לא ניתן לטעון את התשובות שנשלחו' }, { status: 500 });
  }
}
