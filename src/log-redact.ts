/**
 * Keeps OAuth/OIDC secrets out of request log lines ([ADR-0129](../.ssot/ADR.md#adr-0129) §3).
 *
 * At `LOG_LEVEL=debug|trace` Fastify logs every request, and `req.url` carries the query string. On the OIDC,
 * Notion OAuth and MCP OAuth endpoints the query holds `code` (a bearer-grade authorization code) and `state`
 * (the CSRF binding of the flow), neither of which belongs in a log. Path and every other parameter stay as they
 * are, so the line is still useful for debugging.
 */

const REDACTED_PARAMS: ReadonlySet<string> = new Set(['code', 'state']);

export const REDACTED_VALUE = '[redacted]';

function paramName(pair: string): string {
  const raw = pair.split('=', 1)[0] ?? '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

/** Replaces the value of the `code` and `state` query parameters of a request URL; a URL without a query is returned unchanged. */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const hashStart = url.indexOf('#', queryStart);
  const queryEnd = hashStart === -1 ? url.length : hashStart;
  const query = url.slice(queryStart + 1, queryEnd);
  const redacted = query
    .split('&')
    .map((pair) => (pair.includes('=') && REDACTED_PARAMS.has(paramName(pair)) ? `${pair.slice(0, pair.indexOf('='))}=${REDACTED_VALUE}` : pair))
    .join('&');
  return `${url.slice(0, queryStart + 1)}${redacted}${url.slice(queryEnd)}`;
}

interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number };
}

/**
 * Fastify's default `req` serializer with the URL passed through {@link redactUrl}. The fields are the ones
 * Fastify logs by default, so turning this on changes nothing but the query values.
 */
export function serializeRequest(req: LoggedRequest): {
  method?: string;
  url?: string;
  version?: string;
  host?: string;
  remoteAddress?: string;
  remotePort?: number;
} {
  const version = req.headers?.['accept-version'];
  return {
    method: req.method,
    url: req.url === undefined ? undefined : redactUrl(req.url),
    version: typeof version === 'string' ? version : undefined,
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
}
