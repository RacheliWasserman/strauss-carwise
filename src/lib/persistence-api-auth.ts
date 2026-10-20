import 'server-only';

import { NextResponse } from 'next/server';
import { getAuthenticatedProfile, type AuthenticatedProfile } from './require-authenticated-user';
import type { UserRole } from './auth-types';

export async function requireApiRole(
  role: UserRole
): Promise<{ profile: AuthenticatedProfile; response?: never } | { profile?: never; response: NextResponse }> {
  const profile = await getAuthenticatedProfile();

  if (!profile) {
    return {
      response: NextResponse.json(
        { error: 'נדרשת התחברות כדי להמשיך' },
        { status: 401 }
      )
    };
  }

  if (profile.role !== role) {
    return {
      response: NextResponse.json(
        { error: 'אין הרשאה לבצע פעולה זו' },
        { status: 403 }
      )
    };
  }

  return { profile };
}
