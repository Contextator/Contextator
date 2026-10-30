import fs from 'node:fs/promises';
import { MAX_CONVERTED_FILE_BYTES_DEFAULT, SOURCE_PAGE_LIMIT_DEFAULTS } from '../../config.js';
import type { DocumentSourceRow } from '../../db/schema.js';
import { decryptSecret, keyringOf } from '../crypto.js';
import { sourceCurrentDir } from '../data-dir.js';
import { ValidationError } from '../projects.js';
import { S3_SECRET, S3Client, defaultPathStyle, type S3Target } from '../s3/client.js';
import { parseSourceConfig, type S3Config } from '../sources.js';
import { sourceEgress, type EgressOptions } from './confluence-egress.js';
import { registerDriver, type DriverContext, type SourceDriver, type SyncResult } from './driver.js';
import { probeRemoteTree, syncRemoteTree, type RemoteObject, type RemoteStore } from './remote-store.js';

/**
 * An S3-compatible bucket as a source ([ADR-0126](../../../.ssot/ADR.md#adr-0126)): the objects under one
 * prefix whose extension the source reads, mirrored to `<source>/current/` with the prefix removed, then
 * indexed like any other directory. The pattern is `remote-store.ts`'s (list → version → download what
 * changed → remove what is gone); this class supplies the S3 half of it and nothing else.
 *
 * **What it costs when nothing changed is the listing.** `probe()` lists the whole prefix with
 * `ListObjectsV2` (1 000 keys a request) and downloads nothing; its token is derived by the same function
 * the sync derives the one it stores with, from the same list ([ADR-0048](../../../.ssot/ADR.md#adr-0048)
 * rule 3). A bucket with many keys outside the source's scope still has them all listed, which is why
 * `docs/document-sources.md` recommends a narrow prefix and the run's note says how many keys were listed.
 *
 * **Every request goes through the egress guard** (`sourceEgress`): the endpoint is typed by an editor.
 * Loopback and link-local are refused whatever the settings say; a private address only for a host named in
 * `SOURCE_ALLOWED_HOSTS`, and the refusal names that setting. With no `endpoint` the source is AWS and
 * takes `https` only.
 *
 * **What is not read.** Instance-profile and IRSA credentials come from the metadata address, which the
 * guard always refuses (ADR-0088 decision 1), and a session token is not accepted
 * ([ADR-0126](../../../.ssot/ADR.md#adr-0126) decision 3); the only credential is the key pair in `secret_enc`.
 */

/**
 * The most in-scope objects one listing is held in memory for. `S3_MAX_OBJECTS` (at most 100 000) bounds
 * what is *indexed*, but the probe token covers every object in scope, so the whole list is read; this is
 * the bound on that read, five times the largest ceiling, and past it the run fails with a message that says
 * to narrow the prefix rather than growing without limit.
 */
const MAX_LISTED_OBJECTS = 500_000;

/** Seconds of silence after which a request to the endpoint is abandoned. */
const REQUEST_TIMEOUT_MS = 60_000;

const CREDENTIAL_NOTE = 'S3 credentials come from the access key stored on the source; instance-profile and IRSA credentials are not supported.';

export interface S3DriverOptions {
  /** Test seam: shortens the retry back-off (production waits 500 ms × attempt). */
  retryDelayMs?: number;
}

export class S3Driver implements SourceDriver {
  private readonly cfg: S3Config;
  /** The key prefix as S3 matches it: `docs/`, or empty for the whole bucket. */
  private readonly keyPrefix: string;
  private readonly extensions: ReadonlySet<string>;
  private built?: S3Client;
  /** Throttling answers this driver's client saw (`503 SlowDown`); named in the sync's note. */
  private throttled = 0;
  /** Keys the last listing returned, in scope or not; the note shows it so a wide prefix is visible. */
  private listedKeys = 0;

  constructor(
    private readonly source: DocumentSourceRow,
    private readonly ctx: DriverContext,
    /**
     * Test seams for the egress guard: which address a name resolves to, and where an address that has
     * passed the check is dialled. Production passes neither; the check itself cannot be replaced.
     */
    private readonly egress?: Pick<EgressOptions, 'resolve' | 'route'>,
    private readonly options: S3DriverOptions = {},
  ) {
    this.cfg = parseSourceConfig('s3', source.config);
    this.keyPrefix = this.cfg.prefix ? `${this.cfg.prefix}/` : '';
    this.extensions = new Set(this.cfg.extensions.map((e) => e.toLowerCase()));
  }

  private client(): S3Client {
    if (this.built) return this.built;
    if (!this.source.secretEnc) throw new ValidationError(`This S3 source has no access key stored. ${CREDENTIAL_NOTE}`);
    const credential = S3_SECRET.parse(decryptSecret(this.source.secretEnc, keyringOf(this.ctx.config)));
    const pathStyle = this.cfg.pathStyle ?? defaultPathStyle({ endpoint: this.cfg.endpoint, bucket: this.cfg.bucket });
    if (!pathStyle && this.cfg.endpoint) {
      // `bucket.<ip>` is not a name anything resolves.
      const host = new URL(this.cfg.endpoint).hostname;
      if (/^[\d.]+$/.test(host) || host.includes(':')) {
        throw new ValidationError(
          'This S3 source addresses the bucket as a subdomain of the endpoint, which needs a host name; set path-style addressing for an IP address',
        );
      }
    }
    const target: S3Target = {
      endpoint: this.cfg.endpoint ?? null,
      region: this.cfg.region,
      bucket: this.cfg.bucket,
      pathStyle,
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
    };
    this.built = new S3Client(target, {
      fetch: sourceEgress({
        allowedHosts: this.ctx.config.SOURCE_ALLOWED_HOSTS ?? [],
        label: 'the S3 endpoint',
        subject: 'the endpoint',
        // With no endpoint the source is AWS: https only, on the first request and on every redirect.
        httpsOnly: !this.cfg.endpoint,
        timeoutMs: REQUEST_TIMEOUT_MS,
        ...this.egress,
      }),
      onThrottled: () => {
        this.throttled++;
        this.ctx.metrics?.countSourceThrottled?.('s3');
      },
      ...(this.options.retryDelayMs === undefined ? {} : { retryDelayMs: this.options.retryDelayMs }),
    });
    return this.built;
  }

