import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { EnvSchema } from '../src/config.js';
import type { Logger } from '../src/context.js';
import {
  endpointIdSegment,
  OPENAI_DEFAULT_BASE_URL,
  OpenAIEmbeddingProvider,
  type OpenAIEmbeddingOptions,
} from '../src/services/embeddings/openai.js';
import { type OpenAIStub, startOpenAIStub } from './support/openai-stub.js';

/**
 * A self-hosted OpenAI-compatible endpoint: where the requests go, what they carry, and what the endpoint
 * does to `provider.id` (ADR-0007). Every request assertion is made against a real HTTP server on a
 * loopback port, because the point is what leaves the process — not what the provider believes it sent.
 */

const silentLog = {
  level: 'silent',
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  silent: () => {},
  child: () => silentLog,
} as unknown as Logger;

const DIMS = 8;

const provider = (overrides: Partial<OpenAIEmbeddingOptions>) =>
  new OpenAIEmbeddingProvider({ apiKey: '', model: 'nomic-embed-text', dimensions: DIMS, log: silentLog, ...overrides });

let stub: OpenAIStub;

beforeAll(async () => {
  stub = await startOpenAIStub({ dims: DIMS });
});

afterAll(async () => {
  await stub.close();
});

afterEach(() => {
  stub.requests.length = 0;
});

