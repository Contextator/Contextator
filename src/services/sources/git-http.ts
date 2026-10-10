import type { EgressFetch } from './confluence-egress.js';

/**
 * isomorphic-git's `HttpClient`, with every request sent through the egress guard
 * ([ADR-0107](../../../.ssot/ADR.md#adr-0107)) instead of `isomorphic-git/http/node`'s unguarded one.
 *
 * The shapes below are the parts of isomorphic-git's `GitHttpRequest` / `GitHttpResponse` that
 * `clone`, `fetch` and `listServerRefs` use; the package's own types are not imported so that this file
 * does not depend on which entry point declares them.
 */
export interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  signal?: AbortSignal;
}

export interface GitHttpResponse {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: AsyncIterableIterator<Uint8Array>;
  statusCode: number;
  statusMessage: string;
}

export interface GitHttpClient {
  request(request: GitHttpRequest): Promise<GitHttpResponse>;
}

/**
 * The request body in one piece. Smart HTTP's `want`/`have` lines are small, and a redirect that keeps
 * the method (307/308) has to send the same bytes again, which a stream that has been read cannot do.
 * The response — the packfile — is **not** buffered: it is handed back as the stream it arrives as.
 */
async function collect(body: GitHttpRequest['body']): Promise<Uint8Array | undefined> {
  if (!body) return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of body as AsyncIterable<Uint8Array>) {
    parts.push(part);
    size += part.byteLength;
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
}

/**
 * What a response over `GIT_MAX_PACK_BYTES` fails with. isomorphic-git collects a packfile in memory
 * (twice, so a pack of *n* bytes peaks near 2 × *n*), so the limit is the only thing between a remote that
 * never stops sending and the process's heap. The message names the setting and its value because it ends
 * up verbatim in the source's last error.
 */
export class GitResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(
      `git remote response is larger than GIT_MAX_PACK_BYTES (${limit} bytes); raise GIT_MAX_PACK_BYTES or point the source at a smaller repository`,
    );
    this.name = 'GitResponseTooLargeError';
  }
}

/**
 * A response body as the iterator isomorphic-git reads. `return()` cancels the reader, which destroys
 * the socket, so a reader that stops early (an error status, an abort) does not leave a download open.
 * Bytes are counted as they are read; the chunk that carries the total past `maxBytes` is not handed
 * on, the reader is cancelled and the read fails with `GitResponseTooLargeError`, which is also handed to
 * `onExceeded` because the read's caller may swallow it (see `GuardedGitHttp.exceeded`).
 */
function iterate(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded: (err: GitResponseTooLargeError) => void,
): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  let read = 0;
  const iterator: AsyncIterableIterator<Uint8Array> = {
    async next() {
      const chunk = await reader.read();
      if (chunk.done) return { done: true, value: undefined };
      read += chunk.value.byteLength;
      if (read > maxBytes) {
        await reader.cancel().catch(() => undefined);
        const err = new GitResponseTooLargeError(maxBytes);
        onExceeded(err);
        throw err;
      }
      return { done: false, value: chunk.value };
    },
    async return() {
      await reader.cancel().catch(() => undefined);
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}

/** The declared length of a response, or `undefined` when there is none or it is not a plain number. */
function declaredLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/**
 * A client that remembers it cut a response off. isomorphic-git's pkt-line reader catches whatever a body
 * read throws and treats it as the end of the stream; the pack path looks at the stored error afterwards,
 * but the ref advertisement and `ls-refs` parsers never do, so they return a truncated list — or an
 * "empty response" error — as if nothing were wrong. The caller therefore asks `exceeded` after each
 * `clone` / `fetch` / `listServerRefs` and raises it itself, whatever the call returned.
 */
export interface GuardedGitHttp extends GitHttpClient {
  /** The first `GitResponseTooLargeError` this client raised, or `undefined` while none has been. */
  readonly exceeded: GitResponseTooLargeError | undefined;
}

/**
 * @param maxBytes `GIT_MAX_PACK_BYTES`: the most bytes any one response may carry. A response that
 *   declares more in `Content-Length` is refused without reading its body; one that does not declare it,
 *   or lies, is cut off when the bytes read pass the limit.
 */
export function guardedGitHttp(egress: EgressFetch, maxBytes: number): GuardedGitHttp {
  let exceeded: GitResponseTooLargeError | undefined;
  const exceed = (err: GitResponseTooLargeError): void => {
    exceeded ??= err;
  };
  return {
    get exceeded() {
      return exceeded;
    },
    async request({ url, method = 'GET', headers = {}, body, signal }) {
      const bytes = await collect(body);
      const response = await egress(url, { method, headers, ...(bytes ? { body: bytes } : {}), ...(signal ? { signal } : {}) });
      const declared = declaredLength(response.headers);
      if (declared !== undefined && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        const err = new GitResponseTooLargeError(maxBytes);
        exceed(err);
        throw err;
      }
      return {
        url: response.url || url,
        method,
        // isomorphic-git reads these lower-cased (`content-type`); `Headers` already folds repeats with ", ".
        headers: Object.fromEntries(response.headers.entries()),
        statusCode: response.status,
        statusMessage: response.statusText,
        ...(response.body ? { body: iterate(response.body, maxBytes, exceed) } : {}),
      };
    },
  };
}
