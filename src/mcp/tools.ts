import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { MAX_SEARCH_LIMIT } from '../config.js';
import type { ProjectRow } from '../db/schema.js';
import { isInside, normalizeRelativePath } from '../services/fs-scan.js';
import { getProjectById } from '../services/projects.js';
import { DEFAULT_SEARCH_LIMIT, searchProject } from '../services/search.js';
import { driverFor } from '../services/sources/driver.js';
import { getSourceById, listSources } from '../services/sources.js';
import { getDocument, getDocumentBySuffix, listDocumentsForProject, scanFrom, selectionFrom, type SearchHit } from '../services/vector-store.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_TOPIC_LINES = 500;

/**
 * The first line of each hit — path, breadcrumb, score — is what [API.md](../../.ssot/API.md) §1
 * freezes, and [ADR-0041](../../.ssot/ADR.md#adr-0041) left it alone deliberately: `hit.score` is
 * still the cosine similarity and what moved was the *order*.
 *
 * [ADR-0042](../../.ssot/ADR.md#adr-0042) adds under it what an agent would otherwise spend a
 * `read_document` call to get: the chunk before and the chunk after, marked with a leading and
 * trailing `…` rather than with a label. A label is a line an agent has to be told how to read; an
 * ellipsis is what a quotation from the middle of a page has always looked like, and the excerpt is
 * still the only thing that carries a score.
 *
 * **And it is capped.** A chunk is 96 tokens since ADR-0037, so a hit plus its two neighbours is
 * roughly three times what a hit used to be, and twenty of those is a real fraction of an agent's
 * context spent on a tool result it did not size. Whole excerpts are dropped from the end rather than
 * the text being cut mid-sentence — except when the first one alone is over budget, which has to be
 * cut somewhere — and either way it says so.
 */
