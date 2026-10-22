/** Trusted server configuration only: never use client-supplied forwarded headers. */
export function authOrigin(requestUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const production = env.VERCEL_ENV === 'production';
  const configured = env.APP_SITE_URL?.trim();
  const deploymentDomain = production ? env.VERCEL_PROJECT_PRODUCTION_URL?.trim() : undefined;
  const value = configured || (deploymentDomain ? `https://${deploymentDomain}` : undefined);
  if (production && !value) throw new Error('Auth site origin is not configured');
  const url = new URL(value || new URL(requestUrl).origin);
  const loopback = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
    url.hostname === '[::1]' || /^127\./.test(url.hostname) || url.hostname === '0.0.0.0';
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !production)) ||
    (production && loopback)) throw new Error('Auth site origin is invalid');
  return url.origin;
}
