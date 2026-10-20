import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { requireApiRole } from '@/lib/persistence-api-auth';
import {
  createConversationWithFirstMessage,
  listConversations
} from '@/lib/conversation-repository';
import { firstMessageSchema, messagePageQuerySchema } from '@/lib/persistence-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const access = await requireApiRole('employee');
  if (access.response) return access.response;

  const url = new URL(request.url);
  const query = messagePageQuerySchema.safeParse({
    before: url.searchParams.get('before') ?? undefined,
    beforeId: url.searchParams.get('beforeId') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined
  });
  if (!query.success) {
    return NextResponse.json({ error: 'פרמטרי העימוד אינם תקינים' }, { status: 400 });
  }

  try {
    const conversations = await listConversations(
      access.profile.userId,
      query.data.before && query.data.beforeId
        ? { createdAt: query.data.before, id: query.data.beforeId }
        : null,
      query.data.limit
    );
    const oldest = conversations[conversations.length - 1];
    const nextCursor = conversations.length === query.data.limit && oldest
      ? { before: oldest.last_message_at, beforeId: oldest.id }
      : null;
    return NextResponse.json({ conversations, nextCursor });
  } catch {
    return NextResponse.json(
      { error: 'לא ניתן לטעון את השיחות כרגע' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const access = await requireApiRole('employee');
  if (access.response) return access.response;

  try {
    const input = firstMessageSchema.parse(await request.json());
    const conversationId = await createConversationWithFirstMessage(
      input.body,
      input.clientRequestId
    );
    return NextResponse.json({ conversationId }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Idempotency key reused')) {
      return NextResponse.json(
        { error: 'מפתח הבקשה כבר שימש לתוכן אחר' },
        { status: 409 }
      );
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'ההודעה הראשונה אינה תקינה' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'לא ניתן לפתוח שיחה כרגע' },
      { status: 500 }
    );
  }
}
