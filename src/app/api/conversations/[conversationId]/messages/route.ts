import { NextResponse } from 'next/server';
import { ZodError, z } from 'zod';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import {
  getConversation,
  listConversationMessages,
  sendConversationMessage
} from '@/lib/conversation-repository';
// Relative paths: these two run for real in the route tests (the test runner has no '@/' alias).
import { answerRejection, decodeRepAnswer, REP_ANSWER_KIND } from '../../../../../lib/representative-answer';
import { getRequestForRepresentative } from '../../../../../lib/representative-request-repository';
import {
  messageInputSchema,
  ownsConversation,
  messagePageQuerySchema
} from '@/lib/persistence-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const idSchema = z.string().uuid();
const querySchema = messagePageQuerySchema;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const profile = await getAuthenticatedProfile();
  if (!profile) {
    return NextResponse.json({ error: 'נדרשת התחברות' }, { status: 401 });
  }

  // Least privilege: a representative answers one missing field through the request itself and never reads the
  // employee's conversation or its salary details (the queue and their own answers have dedicated endpoints).
  if (profile.role !== 'employee') {
    return NextResponse.json({ error: 'אין הרשאה לפעולה הזו' }, { status: 403 });
  }
  const { conversationId } = await params;
  if (!idSchema.safeParse(conversationId).success) {
    return NextResponse.json({ error: 'מזהה השיחה אינו תקין' }, { status: 400 });
  }

  const url = new URL(request.url);
  const query = querySchema.safeParse({
    before: url.searchParams.get('before') ?? undefined,
    beforeId: url.searchParams.get('beforeId') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined
  });
  if (!query.success) {
    return NextResponse.json({ error: 'פרמטרי העימוד אינם תקינים' }, { status: 400 });
  }

  try {
    const conversation = await getConversation(
      conversationId,
      profile.userId,
      profile.role
    );
    if (
      !conversation ||
      (profile.role === 'employee' && !ownsConversation(
        conversation.owner_user_id,
        profile.userId,
        profile.role
      ))
    ) {
      return NextResponse.json({ error: 'השיחה לא נמצאה' }, { status: 404 });
    }

    const messages = await listConversationMessages(
      conversationId,
      query.data.before && query.data.beforeId
        ? { createdAt: query.data.before, id: query.data.beforeId }
        : null,
      query.data.limit
    );
    const oldest = messages[0];
    const nextCursor = messages.length === query.data.limit && oldest
      ? { before: oldest.created_at, beforeId: oldest.id }
      : null;
    return NextResponse.json({ messages, nextCursor });
  } catch {
    return NextResponse.json({ error: 'לא ניתן לטעון הודעות' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const profile = await getAuthenticatedProfile();
  if (!profile) {
    return NextResponse.json({ error: 'נדרשת התחברות' }, { status: 401 });
  }

  const { conversationId } = await params;
  if (!idSchema.safeParse(conversationId).success) {
    return NextResponse.json({ error: 'מזהה השיחה אינו תקין' }, { status: 400 });
  }

  try {
    const input = messageInputSchema.parse(await request.json());
    // A representative's structured answer is checked before it is stored: assigned request, still in their
    // handling (one answer per request), requested field and valid range. Free-text replies are unchanged.
    if (profile.role === 'representative' && input.body.includes(REP_ANSWER_KIND)) {
      const answer = decodeRepAnswer(input.body);
      if (!answer) return NextResponse.json({ error: 'מבנה התשובה אינו תקין.' }, { status: 400 });
      const rejection = answerRejection(await getRequestForRepresentative(answer.requestId), answer, conversationId, profile.userId);
      if (rejection) return NextResponse.json({ error: rejection }, { status: rejection.includes('כבר נשלחה') ? 409 : 400 });
    }
    const message = await sendConversationMessage(
      conversationId,
      profile.userId,
      profile.role,
      input.body,
      input.clientMessageId
    );
    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'מבנה ההודעה אינו תקין. זהות השולח נקבעת בשרת.' },
        { status: 400 }
      );
    }
    if (error instanceof Error && error.message === 'Conversation not found') {
      return NextResponse.json({ error: 'השיחה לא נמצאה' }, { status: 404 });
    }
    if (error instanceof Error && error.message.includes('Idempotency key reused')) {
      return NextResponse.json(
        { error: 'מפתח ההודעה כבר שימש לתוכן אחר' },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: 'לא ניתן לשלוח הודעה' }, { status: 403 });
  }
}
