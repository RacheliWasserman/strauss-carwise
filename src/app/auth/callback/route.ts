import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase-server';
import { isUserRole } from '../../../lib/auth-types';
import { authOrigin } from '../../../lib/auth-origin';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  let origin: string;
  try { origin = authOrigin(request.url); }
  catch { return NextResponse.json({ error: 'הגדרת כתובת האתר אינה תקינה.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  const code = requestUrl.searchParams.get('code');

  if (!code) {
    return NextResponse.redirect(
      new URL('/login?error=callback', origin)
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return NextResponse.redirect(
      new URL('/login?error=callback', origin)
    );
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(
      new URL('/login?error=callback', origin)
    );
  }

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (error || !profile || !isUserRole(profile.role)) {
    return NextResponse.redirect(
      new URL('/login?error=profile', origin)
    );
  }

  return NextResponse.redirect(
    new URL(
      profile.role === 'representative' ? '/representative' : '/',
      origin
    )
  );
}
