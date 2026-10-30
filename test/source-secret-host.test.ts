import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { keyringOf } from '../src/services/crypto.js';
import { updateSource, type SourceServiceOptions } from '../src/services/sources.js';

/**
 * A stored credential must not be sent to a host an editor chose without the editor supplying the credential
 * again: the settings are writable by an editor, the credential is not readable by one, and an address edit that
 * kept the secret would turn the first into the second (Faz 06 review, MAJOR). `github` (`apiBaseUrl`) and `s3`
 * (`endpoint`), `confluence` (`baseUrl`) and `git` (`url`) are covered; `gdrive` has no such setting, its hosts being pinned to
 * Google's in the driver.
 */

const opts: SourceServiceOptions = { allowedRoots: [], keys: keyringOf({ SECRET_KEY: '0'.repeat(64) }) };
const PROJECT_ID = '00000000-0000-4000-8000-000000000091';
const SOURCE_ID = '00000000-0000-4000-8000-000000000092';
const S3_CREDENTIAL = JSON.stringify({ v: 1, accessKeyId: 'AKIATESTTESTTESTTEST', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYTESTSECRETKEY' });

function row(type: string, config: Record<string, unknown>, withSecret = true): DocumentSourceRow {
  return {
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    type,
    name: 'src',
    label: '',
    flavor: 'plain',
    config,
    secretEnc: withSecret ? 'stored-ciphertext' : null,
    webhookSecret: null,
    webhookVerificationExpiresAt: null,
    webhookDueAt: null,
    webhookMinIntervalMinutes: null,
    status: 'idle',
    lastSyncedAt: null,
    lastError: null,
    documentCount: 0,
    syncIntervalMinutes: null,
    nextSyncAt: null,
    createdAt: new Date(),
  } as unknown as DocumentSourceRow;
}

/** Just enough of the query builder for `updateSource`; records what was written. */
function fakeDb(existing: DocumentSourceRow): { db: Db; written: () => Record<string, unknown> } {
  let written: Record<string, unknown> = {};
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [existing] }) }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        written = v;
        return { where: () => ({ returning: async () => [{ ...existing, ...v }] }) };
      },
    }),
  } as unknown as Db;
  return { db, written: () => written };
}

const update = (existing: DocumentSourceRow, input: Parameters<typeof updateSource>[3]) =>
  updateSource(fakeDb(existing).db, PROJECT_ID, SOURCE_ID, input, opts);

describe('a github source’s API address', () => {
  const github = (withSecret = true) => row('github', { owner: 'o', repo: 'r', apiBaseUrl: 'https://api.github.com', includeBots: true }, withSecret);
  const moved = { config: { owner: 'o', repo: 'r', apiBaseUrl: 'https://attacker.example/api/v3' } };

  it('cannot be moved to another host while the stored token stays', async () => {
    await expect(update(github(), moved)).rejects.toThrow(/Changing apiBaseUrl would send the stored github credential to a different host/);
  });

  it('may be moved when the token is given again, or removed in the same request', async () => {
    const { db, written } = fakeDb(github());
    await updateSource(db, PROJECT_ID, SOURCE_ID, { ...moved, secret: 'a-token-for-the-new-host' }, opts);
    expect((written().config as Record<string, unknown>).apiBaseUrl).toBe('https://attacker.example/api/v3');
    await expect(update(github(), { ...moved, secret: null })).resolves.toBeDefined();
    await expect(update(github(), { ...moved, secret: '' })).resolves.toBeDefined();
  });

  it('may be moved freely when no token is stored: there is nothing to send', async () => {
    await expect(update(github(false), moved)).resolves.toBeDefined();
  });

  it('may change its path on the same origin, and keeps the address when an edit changes something else', async () => {
    const ghes = row('github', { owner: 'o', repo: 'r', apiBaseUrl: 'https://ghe.example.com/api/v3' });
    await expect(update(ghes, { config: { owner: 'o', repo: 'r', apiBaseUrl: 'https://ghe.example.com/api/v4' } })).resolves.toBeDefined();
    await expect(
      update(github(), { config: { owner: 'o', repo: 'r', apiBaseUrl: 'https://api.github.com', includeClosed: true } }),
    ).resolves.toBeDefined();
    // The blank field of the panel is github.com, which is where an unset address already points.
    await expect(update(github(), { config: { owner: 'o', repo: 'r', apiBaseUrl: '' } })).resolves.toBeDefined();
  });

  it('cannot be moved to github.com through the blank field either', async () => {
    const ghes = row('github', { owner: 'o', repo: 'r', apiBaseUrl: 'https://ghe.example.com/api/v3' });
    await expect(update(ghes, { config: { owner: 'o', repo: 'r', apiBaseUrl: '' } })).rejects.toThrow(/different host/);
  });
});

