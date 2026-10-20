import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedProfile } from '@/lib/require-authenticated-user';
import { AssistantError, runAssistantTurn } from '@/lib/ai/assistant-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const input = z.object({ messageId: z.string().uuid(), statusOnly: z.boolean().optional() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return NextResponse.json({ error: 'אין הרשאה לפעולה הזו.' }, { status: 403 });
    const profile = await getAuthenticatedProfile();
    if (!profile) return NextResponse.json({ error: 'כדי להמשיך, צריך להתחבר שוב.' }, { status: 401 });
    if (profile.role !== 'employee') return NextResponse.json({ error: 'אין הרשאה לפעולה הזו.' }, { status: 403 });
    const { conversationId } = await params;
    if (!z.string().uuid().safeParse(conversationId).success || Number(request.headers.get('content-length') ?? 0) > 1024) {
      return NextResponse.json({ error: 'בקשה לא תקינה.' }, { status: 400 });
    }
    const raw = await request.text();
    if (raw.length > 1024) return NextResponse.json({ error: 'בקשה לא תקינה.' }, { status: 400 });
    const { messageId, statusOnly } = input.parse(JSON.parse(raw));
    const result = await runAssistantTurn(profile, conversationId, messageId, { statusOnly });
    return NextResponse.json(result, { status: result.status === 'pending' ? 202 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({ error: 'בקשה לא תקינה.' }, { status: 400 });
    const status = error instanceof AssistantError ? error.status : 503;
    const code = error instanceof AssistantError ? error.code : 'AI_UNAVAILABLE';
    console.warn('[carwise.ai.request]', { status, code: /^AI_[A-Z_]+$/.test(code) ? code : 'AI_UNAVAILABLE' });
    return NextResponse.json({ code, error: status === 429 ? 'כדאי להמתין רגע לפני הניסיון הבא.'
      : 'ההודעה שלך נשמרה, אבל לא הצלחנו להשלים את המענה כרגע. אפשר לנסות שוב.' },
    { status, headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '10' } : {}) } });
  }
}
