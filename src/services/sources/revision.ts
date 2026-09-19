import fs from 'node:fs/promises';
import { walkMarkdown } from '../fs-scan.js';

/**
 * The revision token of a directory tree, for the two drivers whose content is already on local disk
 * ([ADR-0048](../../../.ssot/ADR.md#adr-0048)): the number of files the source would index and the
 * newest modification time among them.
 *
 * **What it saves is the scan, which for these two sources is the whole run.** A local or upload
 * source has no `sync()` to speak of; what a scheduled run costs is `readAndHash` over every file —
 * every byte read and sha256'd — and then the walk of the existing documents. This is the same walk
 * with `stat` instead of `read`: no file content crosses the page cache, nothing is hashed, and the
 * cost is one `readdir` per directory plus one `stat` per file.
 *
 * **It can miss an edit, and the ways it can are worth stating rather than discovering.** A file
 * rewritten with its mtime restored is invisible. So is a change that both deletes one file and adds
 * another with an older mtime in the same interval, because count and maximum are each preserved.
 * Neither is reachable by a human editing documents, both are reachable by a script doing something
 * deliberate, and the answer to both is the same one that has always existed: the "Sync now" button
 * and the scheduled run that follows the next real edit. A probe is an optimisation over a button
 * that still works.
 *
 * The ignore globs and the extension list are the indexer's own, so the token counts exactly the
 * files a run would index. Anything they exclude cannot move the token, which is the safe direction:
 * a token that ignored them would run on a change to a file the run then skips.
 */
export async function directoryRevision(root: string, opts: { ignoreGlobs: string[]; extensions?: readonly string[] }): Promise<string> {
  let files = 0;
  let newest = 0;
  for await (const file of walkMarkdown(root, opts)) {
    files++;
    const stat = await fs.stat(file.absolutePath);
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  // Fixed shape, so the string can be compared and also read by a person looking at the jsonb.
  return `files=${files};mtime=${Math.trunc(newest)}`;
}
