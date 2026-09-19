import { describe, expect, it } from 'vitest';

import { createProductRepo, createSignatureStore, GitHubError, MAX_COMMITS, StaleWriteError, type FetchLike } from '../scripts/cla/github.js';

/**
 * The half of the licence gate that is shaped by another system's answers
 * ([ADR-0061](../../.ssot/ADR.md#adr-0061)).
 *
 * `test/cla-rules.test.ts` and `test/cla-gate.test.ts` run against fakes of these interfaces, which
 * means nothing in them executes the paging, the `409`/`422` mapping, the base64 decoding or the shape
 * of a resolved account. Those are exactly where a wrong assumption about the API becomes a gate that
 * passes something it should not — the 250-commit cap was one — so the `fetch` is injected and this
 * file drives the real clients against recorded shapes. Still no network.
 */

type Call = { url: string; method: string; body: unknown };

/** A `fetch` that answers from a table, records every call, and refuses anything unexpected. */
function stubFetch(routes: Array<{ match: RegExp; method?: string; status: number; body?: unknown }>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url, init) => {
    calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const route = routes.find((entry) => entry.match.test(url) && (entry.method ?? 'GET') === init.method);
    if (route === undefined) throw new Error(`no stub for ${init.method} ${url}`);
    return { status: route.status, text: async () => (route.body === undefined ? '' : JSON.stringify(route.body)) };
  }) as FetchLike & { calls: Call[] };
  impl.calls = calls;
  return impl;
}

const user = (over: Record<string, unknown> = {}) => ({ login: 'octo', id: 1, type: 'User', ...over });

describe('reading a pull request', () => {
  it('carries the opener and the commit count out of the payload', async () => {
    const fetchImpl = stubFetch([
      {
        match: /\/pulls\/12$/,
        status: 200,
        body: { state: 'open', head: { sha: 'f'.repeat(40) }, user: user({ login: 'opener', id: 90 }), commits: 7 },
      },
    ]);
    const pull = await createProductRepo('t', 'o', 'r', fetchImpl).getPullRequest(12);
    expect(pull).toEqual({ number: 12, state: 'open', headSha: 'f'.repeat(40), user: { login: 'opener', id: 90, type: 'User' }, commits: 7 });
  });

  it('refuses a payload that names no opener rather than inventing one', async () => {
    // The opener is the only identity this gate rests on; a pull request without one is not judged.
    const fetchImpl = stubFetch([{ match: /\/pulls\/12$/, status: 200, body: { state: 'open', head: { sha: 'f' }, user: null, commits: 1 } }]);
    await expect(createProductRepo('t', 'o', 'r', fetchImpl).getPullRequest(12)).rejects.toThrow(GitHubError);
  });

  it('reports a commit count of -1 when the payload has none, so it can never look like agreement', async () => {
    // `run.ts` refuses when the count and the listed commits disagree. A missing count defaulting to a
    // plausible number would be a silent agreement; -1 can equal no list length there is.
    const fetchImpl = stubFetch([{ match: /\/pulls\/12$/, status: 200, body: { state: 'closed', head: { sha: 'f' }, user: user() } }]);
    expect((await createProductRepo('t', 'o', 'r', fetchImpl).getPullRequest(12)).commits).toBe(-1);
  });
});

describe('listing the commits', () => {
  const page = (count: number, from: number) =>
    Array.from({ length: count }, (_, i) => ({
      sha: String(from + i).padStart(40, '0'),
      author: user({ id: from + i }),
      commit: { author: { name: 'Octo', email: 'octo@example.com' } },
    }));

  it('pages until the API stops', async () => {
    let served = 0;
    const fetchImpl = (async () => {
      served += 1;
      const body = served === 1 ? page(100, 0) : page(30, 100);
      return { status: 200, text: async () => JSON.stringify(body) };
    }) as FetchLike;

    const commits = await createProductRepo('t', 'o', 'r', fetchImpl).listCommits(12);
    expect(commits).toHaveLength(130);
    expect(served).toBe(2);
  });

  it('stops at the cap the API stops at, and says nothing about it — which is why run.ts checks the count', async () => {
    const fetchImpl = (async () => ({ status: 200, text: async () => JSON.stringify(page(100, 0)) })) as FetchLike;
    const commits = await createProductRepo('t', 'o', 'r', fetchImpl).listCommits(12);
    // Three full pages and no complaint. Nothing here can tell a truncated list from a complete one.
    expect(commits.length).toBeGreaterThanOrEqual(MAX_COMMITS);
  });

  it('turns an author GitHub could not resolve into a null, not into a name', async () => {
    const fetchImpl = stubFetch([
      {
        match: /\/commits/,
        status: 200,
        body: [
          { sha: 'a'.repeat(40), author: null, commit: { author: { name: 'Someone', email: 'unlinked@example.invalid' } } },
          {
            sha: 'b'.repeat(40),
            author: { login: 'x', id: 'not-a-number', type: 'User' },
            commit: { author: { name: 'X', email: 'x@example.com' } },
          },
        ],
      },
    ]);
    const commits = await createProductRepo('t', 'o', 'r', fetchImpl).listCommits(12);
    expect(commits[0].author).toBeNull();
    // A malformed account object is no account at all. Accepting a partial one would put a value that
    // is not an identity into the set of accounts the gate matches signatures against.
    expect(commits[1].author).toBeNull();
    expect(commits[0].commit.author.email).toBe('unlinked@example.invalid');
  });
});

