import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { listCalculationScenarios } from '@/lib/calculation-history-repository';
import { calculationRunIdSchema } from '@/lib/persistence-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const access = await requireApiRole('employee');
  if (access.response) return access.response;

  const { runId } = await params;
  if (!calculationRunIdSchema.safeParse(runId).success) {
    return NextResponse.json({ error: 'מזהה החישוב אינו תקין' }, { status: 400 });
  }

  try {
    const scenarios = await listCalculationScenarios(runId, access.profile.userId);
    return NextResponse.json({ scenarios });
  } catch {
    return NextResponse.json({ error: 'לא ניתן לטעון תרחישי חישוב' }, { status: 500 });
  }
}