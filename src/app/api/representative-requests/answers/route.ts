import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { listOwnRepresentativeMessages, listRepresentativeQueue } from '@/lib/representative-request-repository';
import { latestOwnAnswers, latestOwnReplies } from '@/lib/representative-answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The calling representative's own submitted answers for requests they answered: the structured answer (field,
 * value, note, time) of a missing-field request, or the free-text reply of a general request. Never other message
 * text, conversations or employee details.
 */
export async function GET() {
  const access = await requireApiRole('representative');
  if (access.response) return access.response;
  try {
    const mine = (await listRepresentativeQueue())
      .filter(request => request.assigned_representative_id === access.profile.userId && request.status === 'answered');
    const ids = mine.map(request => request.id);
    const messages = await listOwnRepresentativeMessages(access.profile.userId, [...new Set(mine.map(request => request.conversation_id))]);
    const answers = [
      ...latestOwnAnswers(messages, ids).map(({ requestId, field, value, note, answeredAt }) => ({ kind: 'field' as const, requestId, field, value, ...(note ? { note } : {}), answeredAt })),
      ...latestOwnReplies(messages, ids).map(({ requestId, text, answeredAt }) => ({ kind: 'general' as const, requestId, text, answeredAt }))
    ];
    return NextResponse.json({ answers }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'לא ניתן לטעון את התשובות שנשלחו' }, { status: 500 });
  }
}
