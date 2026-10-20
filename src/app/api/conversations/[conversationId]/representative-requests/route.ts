import { NextResponse } from 'next/server';
import { ZodError, z } from 'zod';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { getConversation } from '@/lib/conversation-repository';
import { requestRepresentativeSchema } from '@/lib/persistence-validation';
import { createRepresentativeRequest } from '@/lib/representative-request-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const conversationIdSchema = z.string().uuid();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const access = await requireApiRole('employee');
  if (access.response) return access.response;

  const { conversationId } = await params;
  if (!conversationIdSchema.safeParse(conversationId).success) {
    return NextResponse.json({ error: 'מזהה השיחה אינו תקין' }, { status: 400 });
  }

  try {
    const { topic = null } = requestRepresentativeSchema.parse(await request.json());
    const conversation = await getConversation(
      conversationId,
      access.profile.userId,
      access.profile.role
    );
    if (!conversation) {
      return NextResponse.json({ error: 'השיחה לא נמצאה' }, { status: 404 });
    }

    const representativeRequest = await createRepresentativeRequest(
      conversationId,
      access.profile.userId,
      topic
    );
    return NextResponse.json({ request: representativeRequest }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'פרטי הבקשה אינם תקינים' }, { status: 400 });
    }
    if (error instanceof Error && error.message.includes('active representative request')) {
      return NextResponse.json({ error: 'כבר קיימת בקשת נציג פעילה לשיחה' }, { status: 409 });
    }
    return NextResponse.json({ error: 'לא ניתן ליצור בקשת נציג' }, { status: 500 });
  }
}
