import fs from 'node:fs/promises';
import { normalizeSourceUrl, parseSourceDate } from '../source-url.js';
import type { DocumentMeta, DocumentMetaFile } from './driver.js';

/** Front matter is the first lines of the file; this is far more than the keys written there need. */
const HEAD_BYTES = 4096;
const READ_CONCURRENCY = 16;

/**
 * The `key: "json"` lines of the front matter the Notion and Confluence drivers write
 * (`frontmatter()` in `notion-render.ts`). Values are parsed as JSON strings and anything else is ignored;
 * a file with no front matter yields nothing.
 */
export async function readFrontmatterFields(absolutePath: string, keys: readonly string[]): Promise<Record<string, string>> {
  let head: string;
  try {
    const handle = await fs.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return {};
  }
  if (!head.startsWith('---\n')) return {};
  const out: Record<string, string> = {};
  for (const line of head.slice(4).split('\n')) {
    if (line === '---') break;
    const cut = line.indexOf(': ');
    if (cut <= 0) continue;
    const key = line.slice(0, cut);
    if (!keys.includes(key)) continue;
    try {
      const value: unknown = JSON.parse(line.slice(cut + 2));
      if (typeof value === 'string') out[key] = value;
    } catch {
      /* not a value this reader wrote */
    }
  }
  return out;
}

/**
 * `documentMeta` for the drivers that render a page to a file with its address and edit time in front
 * matter: Notion (`url`, `last_edited_time`) and Confluence (`url`, `last_modified`). The values were put
 * there by the sync from the API's own fields, so reading them costs a few KiB of local I/O per file.
 */
export async function frontmatterMeta(files: readonly DocumentMetaFile[], urlKey: string, dateKey: string): Promise<Map<string, DocumentMeta>> {
  const out = new Map<string, DocumentMeta>();
  for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
    await Promise.all(
      files.slice(i, i + READ_CONCURRENCY).map(async (f) => {
        const fields = await readFrontmatterFields(f.absolutePath, [urlKey, dateKey]);
        out.set(f.path, { url: normalizeSourceUrl(fields[urlKey]), modifiedAt: parseSourceDate(fields[dateKey]) });
      }),
    );
  }
  return out;
}
