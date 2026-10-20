import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { isUserRole } from '@/lib/auth-types';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');

  if (!code) {
    return NextResponse.redirect(
      new URL('/login?error=callback', requestUrl.origin)
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return NextResponse.redirect(
      new URL('/login?error=callback', requestUrl.origin)
    );
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(
      new URL('/login?error=callback', requestUrl.origin)
    );
  }

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (error || !profile || !isUserRole(profile.role)) {
    return NextResponse.redirect(
      new URL('/login?error=profile', requestUrl.origin)
    );
  }

  return NextResponse.redirect(
    new URL(
      profile.role === 'representative' ? '/representative' : '/',
      requestUrl.origin
    )
  );
}