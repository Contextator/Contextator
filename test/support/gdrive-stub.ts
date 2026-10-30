import { createPublicKey, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the two Google hosts the `gdrive` source talks to — the token endpoint and Drive v3 — on the
 * loopback interface ([ADR-0127](../../.ssot/ADR.md)). It is reached **through** the egress guard by made-up
 * host names (`test/support/egress-seams.ts`), so the pin, the address check and the redirect rules are the
 * production ones.
 *
 * **It checks what Google checks.** A sign-in is refused unless the assertion is an RS256 JWT, signed by the
 * key the stub was given, naming the stub's own token URL as `aud`, with `iss` the service account, the
 * `drive.readonly` scope, no `sub` and a lifetime of at most an hour. Every API call needs the bearer token the
 * stub issued. The key pair is generated for the test run; nothing here is, or was, a real credential.
 */

export const STUB_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const FOLDER = 'application/vnd.google-apps.folder';
export const DOC = 'application/vnd.google-apps.document';
export const SHEET = 'application/vnd.google-apps.spreadsheet';
export const SLIDES = 'application/vnd.google-apps.presentation';
export const FORM = 'application/vnd.google-apps.form';
export const SHORTCUT = 'application/vnd.google-apps.shortcut';

export const EXPORT_MIME = {
  [DOC]: 'text/markdown',
  [SHEET]: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  [SLIDES]: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

export interface StubFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  /** What a download (or, for a Google-native file, an export) returns. */
  content: Buffer;
  version: number;
  trashed: boolean;
  modifiedTime: string;
}

export type RequestKind = 'token' | 'startPageToken' | 'changes' | 'folder' | 'list' | 'media' | 'export' | 'other';

export interface LoggedRequest {
  kind: RequestKind;
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  /** Whether the request carried an `Authorization` header. */
  authorized: boolean;
}

export interface Scripted {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface TestKey {
  /** The JSON key file Google would issue, as the API receives it in `secret`. */
  keyFile: string;
  clientEmail: string;
  privateKeyId: string;
  privateKey: string;
}

/** A key pair made for this run, in the shape of Google's key file (with the `token_uri` the product must ignore). */
export function makeTestKey(
  clientEmail = 'reader@contextator-test.iam.gserviceaccount.com',
  privateKeyId = 'abcdef0123456789abcdef0123456789abcdef01',
): TestKey {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const keyFile = JSON.stringify({
    type: 'service_account',
    project_id: 'contextator-test',
    private_key_id: privateKeyId,
    private_key: privateKey,
    client_email: clientEmail,
    client_id: '123456789012345678901',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    // Hostile on purpose: nothing may ever be sent here.
    token_uri: 'https://evil.example.invalid/token',
    universe_domain: 'googleapis.com',
  });
  return { keyFile, clientEmail, privateKeyId, privateKey };
}

const b64urlJson = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

export class StubDrive {
  readonly files = new Map<string, StubFile>();
  readonly log: LoggedRequest[] = [];
  /** Answers handed out before real handling, one per request to the API (not the token endpoint), in order. */
  readonly scripted: Scripted[] = [];
  /** Answers handed out to the next token requests. */
  readonly scriptedTokens: Scripted[] = [];
  /** Position of the change feed: one step per mutation. */
  changeId = 1000;
  /** Changes by feed position, as file ids. */
  private readonly changes: Array<{ id: number; fileId: string }> = [];
  /** `expires_in` of the tokens issued. */
  tokenLifetime = 3600;
  /** Exports above this many bytes are refused the way Google refuses them. */
  exportLimit = 10 * 1024 * 1024;
  /** When set, `files.list` answers in reverse name order, to prove the driver sorts. */
  reverseListing = false;
  /** Folders whose children are not visible: `files.get` answers 404, as for a folder not shared with the account. */
  readonly unshared = new Set<string>();
  /** When set, a download is answered with a redirect to this URL. */
  redirectDownloadsTo?: string;
  /** Redirect only the first download. */
  redirectOnce = false;
  /** Files whose export or download fails with a 500, every time. */
  readonly failing = new Set<string>();
  pageSize = 1000;
  private issued = new Set<string>();
  private nextId = 1;
  server!: http.Server;
  port = 0;

  constructor(private readonly key: TestKey) {}

  /** The token endpoint and API base for a driver, with the host names a test routes to this server. */
  endpoints(tokenHost: string, apiHost: string): { tokenUrl: string; apiBase: string } {
    return { tokenUrl: `http://${tokenHost}:${this.port}/token`, apiBase: `http://${apiHost}:${this.port}/drive/v3` };
  }

  /** Forgets every access token it issued, as Google does when a key is revoked mid-run. */
  revokeTokens(): void {
    this.issued.clear();
  }

  // -- the tree ---------------------------------------------------------------------------------------

  id(): string {
    // Drive ids are 25 to 44 characters of letters, digits, "-" and "_".
    return `${String(this.nextId++).padStart(6, '0')}${randomBytes(12).toString('base64url')}`;
  }

  private touch(file: StubFile): void {
    file.version += 1;
    file.modifiedTime = new Date().toISOString();
    this.changeId += 1;
    this.changes.push({ id: this.changeId, fileId: file.id });
  }

  add(input: { name: string; mimeType?: string; parent?: string | null; content?: string | Buffer; id?: string }): StubFile {
    const file: StubFile = {
      id: input.id ?? this.id(),
      name: input.name,
      mimeType: input.mimeType ?? 'text/markdown',
      parents: input.parent ? [input.parent] : [],
      content: Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content ?? ''),
      version: 1,
      trashed: false,
      modifiedTime: new Date().toISOString(),
    };
    this.files.set(file.id, file);
    this.changeId += 1;
    this.changes.push({ id: this.changeId, fileId: file.id });
    return file;
  }

  folder(name: string, parent: string | null = null, id?: string): StubFile {
    return this.add({ name, mimeType: FOLDER, parent, ...(id ? { id } : {}) });
  }

  update(id: string, content: string | Buffer): void {
    const file = this.files.get(id);
    if (!file) throw new Error(`no file ${id}`);
    file.content = Buffer.isBuffer(content) ? content : Buffer.from(content);
    this.touch(file);
  }

  rename(id: string, name: string): void {
    const file = this.files.get(id);
    if (!file) throw new Error(`no file ${id}`);
    file.name = name;
    this.touch(file);
  }

  trash(id: string): void {
    const file = this.files.get(id);
    if (!file) throw new Error(`no file ${id}`);
    file.trashed = true;
    this.touch(file);
  }

  // -- the log ----------------------------------------------------------------------------------------

  count(kind: RequestKind): number {
    return this.log.filter((r) => r.kind === kind).length;
  }
  get apiRequests(): number {
    return this.log.filter((r) => r.kind !== 'token').length;
  }
  reset(): void {
    this.log.length = 0;
  }

  // -- the server -------------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private apiError(res: http.ServerResponse, status: number, reason: string, message: string, headers: Record<string, string> = {}): void {
    this.json(res, status, { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } }, headers);
  }

  /** The assertion, checked the way Google checks it; returns why it was refused, or `null`. */
  private refuseAssertion(assertion: string, expectedAudience: string): string | null {
    const parts = assertion.split('.');
    if (parts.length !== 3) return 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.';
    try {
      const header = b64urlJson(parts[0] as string);
      const claims = b64urlJson(parts[1] as string);
      if (header.alg !== 'RS256') return 'Invalid JWT: unsupported algorithm.';
      if (header.kid !== this.key.privateKeyId) return 'Invalid JWT: unknown key id.';
      const verify = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`);
      if (!verify.verify(createPublicKey(this.key.privateKey), Buffer.from(parts[2] as string, 'base64url'))) return 'Invalid JWT Signature.';
      if (claims.iss !== this.key.clientEmail) return 'Invalid issuer.';
      if (claims.scope !== STUB_SCOPE) return 'Invalid scope.';
      if (claims.aud !== expectedAudience) return 'Invalid audience.';
      if ('sub' in claims) return 'Domain-wide delegation is not enabled for this client.';
      const iat = Number(claims.iat);
      const exp = Number(claims.exp);
      if (!(exp > iat && exp - iat <= 3600)) return 'Invalid JWT: lifetime.';
      if (Math.abs(Date.now() / 1000 - iat) > 300) return 'Invalid JWT: iat is out of range.';
    } catch {
      return 'Invalid JWT: malformed.';
    }
    return null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://unused');
    const query = Object.fromEntries(url.searchParams.entries());
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    const route = url.pathname;
    const kind = this.kindOf(req.method ?? '', route, query);
    this.log.push({ kind, method: req.method ?? '', host, path: route, query, authorized: Boolean(req.headers.authorization) });

    if (kind === 'token') {
      const scripted = this.scriptedTokens.shift();
      if (scripted) return this.json(res, scripted.status, scripted.body, scripted.headers);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        return this.json(res, 400, { error: 'unsupported_grant_type', error_description: 'Invalid grant_type' });
      }
      const refusal = this.refuseAssertion(form.get('assertion') ?? '', `http://${req.headers.host}${route}`);
      if (refusal) return this.json(res, 400, { error: 'invalid_grant', error_description: refusal });
      const token = `ya29.${randomBytes(18).toString('base64url')}`;
      this.issued.add(token);
      return this.json(res, 200, { access_token: token, expires_in: this.tokenLifetime, token_type: 'Bearer' });
    }

    const scripted = this.scripted.shift();
    if (scripted) return this.json(res, scripted.status, scripted.body, scripted.headers);

    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!bearer || !this.issued.has(bearer)) {
      return this.apiError(res, 401, 'authError', 'Invalid Credentials');
    }

    if (kind === 'startPageToken') return this.json(res, 200, { startPageToken: String(this.changeId) });

    if (kind === 'changes') {
      const after = Number(query.pageToken);
      if (!Number.isFinite(after) || after < 0 || after > this.changeId) return this.apiError(res, 400, 'badRequest', 'Invalid Value');
      const pending = this.changes.filter((c) => c.id > after);
      const size = Number(query.pageSize ?? 100);
      const page = pending.slice(0, size);
      const more = pending.length > size;
      return this.json(res, 200, {
        changes: page.map((c) => ({ fileId: c.fileId })),
        ...(more ? { nextPageToken: String(page[page.length - 1]?.id) } : { newStartPageToken: String(this.changeId) }),
      });
    }

    const match = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(route);
    if (kind === 'list') return this.list(res, query);
    if (!match) return this.apiError(res, 404, 'notFound', 'Not found');
    const file = this.files.get(decodeURIComponent(match[1] as string));
    if (!file || this.unshared.has(file.id)) return this.apiError(res, 404, 'notFound', `File not found: ${decodeURIComponent(match[1] as string)}.`);

    if (kind === 'folder') {
      return this.json(res, 200, { id: file.id, name: file.name, mimeType: file.mimeType, trashed: file.trashed });
    }
    if ((kind === 'export' || kind === 'media') && this.failing.has(file.id)) {
      return this.apiError(res, 500, 'backendError', 'Backend Error');
    }
    if (kind === 'export') {
      const wanted = EXPORT_MIME[file.mimeType as keyof typeof EXPORT_MIME];
      if (!wanted) return this.apiError(res, 403, 'fileNotExportable', 'Export only supports Docs Editors files.');
      if (query.mimeType !== wanted) return this.apiError(res, 400, 'badRequest', 'Export format is not supported for this document.');
      if (file.content.length > this.exportLimit) {
        return this.apiError(res, 403, 'exportSizeLimitExceeded', 'This file is too large to be exported.');
      }
      res.writeHead(200, { 'content-type': wanted, 'content-length': String(file.content.length) });
      return void res.end(file.content);
    }
    if (kind === 'media') {
      if (this.redirectDownloadsTo) {
        res.writeHead(302, { location: this.redirectDownloadsTo });
        if (this.redirectOnce) this.redirectDownloadsTo = undefined;
        return void res.end();
      }
      if (file.mimeType.startsWith('application/vnd.google-apps.')) {
        return this.apiError(res, 403, 'fileNotDownloadable', 'Only files with binary content can be downloaded.');
      }
      res.writeHead(200, { 'content-type': file.mimeType, 'content-length': String(file.content.length) });
      return void res.end(file.content);
    }
    this.apiError(res, 404, 'notFound', 'Not found');
  }

  private kindOf(method: string, route: string, query: Record<string, string>): RequestKind {
    if (method === 'POST' && route === '/token') return 'token';
    if (method !== 'GET') return 'other';
    if (route === '/drive/v3/changes/startPageToken') return 'startPageToken';
    if (route === '/drive/v3/changes') return 'changes';
    if (route === '/drive/v3/files') return 'list';
    if (/^\/drive\/v3\/files\/[^/]+\/export$/.test(route)) return 'export';
    if (/^\/drive\/v3\/files\/[^/]+$/.test(route)) return query.alt === 'media' ? 'media' : 'folder';
    return 'other';
  }

  private list(res: http.ServerResponse, query: Record<string, string>): void {
    const parent = /^'((?:[^'\\]|\\.)*)' in parents and trashed = false$/.exec(query.q ?? '')?.[1]?.replace(/\\(.)/g, '$1');
    if (!parent) {
      this.apiError(res, 400, 'invalid', 'Invalid Value');
      return;
    }
    let all = [...this.files.values()].filter((f) => f.parents.includes(parent) && !f.trashed && !this.unshared.has(parent));
    all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (this.reverseListing) all = all.reverse();
    const start = query.pageToken ? Number(query.pageToken) : 0;
    const size = Math.min(Number(query.pageSize ?? this.pageSize), this.pageSize);
    const page = all.slice(start, start + size);
    const more = start + size < all.length;
    this.json(res, 200, {
      files: page.map((f) => {
        const native = f.mimeType.startsWith('application/vnd.google-apps.');
        return {
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          ...(native || f.mimeType === FOLDER ? {} : { size: String(f.content.length), md5Checksum: this.md5(f) }),
          version: String(f.version),
          modifiedTime: f.modifiedTime,
          webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
        };
      }),
      ...(more ? { nextPageToken: String(start + size) } : {}),
    });
  }

  private md5(file: StubFile): string {
    // Not a real MD5 (the product only compares the string): a digest that changes when the bytes do.
    let h = 0;
    for (const byte of file.content) h = (h * 31 + byte) >>> 0;
    return `${h.toString(16).padStart(8, '0')}${file.content.length.toString(16).padStart(24, '0')}`;
  }
}
