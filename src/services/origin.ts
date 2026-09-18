const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Shared by the MCP router (DNS-rebinding protection) and the dashboard's CSRF check.
 * An origin passes when it is explicitly allowed, when it is a loopback address, or when it is
 * the host the request was addressed to.
 */
export function isOriginAllowed(origin: string, host: string, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (LOCAL_HOSTS.has(url.hostname)) return true;
    return url.host === host;
  } catch {
    return false;
  }
}
