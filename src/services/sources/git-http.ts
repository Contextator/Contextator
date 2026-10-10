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
 * A response body as the iterator isomorphic-git reads. `return()` cancels the reader, which destroys
 * the socket, so a reader that stops early (an error status, an abort) does not leave a download open.
 */
function iterate(stream: ReadableStream<Uint8Array>): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  const iterator: AsyncIterableIterator<Uint8Array> = {
    async next() {
      const chunk = await reader.read();
      return chunk.done ? { done: true, value: undefined } : { done: false, value: chunk.value };
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

export function guardedGitHttp(egress: EgressFetch): GitHttpClient {
  return {
    async request({ url, method = 'GET', headers = {}, body, signal }) {
      const bytes = await collect(body);
      const response = await egress(url, { method, headers, ...(bytes ? { body: bytes } : {}), ...(signal ? { signal } : {}) });
      return {
        url: response.url || url,
        method,
        // isomorphic-git reads these lower-cased (`content-type`); `Headers` already folds repeats with ", ".
        headers: Object.fromEntries(response.headers.entries()),
        statusCode: response.status,
        statusMessage: response.statusText,
        ...(response.body ? { body: iterate(response.body) } : {}),
      };
    },
  };
}
