import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';
import type { Logger } from '../context.js';
import type { Db } from '../db/client.js';
import type { DocumentRow } from '../db/schema.js';
import { isInside } from '../services/fs-scan.js';
import { driverFor } from '../services/sources/driver.js';
import { getSourceById } from '../services/sources.js';

/**
 * **Delete this file one release after `documents.content` shipped** — it is the migration window of
 * [ADR-0043](../../.ssot/ADR.md#adr-0043) and nothing else.
 *
 * A document indexed before that column existed holds `content IS NULL`, and an incremental run will
 * never fill it in: the content hash has not moved, so the file is skipped. Unlike `content_tsv`, the
 * text is not a function of anything already in the database, so there is no bootstrap phase that can
 * recover it — only a re-index can. Until one has run, `read_document` reads the file, exactly as every
 * version up to this one did.
 *
 * **The window is nearly empty in practice.** PR 1.3 changed the default embedding model, so every
 * installation that upgrades through this Phase re-indexes itself on its first run whether or not
 * anybody asks it to, and fills the column on the way past.
 *
 * It lives in its own file so that the deletion is a deletion: `mcp/tools.ts` imports one function and
 * knows nothing about `docRoot()`, containment or `ENOENT`. Everything below is the mechanism
 * [ADR-0019](../../.ssot/ADR.md#adr-0019) described, kept verbatim and kept out of the way — the policy
 * it enforced (only a path that was indexed for this project is served) is now enforced by the document
 * row being the only thing this function is given.
 */

/** As much of a file as `read_document` ever served before the text was stored; the token budget then cuts it further. */
const MAX_LEGACY_DOCUMENT_BYTES = 512 * 1024;

export async function readIndexedFileFromDisk(
  deps: { db: Db; log: Logger; config: Config },
  doc: DocumentRow,
): Promise<{ content: string } | string> {
  const source = doc.sourceId ? await getSourceById(deps.db, doc.sourceId) : undefined;
  if (!source) {
    return (
      `"${doc.relativePath}" was indexed before this version stored document text, and the source it came from no longer exists, ` +
      'so there is nothing left to read it from. Re-index the project from the Contextator dashboard.'
    );
  }

  const rootReal = await driverFor(source, deps).docRoot();
  const inside = doc.relativePath.slice(source.name.length + 1);
  const absolute = path.resolve(rootReal, ...inside.split('/'));
  if (!isInside(rootReal, absolute)) return 'Path escapes the source root.';

  let buf: Buffer;
  try {
    buf = await fs.readFile(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return (
        `"${doc.relativePath}" was indexed before this version stored document text, and its file is no longer on disk. ` +
        'Re-index the project from the Contextator dashboard — after that, a document stays readable whatever happens to its file.'
      );
    }
    throw err;
  }
  return { content: buf.subarray(0, MAX_LEGACY_DOCUMENT_BYTES).toString('utf8') };
}
