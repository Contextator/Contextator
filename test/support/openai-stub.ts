/**
 * A real HTTP server that speaks OpenAI's `POST /embeddings` on a loopback port — the shape Ollama, vLLM,
 * Text Embeddings Inference and LM Studio all answer to — shared by the unit and integration suites.
 *
 * **It records every request**, because what this feature is about is what leaves the process: which
 * path the SDK hit, which strings it sent (with or without the prefixes), whether `dimensions` was in
 * the body, and whether an `Authorization` header went out. None of that is visible in the vectors.
 *
 * The vectors are a deterministic word-hash bag of words, L2-normalised, so a query and a passage that
 * share words are close and a search over them ranks sensibly — enough for a round trip through
 * PostgreSQL without a model.
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedEmbeddingRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: { model?: string; input?: string | string[]; dimensions?: number; encoding_format?: string; [key: string]: unknown };
}

export interface OpenAIStub {
  /** `http://127.0.0.1:<port>/v1` — what an operator would put in `EMBEDDING_BASE_URL`. */
  baseURL: string;
  port: number;
  requests: RecordedEmbeddingRequest[];
  /** Every input string the server was asked to embed, in order, across all requests. */
  inputs(): string[];
  close(): Promise<void>;
}

/** Word-hash bag of words, L2-normalised. Shared vocabulary is the whole of the similarity. */
export function bagOfWordsVector(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % dims;
    v[h] += 1;
  }
  const norm = Math.hypot(...v);
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

export interface OpenAIStubOptions {
  /** Length of every returned vector unless the request carries `dimensions`. */
  dims: number;
  /** Answer with this status and an OpenAI-shaped error body instead of vectors. */
  failWith?: number;
}

export async function startOpenAIStub(options: OpenAIStubOptions): Promise<OpenAIStub> {
  const requests: RecordedEmbeddingRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: RecordedEmbeddingRequest['body'] = {};
      try {
        body = raw === '' ? {} : (JSON.parse(raw) as RecordedEmbeddingRequest['body']);
      } catch {
        body = {};
      }
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });

      if (req.method !== 'POST' || !(req.url ?? '').endsWith('/embeddings')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      if (options.failWith !== undefined) {
        res.writeHead(options.failWith, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub failure', type: 'invalid_request_error' } }));
        return;
      }
      const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
      const dims = typeof body.dimensions === 'number' ? body.dimensions : options.dims;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          model: body.model,
          // Reversed on purpose: the provider sorts by `index`, and a server that answers in order would
          // let a provider that forgot to pass every test.
          data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: bagOfWordsVector(text, dims) })).reverse(),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    inputs: () => requests.flatMap((r) => (Array.isArray(r.body.input) ? r.body.input : r.body.input === undefined ? [] : [r.body.input])),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