  /** Whether an object (named relative to the prefix) is one this source reads. */
  private inScope(relative: string): boolean {
    const segments = relative.split('/');
    // The indexer's scan never enters a name that starts with a dot, so downloading it would be for nothing.
    if (segments.some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')) return false;
    const dot = relative.lastIndexOf('.');
    return dot >= 0 && this.extensions.has(relative.slice(dot + 1).toLowerCase());
  }

  /**
   * Every object in scope, named relative to the prefix — **the one listing the probe, the sync and Test all
   * read**, so the set the probe reports on is the set the run would index by construction.
   */
  private async listInScope(): Promise<RemoteObject[]> {
    const client = this.client();
    const found: RemoteObject[] = [];
    let listed = 0;
    for await (const page of client.listPages(this.keyPrefix)) {
      for (const object of page) {
        listed++;
        if (!object.key.startsWith(this.keyPrefix)) continue;
        const relative = object.key.slice(this.keyPrefix.length);
        if (relative === '' || !this.inScope(relative)) continue;
        found.push({ key: relative, version: object.etag, size: object.size });
        if (found.length > MAX_LISTED_OBJECTS) {
          throw new ValidationError(
            `This S3 source reads more than ${MAX_LISTED_OBJECTS} objects; narrow its prefix or its file types (S3_MAX_OBJECTS sets how many are indexed, not how many may be listed).`,
          );
        }
      }
    }
    this.listedKeys = listed;
    return found;
  }

  private store(): RemoteStore {
    return {
      list: () => this.listInScope(),
      download: async (object) => {
        const download = await this.client().getObject(`${this.keyPrefix}${object.key}`);
        return { body: download.body, ...(download.etag ? { version: download.etag } : {}) };
      },
    };
  }

  async docRoot(): Promise<string> {
    const dir = sourceCurrentDir(this.ctx.config.DATA_DIR, this.source.projectId, this.source.id);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** The bucket and prefix as an operator would paste them into `aws s3 ls`. */
  private get where(): string {
    return `s3://${this.cfg.bucket}${this.keyPrefix ? `/${this.keyPrefix}` : '/'}`;
  }

  async test(): Promise<string> {
    const objects = await this.listInScope();
    const kinds = this.cfg.extensions.map((e) => `.${e}`).join(', ');
    return `Connected to ${this.where} on ${this.client().host} — ${objects.length} object(s) with a readable type (${kinds}) among ${this.listedKeys} key(s) listed`;
  }

  /** `S3_MAX_OBJECTS`, or the default for a context built without it. */
  private get maxObjects(): number {
    return this.ctx.config.S3_MAX_OBJECTS ?? SOURCE_PAGE_LIMIT_DEFAULTS.S3_MAX_OBJECTS;
  }

  async sync(): Promise<SyncResult> {
    const result = await syncRemoteTree({
      store: this.store(),
      dataDir: this.ctx.config.DATA_DIR,
      projectId: this.source.projectId,
      sourceId: this.source.id,
      tokenPrefix: 's3',
      scope: JSON.stringify([this.cfg.endpoint ?? `aws:${this.cfg.region}`, this.cfg.bucket, this.cfg.prefix]),
      ceiling: { setting: 'S3_MAX_OBJECTS', noun: 'object', max: this.maxObjects },
      maxObjectBytes: this.ctx.config.MAX_CONVERTED_FILE_BYTES ?? MAX_CONVERTED_FILE_BYTES_DEFAULT,
      minFreeBytes: this.ctx.config.DATA_DIR_MIN_FREE_BYTES ?? 0,
    });
    if (result.truncated) {
      this.ctx.log.warn(
        { source: this.source.name, maxObjects: this.maxObjects },
        's3 source reached S3_MAX_OBJECTS; the objects past the ceiling are not indexed',
      );
    }
    const extras = [`${this.listedKeys} key(s) listed under ${this.where}`];
    if (this.throttled > 0) extras.push(`${this.throttled} throttling answer(s) from the endpoint`);
    return { note: `${result.note} [${extras.join('; ')}]`, configPatch: result.configPatch };
  }

  /**
   * The listing, hashed: `s3:v1:<count>:<sha256>` over the sorted `key\tETag\tsize` lines of every object in
   * scope, and no `GetObject` at all. An error is not caught here: the scheduler treats a probe that could
   * not answer as "run it".
   */
  async probe(): Promise<string | null> {
    return probeRemoteTree(this.store(), 's3');
  }
}

registerDriver('s3', (source, ctx) => new S3Driver(source, ctx));
