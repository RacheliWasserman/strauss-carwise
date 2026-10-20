import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { requireApiRole } from '@/lib/persistence-api-auth';
import { versionIdSchema } from '@/lib/persistence-validation';
import { confirmEmployeeDataVersion } from '@/lib/employee-data-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const access = await requireApiRole('employee');
  if (access.response) return access.response;

  try {
    const { versionId } = versionIdSchema.parse(await request.json());
    const version = await confirmEmployeeDataVersion(
      access.profile.userId,
      versionId
    );

    if (!version) {
      return NextResponse.json(
        { error: 'טיוטת הנתונים לא נמצאה או שכבר אושרה' },
        { status: 404 }
      );
    }

    return NextResponse.json({ version });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json(
        { error: 'מזהה גרסת הנתונים אינו תקין' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: 'לא ניתן לאשר את נתוני העובד' },
      { status: 500 }
    );
  }
}
