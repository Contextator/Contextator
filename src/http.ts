import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';

/**
 * The Fastify options that are a **product decision** rather than a property of one process, in one
 * place so that there is one place ([ADR-0060](../.ssot/ADR.md#adr-0060)).
 *
 * `src/server.ts` cannot export this itself — importing that module runs the server — and the thing
 * this exists to prevent is precisely a second opinion: the integration harness carried its own
 * `trustProxy: true` for months, so a test that spoofed a header was asserting against a copy of the
 * server rather than against the server. Logging is deliberately left out, because that is where the
 * two legitimately differ.
 */
export function httpServerOptions(config: Config): Pick<FastifyServerOptions, 'bodyLimit' | 'forceCloseConnections' | 'trustProxy'> {
  return {
    bodyLimit: 4 * 1024 * 1024, // matches the MCP SDK's own body limit
    forceCloseConnections: true, // hijacked SSE sockets must not block shutdown
    /**
     * What `req.ip` is allowed to be, and therefore what the sign-in budget, `/oauth/register`'s
     * per-host budget and an audit event's address are keyed on. Off unless the operator names what is
     * in front of this instance; `TRUST_PROXY`'s own comment in `config.ts` carries the argument.
     */
    trustProxy: config.TRUST_PROXY,
  };
}

/**
 * The three things a wrong `TRUST_PROXY` costs, in the order an operator meets them
 * ([ADR-0060](../.ssot/ADR.md#adr-0060)). Written once because both branches below name them and
 * because a warning that does not say what broke is a warning nobody acts on.
 */
const TRUST_PROXY_CONSEQUENCES =
  'the per-IP sign-in limit is keyed on the proxy rather than on each caller, so one person’s failed ' +
  'sign-ins can lock the page for everybody; the OAuth metadata and the /mcp/* WWW-Authenticate pointer ' +
  'are built from req.protocol, so behind TLS they say http:// and every connector is answered ' +
  'invalid_target; and AUTH_COOKIE_SECURE=auto drops the Secure flag from the session cookie';

/**
 * Says, once, when this instance's `TRUST_PROXY` and its actual traffic disagree
 * ([ADR-0060](../.ssot/ADR.md#adr-0060)).
 *
 * **It is an observation and not a guess, and that is the whole design.** The obvious alternative is a
 * startup rule over the configuration — warn when `TRUST_PROXY` is off and `PUBLIC_BASE_URL` is unset,
 * say. That fires on the shipped `docker compose` installation, where nothing is in front and nothing
 * is wrong, so it would warn every operator on every start about a problem almost none of them have;
 * a warning that is usually false is a warning that is never read. Worse, the settings such a rule has
 * to key on (`PUBLIC_BASE_URL`, `AUTH_COOKIE_SECURE`) are the ones that *repair* two of the three
 * consequences, so it looks hardest at the installations that are least broken.
 *
 * What is actually diagnostic is a request: a forwarded header arriving while `req.ip` is still the
 * socket's own address means something in front is forwarding and this server is not listening to it.
 * That is evidence, it cannot fire on a deployment with no proxy, and it catches the case a startup
 * rule cannot see at all — a named list that does not match the proxy that is really there.
 *
 * `TRUST_PROXY=1` is the opposite failure and needs no evidence, because the danger is the setting
 * itself: it says nothing about traffic, so it is stated at startup and unconditionally.
 */
export function warnAboutProxyConfiguration(app: FastifyInstance, config: Config, warn: (message: string) => void): void {
  if (config.TRUST_PROXY === true) {
    warn(
      'TRUST_PROXY=1 trusts every proxy, so req.ip and req.protocol come from X-Forwarded-* headers ' +
        'whoever opened the socket wrote. That is only safe when nothing but your proxy can reach this ' +
        'port; if the port is reachable directly, a caller chooses its own rate-limit key. Prefer naming ' +
        'the proxy: TRUST_PROXY=loopback, or its address or CIDR block — and name the proxy rather than ' +
        'the network your clients are on, because the list is applied to every hop.',
    );
    return;
  }
  // A list is installed too: naming the wrong range is exactly as silent as naming nothing, and it is
  // the case no startup rule could have detected.
  let reported = false;
  app.addHook('onRequest', async (req) => {
    if (reported) return;
    const header = req.headers['x-forwarded-for'] ? 'X-Forwarded-For' : req.headers['x-forwarded-proto'] ? 'X-Forwarded-Proto' : undefined;
    // `req.ip` still being the peer means the trust list did not accept this hop — either because it is
    // `false`, or because it names a proxy that is not the one in front. A proxy that forwards for its
    // own address reads the same way and costs one log line, which is the right price for the trade.
    if (!header || req.ip !== req.socket.remoteAddress) return;
    reported = true;
    warn(
      `a request arrived carrying ${header} but TRUST_PROXY does not trust the peer it came from, so ` +
        `req.ip is the socket address and the header is ignored. If there is a reverse proxy in front of ` +
        `this instance, ${TRUST_PROXY_CONSEQUENCES}. Set TRUST_PROXY to that proxy's address or CIDR ` +
        `block (or loopback), and set PUBLIC_BASE_URL so the published URLs stop depending on the header ` +
        `at all. This is said once per start.`,
    );
  });
}
