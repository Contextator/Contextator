/**
 * Smoke run of the `gdrive` source against the real Google Drive API (ADR-0127), on the operator's machine.
 *
 *   GDRIVE_SMOKE_KEY_FILE=/path/to/key.json GDRIVE_SMOKE_FOLDER_ID=<folder id> npx tsx scripts/smoke-gdrive.ts
 *
 * The folder must be shared with the service account of the key file, and hold a few files of a few types
 * (a Google Doc among them). The run is read-only against Google; it asks you, between steps, to edit one file
 * and to move one to the trash, because that is the only way to measure what a change costs.
 *
 * What it prints is counts, request counts and host names: **never** the key, a token, a folder or file name.
 * That is what makes its output safe to paste into the phase report. The key file's path and the folder id come
 * from the environment only; nothing is written to the repository.
 *
 * Optional: `GDRIVE_SMOKE_BIG_FILE_ID` names a Google Doc, Sheet or Slides file known to export above 10 MB; the
 * script then prints Google's own answer (status and reason string), which the documentation does not give.
 *
 * It measures, in this order: Test, the first sync (files, downloads, which host a download is served from if it
 * is not one of the two pinned hosts), the requests an idle probe costs, a change (probe, then sync), a deletion
 * (probe, then sync) and the idle probe again.
 */
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DocumentSourceRow } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';
import { EgressRefusedError, sourceEgress } from '../src/services/sources/confluence-egress.js';
import { EXPORT_FORMATS, GDRIVE_SECRET, GOOGLE_HOSTS, GdriveClient, GdriveRequestError } from '../src/services/sources/gdrive-client.js';
import { GdriveDriver } from '../src/services/sources/gdrive.js';

const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';
const SOURCE_ID = '00000000-0000-4000-8000-0000000000a2';

const keyPath = process.env.GDRIVE_SMOKE_KEY_FILE;
const folderId = process.env.GDRIVE_SMOKE_FOLDER_ID;
const bigFileId = process.env.GDRIVE_SMOKE_BIG_FILE_ID;
if (!keyPath || !folderId) {
  console.error('Set GDRIVE_SMOKE_KEY_FILE (path of the service account key file) and GDRIVE_SMOKE_FOLDER_ID (a folder shared with it).');
  process.exit(2);
}

const log = { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined, child: () => log } as never;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const results: Array<[string, string | number]> = [];
/**
 * A run note with the file names taken out: the names sit in parentheses (what was skipped, what was refused),
 * and the output of this script is meant to be pasted into a report. The counts stay.
 */
const withoutNames = (note: string): string => note.replace(/\(([^()]*)\)/g, (whole, inner: string) => (inner === 's' ? whole : '(…)'));
const record = (label: string, value: string | number): void => {
  results.push([label, value]);
  console.log(`  ${label}: ${value}`);
};

