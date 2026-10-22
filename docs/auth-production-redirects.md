# Production email confirmation

## Required dashboard settings (not changed by this patch)

Vercel project → Settings → Environment Variables → **Production**:

```
APP_SITE_URL=https://strauss-carwise.vercel.app
```

This is a server-only, non-secret origin. No path, credentials or query string. Apply it to a new production deployment. If absent in Vercel production, the app uses the system `VERCEL_PROJECT_PRODUCTION_URL` (HTTPS); it fails closed if neither is available. Local development without this variable uses its local request origin. Preview environments should have their own explicit canonical origin if email confirmation is needed there.

Confirm `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in Vercel Production identify the SAME Supabase project whose Auth settings you edited. Check privately in the dashboards; do not paste keys or connection strings. `SUPABASE_SECRET_KEY` remains server-only and must belong to that project as required by existing identity storage. There is no existing application variable named `SITE_URL`; Supabase's Site URL is a separate dashboard setting.

Supabase → Authentication → URL Configuration:

- Site URL: `https://strauss-carwise.vercel.app`
- Redirect URLs: exact entry `https://strauss-carwise.vercel.app/auth/callback`
- For local development only, retain `http://localhost:3000/auth/callback` if needed. A localhost entry does not force production redirects. Avoid broad production wildcard entries.

Supabase → Authentication → Email Templates → Confirm signup:

```html
<a href="{{ .ConfirmationURL }}">אישור החשבון</a>
```

Keep any desired surrounding email styling. Remove hardcoded localhost links or custom redirects that bypass Supabase verification. Do not replace this with a plain `.SiteURL` or `.RedirectTo` link: those alone do not verify the email. A custom token-hash template needs a separate `verifyOtp` flow, which this patch does not introduce. Current `/auth/callback` expects a PKCE `code`, exchanges it through the cookie-aware Supabase server client, checks the user/profile role and redirects without carrying the code forward.

## What inspection established

There is one `auth.signUp()` call, in `src/app/api/auth/register/route.ts`. Previously it explicitly sent `new URL(request.url).origin + '/auth/callback'`. There is no hardcoded localhost redirect in application code. An explicit `emailRedirectTo` is independent of changing the dashboard Site URL; it must be permitted by Supabase's redirect allowlist. The new shared origin resolver pins signup and callback redirects to trusted server configuration and rejects localhost in Vercel production. It never trusts arbitrary forwarded headers.

The observed localhost email cannot be attributed definitively without checking when/where it was generated, the email template and the actual production project's settings. Existing emails may carry destinations chosen when they were generated. No live template, Vercel environment values, Auth configuration or code exchange was inspected or changed here.

## Safe manual confirmation after configuration and an approved deployment

1. Register from the production `/register` page in a normal browser using an authorized test address and test identity. This action is for the owner to perform; no live account was created by this patch.
2. Use only a newly generated confirmation email. Privately inspect only the destination origin/path (and `redirect_to` destination if present); never share the full URL, token or code.
3. The confirmation must return to `https://strauss-carwise.vercel.app/auth/callback`, then to the application with a session. Open it in the registering browser so the PKCE verifier cookie is present.
4. A stale/already-used code or a different browser can fail the exchange; the app redirects to `/login?error=callback` rather than leaking error details. A past link landing on `/?code=...` never reaches this callback and does not prove an exchange failure in this route.

References: [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [email templates](https://supabase.com/docs/guides/auth/auth-email-templates), [Vercel environment variables](https://vercel.com/docs/environment-variables), [Vercel system variables](https://vercel.com/docs/environment-variables/system-environment-variables).
