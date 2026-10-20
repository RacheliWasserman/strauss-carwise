import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { getConversation } from '@/lib/conversation-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const idSchema = z.string().uuid();

export async function GET(
  _request: Request,
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
    const conversation = await getConversation(
      conversationId,
      profile.userId,
      profile.role
    );
    if (!conversation) {
      return NextResponse.json({ error: 'השיחה לא נמצאה' }, { status: 404 });
    }
    return NextResponse.json({ conversation });
  } catch {
    return NextResponse.json({ error: 'לא ניתן לטעון את השיחה' }, { status: 500 });
  }
}