describe('an s3 source’s endpoint', () => {
  const s3 = (endpoint?: string) => row('s3', { bucket: 'docs-bucket', ...(endpoint ? { endpoint } : {}) });

  it('cannot be moved off AWS, or to another server, while the stored key pair stays', async () => {
    await expect(update(s3(), { config: { bucket: 'docs-bucket', endpoint: 'https://attacker.example' } })).rejects.toThrow(
      /Changing endpoint would send the stored s3 credential to a different host/,
    );
    await expect(update(s3('https://minio.corp:9000'), { config: { bucket: 'docs-bucket', endpoint: 'https://attacker.example' } })).rejects.toThrow(
      /different host/,
    );
    await expect(update(s3('https://minio.corp:9000'), { config: { bucket: 'docs-bucket', endpoint: '' } })).rejects.toThrow(/different host/);
  });

  it('may be moved when the key pair is given again, and left alone otherwise', async () => {
    await expect(
      update(s3(), { config: { bucket: 'docs-bucket', endpoint: 'https://minio.corp:9000' }, secret: S3_CREDENTIAL }),
    ).resolves.toBeDefined();
    await expect(
      update(s3('https://minio.corp:9000'), { config: { bucket: 'other-bucket', endpoint: 'https://minio.corp:9000', prefix: 'x' } }),
    ).resolves.toBeDefined();
    await expect(update(s3(), { config: { bucket: 'docs-bucket', region: 'eu-west-1' } })).resolves.toBeDefined();
  });
});

describe('a confluence source’s base URL', () => {
  const confluence = (withSecret = true) =>
    row('confluence', { baseUrl: 'https://acme.atlassian.net/wiki', deployment: 'cloud', email: 'me@example.com', spaceKeys: [] }, withSecret);
  const to = (baseUrl: string) => ({ config: { baseUrl, deployment: 'cloud', email: 'me@example.com', spaceKeys: [] } });

  it('cannot be moved to another host while the stored token stays', async () => {
    await expect(update(confluence(), to('https://attacker.example/wiki'))).rejects.toThrow(
      /Changing baseUrl would send the stored confluence credential to a different host/,
    );
    await expect(update(confluence(), to('https://acme.atlassian.net:8443/wiki'))).rejects.toThrow(/different host/);
  });

  it('may be moved when the token is given again or removed, when none is stored, or within the same origin', async () => {
    await expect(update(confluence(), { ...to('https://wiki.corp.example'), secret: 'a-token-for-the-new-site' })).resolves.toBeDefined();
    await expect(update(confluence(), { ...to('https://wiki.corp.example'), secret: null })).resolves.toBeDefined();
    await expect(update(confluence(false), to('https://wiki.corp.example'))).resolves.toBeDefined();
    await expect(update(confluence(), to('https://acme.atlassian.net/confluence'))).resolves.toBeDefined();
  });
});

describe('a git source’s URL', () => {
  const git = (withSecret = true, url = 'https://github.com/org/docs.git') =>
    row('git', { url, branch: 'main', subdir: '', username: '', provider: 'auto' }, withSecret);
  const to = (url: string) => ({ config: { url, branch: 'main', subdir: '', username: '', provider: 'auto' } });

  it('cannot be moved to another host while the stored token stays: any server that answers 401 is offered it', async () => {
    await expect(update(git(), to('https://attacker.example/org/docs.git'))).rejects.toThrow(
      /Changing url would send the stored git credential to a different host/,
    );
    await expect(update(git(true, 'ssh://git@git.corp.example/org/docs.git'), to('ssh://git@attacker.example/org/docs.git'))).rejects.toThrow(
      /different host/,
    );
  });

  it('is not asked for a token that does not exist: a public repository may be pointed anywhere', async () => {
    await expect(update(git(false), to('https://attacker.example/org/docs.git'))).resolves.toBeDefined();
  });

  it('may be moved when the token is given again or removed, and may name another repository on the same host', async () => {
    await expect(update(git(), { ...to('https://gitlab.com/g/r.git'), secret: 'a-token-for-gitlab' })).resolves.toBeDefined();
    await expect(update(git(), { ...to('https://gitlab.com/g/r.git'), secret: null })).resolves.toBeDefined();
    await expect(update(git(), to('https://github.com/org/other.git'))).resolves.toBeDefined();
    // A credential pasted into the URL is stripped before it is stored and does not make the host look different.
    await expect(update(git(), to('https://bob:tok@github.com/org/other.git'))).resolves.toBeDefined();
  });
});
