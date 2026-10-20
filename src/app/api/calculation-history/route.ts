import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { listCalculationHistory } from '@/lib/calculation-history-repository';
import { calculationHistoryQuerySchema } from '@/lib/persistence-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const access = await requireApiRole('employee');
  if (access.response) return access.response;

  const url = new URL(request.url);
  const query = calculationHistoryQuerySchema.safeParse({
    conversationId: url.searchParams.get('conversationId') ?? undefined
  });
  if (!query.success) {
    return NextResponse.json({ error: 'מזהה השיחה אינו תקין' }, { status: 400 });
  }

  try {
    const runs = await listCalculationHistory(
      access.profile.userId,
      query.data.conversationId
    );
    return NextResponse.json({ runs });
  } catch {
    return NextResponse.json({ error: 'לא ניתן לטעון היסטוריית חישובים' }, { status: 500 });
  }
}