describe('the workflow run lookup', () => {
  it('asks for pull_request_target runs against the head SHA it was given', async () => {
    const fetchImpl = stubFetch([{ match: /\/actions\/workflows\//, status: 200, body: { workflow_runs: [{ id: 5, status: 'completed' }] } }]);
    const runs = await createProductRepo('t', 'o', 'r', fetchImpl).listWorkflowRuns('cla.yml', 'abc');
    expect(runs).toEqual([{ id: 5, status: 'completed' }]);
    expect(fetchImpl.calls[0].url).toContain('/actions/workflows/cla.yml/runs?event=pull_request_target&head_sha=abc');
  });

  it('answers with an empty list rather than throwing when there are no runs', async () => {
    const fetchImpl = stubFetch([{ match: /\/actions\/workflows\//, status: 200, body: {} }]);
    expect(await createProductRepo('t', 'o', 'r', fetchImpl).listWorkflowRuns('cla.yml', 'abc')).toEqual([]);
  });
});

describe('the signature store', () => {
  const store = (fetchImpl: FetchLike) => createSignatureStore('t', 'Contextator', 'cla-signatures', 'signatures/v1/cla.json', 'main', fetchImpl);
  const content = '{"signedContributors":[]}';

  it('decodes what the contents API base64-encodes, and carries the blob SHA', async () => {
    const fetchImpl = stubFetch([
      { match: /contents/, status: 200, body: { content: Buffer.from(content, 'utf8').toString('base64'), sha: 'blob1' } },
    ]);
    expect(await store(fetchImpl).readFile()).toEqual({ content, sha: 'blob1' });
    expect(fetchImpl.calls[0].url).toContain('signatures/v1/cla.json?ref=main');
  });

  it('answers null for a missing record rather than throwing', async () => {
    // `run.ts` turns that null into a refusal. The distinction is kept here so the two failures — "not
    // there" and "could not be read" — never collapse into one message.
    const fetchImpl = stubFetch([{ match: /contents/, status: 404, body: { message: 'Not Found' } }]);
    expect(await store(fetchImpl).readFile()).toBeNull();
  });

  it('refuses a 200 that is not a file', async () => {
    const fetchImpl = stubFetch([{ match: /contents/, status: 200, body: [{ name: 'cla.json' }] }]);
    await expect(store(fetchImpl).readFile()).rejects.toThrow(GitHubError);
  });

  it('writes the content base64-encoded, onto the branch and the blob SHA it was given', async () => {
    const fetchImpl = stubFetch([{ match: /contents/, method: 'PUT', status: 200, body: {} }]);
    await store(fetchImpl).writeFile({ content, sha: 'blob1', message: 'x signed the CLA' });
    expect(fetchImpl.calls[0].body).toEqual({
      message: 'x signed the CLA',
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha: 'blob1',
      branch: 'main',
    });
  });

  it('maps both of the API’s answers for a moved blob onto the one error that is retried', async () => {
    // 409 is the documented conflict and 422 is what the contents API actually answers when the `sha`
    // is not the blob that is there. Either one mapped to a plain failure would turn a lost race into a
    // red check instead of a re-read, and the second signature would simply never be recorded.
    for (const status of [409, 422]) {
      const fetchImpl = stubFetch([{ match: /contents/, method: 'PUT', status, body: { message: 'does not match' } }]);
      await expect(store(fetchImpl).writeFile({ content, sha: 'stale', message: 'm' })).rejects.toThrow(StaleWriteError);
    }
  });

  it('does not treat any other failure as a race', async () => {
    for (const status of [401, 403, 404, 500]) {
      const fetchImpl = stubFetch([{ match: /contents/, method: 'PUT', status, body: { message: 'nope' } }]);
      const error = await store(fetchImpl)
        .writeFile({ content, sha: 'blob1', message: 'm' })
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(GitHubError);
      expect(error).not.toBeInstanceOf(StaleWriteError);
    }
  });
});

describe('the request itself', () => {
  it('sends the token it was given and nothing else', async () => {
    const fetchImpl = stubFetch([{ match: /\/pulls\/12\/commits/, status: 200, body: [] }]);
    await createProductRepo('product-token', 'o', 'r', fetchImpl).listCommits(12);
    expect(fetchImpl.calls[0].url.startsWith('https://api.github.com/')).toBe(true);
  });

  it('turns a failure status into an error carrying that status', async () => {
    const fetchImpl = stubFetch([{ match: /\/pulls\/12$/, status: 403, body: { message: 'Resource not accessible' } }]);
    const error = await createProductRepo('t', 'o', 'r', fetchImpl)
      .getPullRequest(12)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(403);
    expect((error as GitHubError).message).toContain('Resource not accessible');
  });
});
