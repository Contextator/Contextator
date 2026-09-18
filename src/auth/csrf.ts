import { isOriginAllowed } from '../services/origin.js';

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type Headers = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * CORS is not a CSRF defence: it governs reading the response, not sending the request, and a
 * cross-site form can POST `multipart/form-data` at us regardless. `SameSite=Lax` already keeps the
 * session cookie off those requests; this is the second door, and it also covers a sibling
 * subdomain that Lax would let through.
 *
 * Only applied to cookie-authenticated unsafe requests. A bearer token carries no ambient
 * credential, so curl and CI — which send neither Origin nor Sec-Fetch-Site — are exempt.
 */
export function isSameSiteRequest(headers: Headers, host: string, allowedOrigins: readonly string[]): boolean {
  const fetchSite = first(headers['sec-fetch-site']);
  if (fetchSite) return fetchSite === 'same-origin' || fetchSite === 'none';

  const origin = first(headers.origin);
  if (origin) return isOriginAllowed(origin, host, allowedOrigins);

  // Older browsers still send Referer on a cross-site form post.
  const referer = first(headers.referer);
  if (referer) return isOriginAllowed(new URL(referer, `http://${host}`).origin, host, allowedOrigins);

  // Neither header: this is not a request a browser made from a page we served.
  return false;
}
