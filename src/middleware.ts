import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isUserRole } from './lib/auth-types';

function redirectWithCookies(
  request: NextRequest,
  response: NextResponse,
  path: string
) {
  const redirectResponse = NextResponse.redirect(
    new URL(path, request.url)
  );

  response.cookies.getAll().forEach(({ name, value, ...options }) => {
    redirectResponse.cookies.set(name, value, options);
  });

  return redirectResponse;
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (
    pathname.startsWith('/api/') ||
    pathname === '/login' ||
    pathname === '/register' ||
    pathname.startsWith('/auth/')
  ) {
    return NextResponse.next({ request });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    return NextResponse.redirect(
      new URL('/login?error=config', request.url)
    );
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    supabaseUrl,
    supabasePublishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );

          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        }
      }
    }
  );

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectWithCookies(request, response, '/login');
  }

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (error || !profile || !isUserRole(profile.role)) {
    return redirectWithCookies(
      request,
      response,
      '/login?error=profile'
    );
  }

  if (pathname === '/representative' && profile.role !== 'representative') {
    return redirectWithCookies(request, response, '/employee');
  }

  if (
    pathname === '/' &&
    profile.role === 'representative' &&
    process.env.NODE_ENV === 'production'
  ) {
    return redirectWithCookies(request, response, '/representative');
  }

  if (pathname === '/' && profile.role === 'employee') {
    return redirectWithCookies(request, response, '/employee');
  }

  if (pathname === '/employee' && profile.role === 'representative') {
    return redirectWithCookies(request, response, '/representative');
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'
  ]
};