function formatHits(query: string, projectName: string, hits: SearchHit[], maxChars: number): string {
  const header = `Found ${hits.length} result${hits.length === 1 ? '' : 's'} for "${query}" in project "${projectName}":`;
  const blocks = hits.map((hit, i) => {
    const crumb = hit.headingPath ? ` — ${hit.headingPath}` : '';
    const body = [
      hit.contextBefore ? `…${hit.contextBefore.trim()}` : null,
      hit.content.trim(),
      hit.contextAfter ? `${hit.contextAfter.trim()}…` : null,
    ].filter((part): part is string => part !== null);
    return [`### ${i + 1}. ${hit.file}${crumb} (score ${hit.score.toFixed(3)})`, ...body].join('\n\n');
  });

  const kept: string[] = [];
  let used = header.length;
  for (const block of blocks) {
    if (kept.length > 0 && used + block.length + 2 > maxChars) break;
    kept.push(block);
    used += block.length + 2;
  }

  let out = [header, ...kept].join('\n\n');
  const omitted = blocks.length - kept.length;
  if (omitted > 0) {
    out += `\n\n[…truncated: ${omitted} further excerpt${omitted === 1 ? '' : 's'} omitted at ${maxChars} characters. Ask for fewer results, or read_document one of the paths above.]`;
  } else if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n[…truncated at ${maxChars} characters]`;
  }
  return out;
}

/** Registers the per-project tool set on a fresh McpServer instance. Handlers never throw; failures come back as `isError`. */
export function registerTools(server: McpServer, ctx: AppContext, project: ProjectRow): void {
  const { db, embeddings, config, log } = ctx;
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    'search_docs',
    {
      title: 'Search documentation',
      description:
        `Hybrid search over the "${project.name}" documentation: meaning and exact wording at once, ` +
        'so an identifier — an environment variable, a header, an error code — finds its page as readily as a question does. ' +
        'Returns the most relevant excerpts with their file path, heading breadcrumb and similarity score, each shown with the ' +
        'passage before and after it for context. Narrow it with source or path_prefix when you already know where the answer lives. ' +
        'When nothing is a good match it says so rather than returning the least bad thing it found. ' +
        'Use read_document with a returned file path to read the whole file.',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('Natural-language question or keywords'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_LIMIT)
          .default(DEFAULT_SEARCH_LIMIT)
          .describe(`Maximum number of excerpts to return (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT})`),
        // Both optional and both absent by default, which is what keeps every already-configured
        // client searching exactly what it searched before (API.md §1).
        source: z
          .string()
          .max(64)
          .optional()
          .describe('Search only this source — the first segment of the paths list_topics shows. Omit to search every source.'),
        path_prefix: z
          .string()
          .max(512)
          .optional()
          .describe('Search only documents whose path starts with this, e.g. "handbook/operations". Omit to search the whole project.'),
      },
      annotations: readOnly,
    },
    async ({ query, limit, source, path_prefix }) => {
      try {
        // The guards, the query embedding and the top-k query are services/search.ts; what is left
        // here is the wording, which is prompt-visible and belongs to the tool.
        const outcome = await searchProject(
          { db, embeddings, scan: scanFrom(config), selection: selectionFrom(config), scoreFloor: config.SEARCH_SCORE_FLOOR },
          { projectId: project.id, query, limit, source, pathPrefix: path_prefix },
        );
        if (outcome.status === 'project_gone') return fail(`Project "${project.name}" no longer exists.`);
        if (outcome.status === 'unknown_source') {
          // The whole reason `source` resolves to an id before it filters anything: an unknown name
          // would otherwise be an empty result, which reads exactly like a corpus that has nothing.
          const known = outcome.available.length > 0 ? outcome.available.join(', ') : 'none yet';
          return fail(`Project "${project.name}" has no source named "${outcome.requested}". Its sources are: ${known}.`);
        }
        if (outcome.status === 'invalid_path_prefix') {
          return fail(`"${outcome.requested}" is not a usable path prefix. Use a relative path as shown by list_topics, e.g. "handbook/operations".`);
        }
        if (outcome.status === 'not_indexed') {
          return ok(`Project "${project.name}" has no indexed content yet. Trigger indexing from the Contextator dashboard and try again.`);
        }
        if (outcome.status === 'model_mismatch') {
          return fail(
            `This project was indexed with "${outcome.indexedWith}" but the server now embeds with "${outcome.serverUses}". ` +
              'Re-index the project from the Contextator dashboard before searching.',
          );
        }
        const scoped =
          source || path_prefix ? ` under ${[source && `source "${source}"`, path_prefix && `"${path_prefix}"`].filter(Boolean).join(' and ')}` : '';
        if (outcome.hits.length === 0) {
          return ok(`No matching documentation for "${query}"${scoped}. Try different wording or call list_topics to browse.`);
        }
        if (outcome.belowFloor) {
          // The first customer of ROADMAP.md Item 6's query log, and deliberately only a log line:
          // "the agent was refused and here is what it asked" is the one event this product has never
          // recorded, and writing it now means the table Item 6 adds starts with a format that has
          // already been read by somebody.
          log.info(
            { tool: 'search_docs', project: project.name, query, topScore: outcome.hits[0].score, floor: config.SEARCH_SCORE_FLOOR },
            'search below the relevance floor',
          );
          return ok(
            `No good match for "${query}"${scoped} in project "${project.name}". The closest passage scored ` +
              `${outcome.hits[0].score.toFixed(3)}, below this server's floor of ${config.SEARCH_SCORE_FLOOR}, which usually means the ` +
              'documentation does not cover it. Call list_topics to see what it does cover, or ask again in the words the documentation ' +
              'would use — an exact identifier, a header name or an error code searches best.',
          );
        }
        return ok(formatHits(query, project.name, outcome.hits, config.SEARCH_MAX_RESULT_CHARS));
      } catch (err) {
        log.error({ err, tool: 'search_docs', project: project.name }, 'tool failed');
        return fail(`search_docs failed: ${message(err)}`);
      }
    },
  );

  server.registerTool(
    'list_topics',
    {
      title: 'List documentation topics',
      description:
        `Lists every indexed document of the "${project.name}" project grouped by source and directory (paths are "<source>/<path>"), ` +
        'with titles and chunk counts. Use it to discover what documentation exists before searching or reading.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        // Re-read for the live generation, for `searchProject`'s reason: a session outlives a
        // re-index, and the row bound to it at connect time can name a generation that has since been
        // superseded — which would list the documents of an index nobody is being served (ADR-0039).
        const live = await getProjectById(db, project.id);
        if (!live) return fail(`Project "${project.name}" no longer exists.`);
        const docs = await listDocumentsForProject(db, project.id, live.liveGeneration);
        if (docs.length === 0) return ok(`Project "${project.name}" has no indexed documents yet.`);
        const sources = await listSources(db, project.id);

        const groups = new Map<string, typeof docs>();
        for (const doc of docs) {
          const dir = doc.relativePath.includes('/') ? `${doc.relativePath.slice(0, doc.relativePath.lastIndexOf('/'))}/` : '(root)';
          const list = groups.get(dir) ?? [];
          list.push(doc);
          groups.set(dir, list);
        }
        const totalChunks = docs.reduce((n, d) => n + d.chunkCount, 0);
        const lines: string[] = [`Project "${project.name}": ${docs.length} documents, ${totalChunks} chunks`];
        if (sources.length > 0) {
          lines.push(`Sources (the first path segment): ${sources.map((s) => `${s.name} (${s.type}${s.label ? `: ${s.label}` : ''})`).join(', ')}`);
        }
        for (const [dir, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          lines.push('', `${dir} — ${list.length} document${list.length === 1 ? '' : 's'}, ${list.reduce((n, d) => n + d.chunkCount, 0)} chunks`);
          for (const doc of list) lines.push(`  • ${doc.relativePath} — ${doc.title} (${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'})`);
        }
        if (lines.length > MAX_TOPIC_LINES) {
          const hidden = lines.length - MAX_TOPIC_LINES;
          lines.length = MAX_TOPIC_LINES;
          lines.push(`… ${hidden} more lines omitted. Use search_docs to find specific documents.`);
        }
        return ok(lines.join('\n'));
      } catch (err) {
        log.error({ err, tool: 'list_topics', project: project.name }, 'tool failed');
        return fail(`list_topics failed: ${message(err)}`);
      }
    },
  );

  server.registerTool(
    'read_document',
    {
      title: 'Read a documentation file',
      description:
        `Returns the full Markdown content of one indexed file of the "${project.name}" project. ` +
        'Pass the path exactly as shown by search_docs or list_topics (e.g. "docs/guides/install.md"; the first segment is the source).',
      inputSchema: {
        path: z.string().min(1).max(1024).describe('Relative file path as listed by search_docs / list_topics'),
      },
      annotations: readOnly,
    },
    async ({ path: requested }) => {
      try {
        const relativePath = normalizeRelativePath(requested);
        if (!relativePath) return fail(`Invalid path "${requested}".`);

        const live = await getProjectById(db, project.id);
        if (!live) return fail(`Project "${project.name}" no longer exists.`);

        // Only paths that were indexed for this project are served; the client never addresses the filesystem directly.
        // Paths are `<source>/<path>`; a client remembering an older, unprefixed path still resolves when unambiguous.
        // Both lookups are confined to the live generation, so a rebuild in flight neither hides a
        // document nor makes the suffix fallback ambiguous against its own copy of it (ADR-0039).
        const generation = live.liveGeneration;
        const doc =
          (await getDocument(db, project.id, generation, relativePath)) ?? (await getDocumentBySuffix(db, project.id, generation, relativePath));
        if (!doc) return fail(`Unknown document "${relativePath}". Use list_topics or the file paths returned by search_docs.`);

        const source = doc.sourceId ? await getSourceById(db, doc.sourceId) : undefined;
        if (!source) return fail(`The source of "${doc.relativePath}" no longer exists. Re-index the project from the dashboard.`);
        const rootReal = await driverFor(source, { db, log, config }).docRoot();
        const inside = doc.relativePath.slice(source.name.length + 1);
        const absolute = path.resolve(rootReal, ...inside.split('/'));
        if (!isInside(rootReal, absolute)) return fail('Path escapes the source root.');

        let buf: Buffer;
        try {
          buf = await fs.readFile(absolute);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return fail(`"${relativePath}" was removed from disk after the last index. Re-index the project from the dashboard.`);
          }
          throw err;
        }
        let body = buf.toString('utf8');
        if (buf.byteLength > MAX_DOCUMENT_BYTES) {
          body = `${buf.subarray(0, MAX_DOCUMENT_BYTES).toString('utf8')}\n\n[truncated: file is ${buf.byteLength} bytes, showing the first ${MAX_DOCUMENT_BYTES}]`;
        }
        return ok(`File: ${doc.relativePath}\nTitle: ${doc.title}\n\n---\n\n${body}`);
      } catch (err) {
        log.error({ err, tool: 'read_document', project: project.name }, 'tool failed');
        return fail(`read_document failed: ${message(err)}`);
      }
    },
  );
}
