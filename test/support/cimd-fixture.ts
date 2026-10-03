import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { confluenceEgress, type EgressFetch } from '../../src/services/sources/confluence-egress.js';
import { fakeResolver, PUBLIC_FIXTURE_ADDRESS, routeToLoopback } from './egress-seams.js';

/**
 * A plain-HTTP server standing in for the host that serves a client ID metadata document. The route
 * under test only ever sees the `https://` URL the client sent; {@link fixtureMetadataFetch} is what
 * lets that reach this server.
 */
export class MetadataHost {
  readonly hits: string[] = [];
  private server?: http.Server;
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(404);
    res.end();
  };

  get port(): number {
    if (!this.server) throw new Error('metadata host not started');
    return (this.server.address() as AddressInfo).port;
  }

  /** Serves `body` as JSON with `headers`, on every path. */
  serveJson(body: unknown, headers: Record<string, string> = {}): void {
    this.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
  }

  /** Connections the server still holds open, as the server itself counts them. */
  connections(): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.server) return reject(new Error('metadata host not started'));
      this.server.getConnections((err, count) => (err ? reject(err) : resolve(count)));
    });
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.hits.push(req.url ?? '/');
      this.respond(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

/**
 * The production egress ([ADR-0088](../../.ssot/ADR.md#adr-0088)) with only the network edges
 * replaced: `names` stands in for DNS, a connection to the public fixture address is delivered to the
 * loopback interface **after** the address check, and an `https://` URL is sent as plain `http` to
 * `host`'s port, since there is no certificate to present. Everything else — the address rules, the
 * redirect hops, the per-hop recheck — is the code that runs in production.
 */
export function fixtureMetadataFetch(host: MetadataHost, names: Record<string, string>, timeoutMs = 2_000): EgressFetch {
  const egress = confluenceEgress({
    allowedHosts: [],
    allowListName: null,
    label: 'The client metadata host',
    resolve: fakeResolver(names),
    route: routeToLoopback(PUBLIC_FIXTURE_ADDRESS),
    timeoutMs,
  });
  return (input, init) => {
    const url = new URL(input);
    if (url.protocol === 'https:') {
      url.protocol = 'http:';
      url.port = String(host.port);
    }
    return egress(url.toString(), init);
  };
}
