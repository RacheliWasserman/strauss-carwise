import 'server-only';

import { createSupabaseServerClient } from './supabase-server';
import { isUserRole, type UserRole } from './auth-types';

export type AuthenticatedProfile = {
  userId: string;
  role: UserRole;
};

export async function getAuthenticatedProfile(): Promise<AuthenticatedProfile | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: userError
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return null;
  }

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError || !profile || !isUserRole(profile.role)) {
    return null;
  }

  return { userId: user.id, role: profile.role };
}