async function main(): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contextator-smoke-gdrive-'));
  const secretKey = randomBytes(32).toString('hex');
  const keyFile = await fs.readFile(keyPath as string, 'utf8');
  const canonical = GDRIVE_SECRET.canonicalize(keyFile);
  const secret = GDRIVE_SECRET.parse(canonical);

  const source = (config: Record<string, unknown>): DocumentSourceRow =>
    ({
      id: SOURCE_ID,
      projectId: PROJECT_ID,
      type: 'gdrive',
      name: 'smoke',
      label: '',
      config: { folderIds: [folderId], ...config },
      secretEnc: encryptSecret(canonical, { current: secretKey }),
      webhookSecret: null,
      flavor: 'plain',
      status: 'idle',
      lastSyncedAt: null,
      lastError: null,
      documentCount: 0,
      syncIntervalMinutes: null,
      nextSyncAt: null,
      webhookVerificationExpiresAt: null,
      webhookDueAt: null,
      webhookMinIntervalMinutes: null,
      createdAt: new Date(),
    }) as DocumentSourceRow;
  const driver = (config: Record<string, unknown> = {}): GdriveDriver =>
    new GdriveDriver(source(config), {
      db: null as never,
      log,
      config: { DATA_DIR: dataDir, SECRET_KEY: secretKey, ALLOWED_DOC_ROOTS: [], IGNORE_GLOBS: [] } as never,
    });

  try {
    console.log('1. Test');
    console.log(`  ${(await driver().test()).replace(secret.clientEmail, '<service account>').replace(/ shared with it: .*/, ' shared with it')}`);

    console.log('2. First sync');
    let cursor: string;
    try {
      const first = await driver().sync();
      cursor = first.configPatch?.changesCursor as string;
      record('note', withoutNames(first.note ?? ''));
      record('files on disk', (await countFiles(dataDir)).total);
    } catch (err) {
      if (err instanceof EgressRefusedError && err.rule === 'pinned') {
        // The decision ADR-0127 decision 4 left to this run: a download served from a third Google host.
        record('DOWNLOAD REDIRECTED OFF THE PINNED HOSTS', err.message);
        console.log('  -> add that host to GOOGLE_HOSTS under ADR-0127 and say so in the phase report, then run again.');
      }
      throw err;
    }

    console.log('3. Idle probe (nothing changed)');
    const idle = await probeCost(secret, cursor);
    record('probe answer equals the stored cursor', String(idle.answer === cursor));
    record('requests (token requests included)', idle.requests);
    record('requests by host', idle.byHost);

    await rl.question('4. Edit the content of one file in the folder (a Doc is fine), then press Enter... ');
    const changed = await probeCost(secret, cursor);
    record('probe after a change differs from the cursor', String(changed.answer !== cursor));
    const second = await driver({ changesCursor: cursor }).sync();
    cursor = second.configPatch?.changesCursor as string;
    record('note', withoutNames(second.note ?? ''));

    await rl.question('5. Move one file in the folder to the trash, then press Enter... ');
    const deleted = await probeCost(secret, cursor);
    record('probe after a deletion differs from the cursor', String(deleted.answer !== cursor));
    const third = await driver({ changesCursor: cursor }).sync();
    cursor = third.configPatch?.changesCursor as string;
    record('note', withoutNames(third.note ?? ''));
    record('files on disk', (await countFiles(dataDir)).total);

    console.log('6. Idle probe again');
    const again = await probeCost(secret, cursor);
    record('probe answer equals the stored cursor', String(again.answer === cursor));
    record('requests (token requests included)', again.requests);

    if (bigFileId) {
      console.log('7. Export of the file named as over 10 MB');
      await bigExport(secret, bigFileId);
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    rl.close();
  }
  console.log('\nSummary (paste into the phase report):');
  for (const [label, value] of results) console.log(`- ${label}: ${value}`);
}

/** A client of its own over the same pinned egress, counting what leaves the process by host. */
function countingClient(secret: ReturnType<typeof GDRIVE_SECRET.parse>): { client: GdriveClient; byHost: Map<string, number> } {
  const byHost = new Map<string, number>();
  const egress = sourceEgress({
    allowedHosts: [],
    pinnedHosts: [...GOOGLE_HOSTS],
    label: 'Google Drive',
    subject: 'the address',
    httpsOnly: true,
    methods: ['GET', 'POST'],
  });
  const client = new GdriveClient(secret, {
    fetch: (url, init) => {
      const host = new URL(url).hostname;
      byHost.set(host, (byHost.get(host) ?? 0) + 1);
      return egress(url, init);
    },
  });
  return { client, byHost };
}

async function probeCost(
  secret: ReturnType<typeof GDRIVE_SECRET.parse>,
  cursor: string,
): Promise<{ answer: string; requests: number; byHost: string }> {
  const { client, byHost } = countingClient(secret);
  const changed = await client.changedSince(cursor);
  return {
    answer: changed ? `changed:${cursor}` : cursor,
    requests: client.requests,
    byHost: [...byHost.entries()].map(([host, n]) => `${host}=${n}`).join(', '),
  };
}

async function bigExport(secret: ReturnType<typeof GDRIVE_SECRET.parse>, id: string): Promise<void> {
  const { client } = countingClient(secret);
  // The file's type is needed to pick an export format: ask the parent listing for it would need the parent, so try each.
  for (const format of Object.values(EXPORT_FORMATS)) {
    try {
      const body = await client.exportFile(id, format);
      let bytes = 0;
      for await (const chunk of body) bytes += chunk.byteLength;
      record(`export as .${format.extension}`, `${bytes} bytes (no refusal)`);
      return;
    } catch (err) {
      if (err instanceof GdriveRequestError)
        record(`export as .${format.extension}`, `HTTP ${err.status}, reason ${err.reason ?? '(none)'}; ${err.message.slice(0, 200)}`);
      else throw err;
    }
  }
}

async function countFiles(root: string): Promise<{ total: number }> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(path.join(dir, entry.name));
      else total++;
    }
  };
  await walk(path.join(root, 'projects', PROJECT_ID, 'sources', SOURCE_ID, 'current'));
  return { total };
}

main().catch((err: unknown) => {
  // A message from this product or from Google; neither carries the key.
  console.error(`\nSmoke run failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
