import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/client.js';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { LocalDriver } from '../src/services/sources/local.js';
import { WEB_LIMIT_DEFAULTS } from '../src/config.js';

/**
 * **The probe has to count the files the run would index — all of them.**
 *
 * `directoryRevision` is `files=<n>;mtime=<newest>` over the same walk the indexer does, and the
 * scheduler skips a source whose token has not moved. Since [ADR-0057](../../.ssot/ADR.md#adr-0057) a
 * content type widens which extensions are walked at all, and the probe was left on the default set:
 * a `.yaml` an operator edited never moved the token, and a source holding *only* specifications
 * answered `files=0;mtime=0` for ever. Both failures are invisible — the scheduler reports "unchanged"
 * and a scheduler that never runs looks exactly like a scheduler with nothing to do — and the feature
 * they break is the one the README states outright: an operation deleted from a specification loses
 * its document *on the next run*.
 */

const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log } as never;

let root: string;

function sourceRow(extensions: string[], flavor: string): DocumentSourceRow {
  return {
    id: 's1',
    projectId: 'p1',
    type: 'local',
    name: 'api',
    flavor,
    config: { path: root, extensions },
  } as unknown as DocumentSourceRow;
}

function driver(extensions: string[], flavor: string): LocalDriver {
  return new LocalDriver(sourceRow(extensions, flavor), {
    db: null as unknown as Db,
    log,
    config: { ...WEB_LIMIT_DEFAULTS, ALLOWED_DOC_ROOTS: [path.dirname(root)], DATA_DIR: root, SECRET_KEY: '0'.repeat(64), IGNORE_GLOBS: [] },
  });
}

/** Two writes in the same millisecond would leave the mtime equal, which is not what is under test. */
async function write(name: string, body: string): Promise<void> {
  await fs.writeFile(path.join(root, name), body);
  const when = new Date(Date.now() + 5000);
  await fs.utimes(path.join(root, name), when, when);
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-probe-'));
  await fs.writeFile(path.join(root, 'README.md'), '# Readme\n');
  await fs.writeFile(path.join(root, 'petstore.yaml'), 'openapi: 3.0.0\n');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the local driver probe', () => {
  it('counts the .yaml an openapi source indexes, and notices when it is edited', async () => {
    const openapi = driver(['md', 'yaml'], 'openapi');
    const before = await openapi.probe();
    expect(before).toMatch(/^files=2;mtime=\d+$/);

    await write('petstore.yaml', 'openapi: 3.0.0\ninfo: {title: Edited, version: "2"}\n');
    expect(await openapi.probe()).not.toBe(before);
  });

  it('answers about the specifications, not about the Markdown it does not index', async () => {
    // A source configured for `.yaml` alone. With the default extension set the matcher finds nothing
    // it recognises and falls back to Markdown, so the token would describe `README.md` — a file this
    // source does not index — and an edit to the one file it *does* would never move it.
    const specsOnly = driver(['yaml'], 'openapi');
    const before = await specsOnly.probe();
    await write('petstore.yaml', 'openapi: 3.0.0\ninfo: {title: Edited again, version: "3"}\n');
    expect(await specsOnly.probe()).not.toBe(before);
  });

  it('still excludes what the source does not index, which is the safe direction', async () => {
    // `plain` reads no `.yaml`, so the specification is not in the token — and neither would the run
    // index it. A token that counted it would queue a run that then skips the file.
    const plain = driver(['md'], 'plain');
    expect(await plain.probe()).toMatch(/^files=1;mtime=\d+$/);
  });
});
