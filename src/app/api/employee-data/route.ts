import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { employeeDataDraftSchema } from '@/lib/persistence-validation';
import {
  createEmployeeDataVersion,
  listEmployeeDataVersions
} from '@/lib/employee-data-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const access = await requireApiRole('employee');
  if (access.response) return access.response;

  try {
    const versions = await listEmployeeDataVersions(access.profile.userId);
    return NextResponse.json({ versions });
  } catch {
    return NextResponse.json(
      { error: 'לא ניתן לטעון את נתוני הפרופיל' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const access = await requireApiRole('employee');
  if (access.response) return access.response;

  try {
    const input = employeeDataDraftSchema.parse(await request.json());
    const version = await createEmployeeDataVersion(
      access.profile.userId,
      input
    );
    return NextResponse.json({ version }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'פרטי העובד אינם תקינים' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'לא ניתן לשמור את פרטי העובד' },
      { status: 500 }
    );
  }
}