describe('requests to an OpenAI-compatible endpoint', () => {
  it('go to the configured base URL, not to api.openai.com', async () => {
    const vectors = await provider({ baseURL: stub.baseURL }).embedPassages(['alpha', 'beta']);
    expect(vectors).toHaveLength(2);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe('POST');
    expect(stub.requests[0].path).toBe('/v1/embeddings');
    expect(stub.requests[0].body.model).toBe('nomic-embed-text');
  });

  it('keep the inputs in order even when the server answers out of order', async () => {
    const [alpha, beta] = await provider({ baseURL: stub.baseURL }).embedPassages(['alpha', 'beta']);
    const [alphaAlone] = await provider({ baseURL: stub.baseURL }).embedPassages(['alpha']);
    expect(alpha).toEqual(alphaAlone);
    expect(beta).not.toEqual(alphaAlone);
  });

  it('carry the passage prefix on passages and the query prefix on queries', async () => {
    const p = provider({ baseURL: stub.baseURL, prefixes: { query: 'search_query: ', passage: 'search_document: ' } });
    await p.embedPassages(['how indexing works']);
    await p.embedQuery('indexing');
    expect(stub.inputs()).toEqual(['search_document: how indexing works', 'search_query: indexing']);
  });

  it('carry no prefix when none is configured', async () => {
    const p = provider({ baseURL: stub.baseURL });
    await p.embedPassages(['plain']);
    await p.embedQuery('plain');
    expect(stub.inputs()).toEqual(['plain', 'plain']);
  });

  it('ask a self-hosted server for floats, since base64 is not universally implemented', async () => {
    await provider({ baseURL: stub.baseURL }).embedQuery('x');
    expect(stub.requests[0].body.encoding_format).toBe('float');
  });

  it('send `dimensions` only when the mode says so', async () => {
    const sent = async (overrides: Partial<OpenAIEmbeddingOptions>) => {
      stub.requests.length = 0;
      await provider({ baseURL: stub.baseURL, ...overrides }).embedQuery('x');
      return stub.requests[0].body.dimensions;
    };
    // auto: the text-embedding-3 family only — what this provider always did.
    expect(await sent({ model: 'text-embedding-3-small' })).toBe(DIMS);
    expect(await sent({ model: 'nomic-embed-text' })).toBeUndefined();
    expect(await sent({ model: 'nomic-embed-text', requestDimensions: 'auto' })).toBeUndefined();
    // always: a Matryoshka model behind vLLM or TEI that takes the parameter under another name.
    expect(await sent({ model: 'nomic-embed-text', requestDimensions: 'always' })).toBe(DIMS);
    // never: a server that rejects the field even for a text-embedding-3 alias.
    expect(await sent({ model: 'text-embedding-3-small', requestDimensions: 'never' })).toBeUndefined();
  });

  it('carry no Authorization header when the endpoint takes no key, and a bearer token when it does', async () => {
    await provider({ baseURL: stub.baseURL, apiKey: '' }).embedQuery('x');
    expect(stub.requests[0].headers.authorization).toBeUndefined();

    stub.requests.length = 0;
    await provider({ baseURL: stub.baseURL, apiKey: 'sk-test-key' }).embedQuery('x');
    expect(stub.requests[0].headers.authorization).toBe('Bearer sk-test-key');
  });

  it('are not redirected by OPENAI_BASE_URL in the process environment', async () => {
    const decoy = await startOpenAIStub({ dims: DIMS });
    const previous = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = decoy.baseURL;
    try {
      await provider({ baseURL: stub.baseURL }).embedQuery('x');
      expect(stub.requests).toHaveLength(1);
      expect(decoy.requests).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previous;
      await decoy.close();
    }
  });

  it('follow the legacy OPENAI_BASE_URL when it is the only one set, and the new name when both are', async () => {
    const other = await startOpenAIStub({ dims: DIMS });
    try {
      await provider({ legacyBaseURL: stub.baseURL }).embedQuery('x');
      expect(stub.requests).toHaveLength(1);

      await provider({ baseURL: other.baseURL, legacyBaseURL: stub.baseURL }).embedQuery('x');
      expect(stub.requests).toHaveLength(1);
      expect(other.requests).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it('do not carry OPENAI_ORG_ID or OPENAI_PROJECT_ID from the environment to a self-hosted server', async () => {
    const saved = { org: process.env.OPENAI_ORG_ID, project: process.env.OPENAI_PROJECT_ID };
    process.env.OPENAI_ORG_ID = 'org-leak';
    process.env.OPENAI_PROJECT_ID = 'proj-leak';
    try {
      await provider({ baseURL: stub.baseURL, apiKey: 'sk-test-key' }).embedQuery('x');
      await provider({ legacyBaseURL: stub.baseURL }).embedQuery('x');
      expect(stub.requests).toHaveLength(2);
      for (const request of stub.requests) {
        expect(request.headers['openai-organization']).toBeUndefined();
        expect(request.headers['openai-project']).toBeUndefined();
      }
    } finally {
      if (saved.org === undefined) delete process.env.OPENAI_ORG_ID;
      else process.env.OPENAI_ORG_ID = saved.org;
      if (saved.project === undefined) delete process.env.OPENAI_PROJECT_ID;
      else process.env.OPENAI_PROJECT_ID = saved.project;
    }
  });

  it('fail loudly when the server returns vectors of the wrong length', async () => {
    await expect(provider({ baseURL: stub.baseURL, dimensions: DIMS * 2 }).embedQuery('x')).rejects.toThrow(/returned 8-dimensional/);
  });

  it('surface a server error instead of returning nothing', async () => {
    const failing = await startOpenAIStub({ dims: DIMS, failWith: 400 });
    try {
      await expect(provider({ baseURL: failing.baseURL }).embedQuery('x')).rejects.toThrow();
    } finally {
      await failing.close();
    }
  });
});

describe('the endpoint in provider.id', () => {
  const base = { apiKey: 'sk-x', model: 'text-embedding-3-small', dimensions: 1536, log: silentLog };

  it('is unchanged for an installation that never set a base URL', () => {
    expect(new OpenAIEmbeddingProvider(base).id).toBe('openai:text-embedding-3-small:1536');
    expect(new OpenAIEmbeddingProvider(base).baseURL).toBe(OPENAI_DEFAULT_BASE_URL);
  });

  it('is unchanged when the base URL is OpenAI itself, stated explicitly', () => {
    expect(new OpenAIEmbeddingProvider({ ...base, baseURL: 'https://api.openai.com/v1' }).id).toBe('openai:text-embedding-3-small:1536');
    expect(new OpenAIEmbeddingProvider({ ...base, baseURL: 'https://api.openai.com/v1/' }).id).toBe('openai:text-embedding-3-small:1536');
  });

  it('changes when the base URL points elsewhere, so the re-index guard fires', () => {
    const openai = new OpenAIEmbeddingProvider(base).id;
    const ollama = new OpenAIEmbeddingProvider({ ...base, baseURL: 'http://localhost:11434/v1' }).id;
    const vllm = new OpenAIEmbeddingProvider({ ...base, baseURL: 'http://gpu-box:8000/v1' }).id;
    expect(ollama).toBe('openai:text-embedding-3-small:1536@localhost:11434');
    expect(ollama).not.toBe(openai);
    expect(vllm).not.toBe(ollama);
  });

  it('changes with the port, not with the path', () => {
    const a = new OpenAIEmbeddingProvider({ ...base, baseURL: 'http://localhost:8080/v1' }).id;
    const b = new OpenAIEmbeddingProvider({ ...base, baseURL: 'http://localhost:8081/v1' }).id;
    const c = new OpenAIEmbeddingProvider({ ...base, baseURL: 'http://localhost:8080/openai/v1' }).id;
    expect(a).not.toBe(b);
    expect(a).toBe(c);
  });

  it('sits before the prefix segment', () => {
    const id = new OpenAIEmbeddingProvider({ ...base, baseURL: 'http://tei:8080/v1', prefixes: { query: 'q: ', passage: 'p: ' } }).id;
    expect(id).toBe('openai:text-embedding-3-small:1536@tei:8080:"q: "+"p: "');
  });

  it('ignores the legacy OPENAI_BASE_URL, so an installation that relied on it keeps its index', () => {
    const legacy = new OpenAIEmbeddingProvider({ ...base, legacyBaseURL: 'http://localhost:11434/v1' });
    expect(legacy.id).toBe('openai:text-embedding-3-small:1536');
    expect(legacy.baseURL).toBe('http://localhost:11434/v1');

    const both = new OpenAIEmbeddingProvider({ ...base, baseURL: 'http://tei:8080/v1', legacyBaseURL: 'http://localhost:11434/v1' });
    expect(both.id).toBe('openai:text-embedding-3-small:1536@tei:8080');
    expect(both.baseURL).toBe('http://tei:8080/v1');
  });

  it('is empty for OpenAI and the host otherwise', () => {
    expect(endpointIdSegment(OPENAI_DEFAULT_BASE_URL)).toBe('');
    expect(endpointIdSegment('http://127.0.0.1:9/v1')).toBe('@127.0.0.1:9');
  });
});

describe('configuration', () => {
  const ENV = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', ALLOWED_DOC_ROOTS: '/docs' };
  const parse = (overrides: Record<string, string>) => EnvSchema.safeParse({ ...ENV, ...overrides });
  const issuesFor = (result: ReturnType<typeof parse>, field: string): string[] =>
    result.success ? [] : result.error.issues.filter((i) => i.path[0] === field).map((i) => i.message);

  it('accepts http and https base URLs', () => {
    expect(parse({ EMBEDDING_BASE_URL: 'http://localhost:11434/v1' }).success).toBe(true);
    expect(parse({ EMBEDDING_PROVIDER: 'openai', OPENAI_BASE_URL: 'https://proxy.example.com/v1' }).success).toBe(true);
  });

  it('rejects a base URL that is not http(s) or carries credentials', () => {
    expect(issuesFor(parse({ EMBEDDING_BASE_URL: 'ftp://host/v1' }), 'EMBEDDING_BASE_URL')).not.toEqual([]);
    expect(issuesFor(parse({ EMBEDDING_BASE_URL: 'not a url' }), 'EMBEDDING_BASE_URL')).not.toEqual([]);
    expect(issuesFor(parse({ EMBEDDING_BASE_URL: 'https://user:secret@host/v1' }), 'EMBEDDING_BASE_URL')).toEqual([
      'must not contain credentials; put the key in OPENAI_API_KEY',
    ]);
  });

  it('validates OPENAI_BASE_URL only for the openai provider, which is the only one that reads it', () => {
    for (const value of ['localhost:11434', 'https://user:secret@host/v1']) {
      expect(parse({ EMBEDDING_PROVIDER: 'local', OPENAI_BASE_URL: value }).success).toBe(true);
      expect(parse({ OPENAI_BASE_URL: value }).success).toBe(true);
      expect(issuesFor(parse({ EMBEDDING_PROVIDER: 'openai', OPENAI_BASE_URL: value }), 'OPENAI_BASE_URL')).not.toEqual([]);
    }
    expect(issuesFor(parse({ EMBEDDING_PROVIDER: 'openai', OPENAI_BASE_URL: 'https://user:secret@host/v1' }), 'OPENAI_BASE_URL')).toEqual([
      'must not contain credentials; put the key in OPENAI_API_KEY',
    ]);
  });

  it('requires OPENAI_API_KEY for OpenAI itself, and not for a self-hosted endpoint', () => {
    expect(issuesFor(parse({ EMBEDDING_PROVIDER: 'openai' }), 'OPENAI_API_KEY')).not.toEqual([]);
    expect(parse({ EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: 'http://localhost:11434/v1' }).success).toBe(true);
    expect(parse({ EMBEDDING_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:11434/v1' }).success).toBe(true);
    expect(parse({ EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-x' }).success).toBe(true);
  });

  it('still requires OPENAI_API_KEY when the base URL names OpenAI itself', () => {
    for (const url of ['https://api.openai.com/v1', 'https://api.openai.com/v1/']) {
      expect(issuesFor(parse({ EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: url }), 'OPENAI_API_KEY')).not.toEqual([]);
      expect(issuesFor(parse({ EMBEDDING_PROVIDER: 'openai', OPENAI_BASE_URL: url }), 'OPENAI_API_KEY')).not.toEqual([]);
      expect(parse({ EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: url, OPENAI_API_KEY: 'sk-x' }).success).toBe(true);
    }
  });

  it('ignores a broken OPENAI_BASE_URL when EMBEDDING_BASE_URL is set, since it is then never read', () => {
    const result = parse({ EMBEDDING_PROVIDER: 'openai', EMBEDDING_BASE_URL: 'http://localhost:11434/v1', OPENAI_BASE_URL: 'localhost:11434' });
    expect(result.success).toBe(true);
  });

  it('defaults EMBEDDING_REQUEST_DIMENSIONS to auto and rejects anything else', () => {
    const ok = parse({});
    expect(ok.success && ok.data.EMBEDDING_REQUEST_DIMENSIONS).toBe('auto');
    expect(issuesFor(parse({ EMBEDDING_REQUEST_DIMENSIONS: 'sometimes' }), 'EMBEDDING_REQUEST_DIMENSIONS')).not.toEqual([]);
  });
});
