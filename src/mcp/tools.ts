import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ProjectRow } from '../db/schema.js';
import { isInside, normalizeRelativePath } from '../services/fs-scan.js';
import { DEFAULT_SEARCH_LIMIT, searchProject } from '../services/search.js';
import { driverFor } from '../services/sources/driver.js';
import { getSourceById, listSources } from '../services/sources.js';
import { getDocument, getDocumentBySuffix, listDocumentsForProject, type SearchHit } from '../services/vector-store.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_TOPIC_LINES = 500;

function formatHits(query: string, projectName: string, hits: SearchHit[]): string {
  const lines: string[] = [`Found ${hits.length} result${hits.length === 1 ? '' : 's'} for "${query}" in project "${projectName}":`, ''];
  hits.forEach((hit, i) => {
    const crumb = hit.headingPath ? ` — ${hit.headingPath}` : '';
    lines.push(`### ${i + 1}. ${hit.file}${crumb} (score ${hit.score.toFixed(3)})`);
    lines.push(hit.content.trim());
    lines.push('');
  });
  return lines.join('\n').trimEnd();
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
        `Semantic (vector) search over the "${project.name}" documentation. ` +
        'Returns the most relevant excerpts with their file path, heading breadcrumb and similarity score. ' +
        'Use read_document with a returned file path to read the whole file.',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('Natural-language question or keywords'),
        limit: z.number().int().min(1).max(20).default(DEFAULT_SEARCH_LIMIT).describe('Maximum number of excerpts to return (1-20, default 5)'),
      },
      annotations: readOnly,
    },
    async ({ query, limit }) => {
      try {
        // The guards, the query embedding and the top-k query are services/search.ts; what is left
        // here is the wording, which is prompt-visible and belongs to the tool.
        const outcome = await searchProject({ db, embeddings }, { projectId: project.id, query, limit });
        if (outcome.status === 'project_gone') return fail(`Project "${project.name}" no longer exists.`);
        if (outcome.status === 'not_indexed') {
          return ok(`Project "${project.name}" has no indexed content yet. Trigger indexing from the Contextator dashboard and try again.`);
        }
        if (outcome.status === 'model_mismatch') {
          return fail(
            `This project was indexed with "${outcome.indexedWith}" but the server now embeds with "${outcome.serverUses}". ` +
              'Re-index the project from the Contextator dashboard before searching.',
          );
        }
        if (outcome.hits.length === 0) return ok(`No matching documentation for "${query}". Try different wording or call list_topics to browse.`);
        return ok(formatHits(query, project.name, outcome.hits));
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
        const docs = await listDocumentsForProject(db, project.id);
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

        // Only paths that were indexed for this project are served; the client never addresses the filesystem directly.
        // Paths are `<source>/<path>`; a client remembering an older, unprefixed path still resolves when unambiguous.
        const doc = (await getDocument(db, project.id, relativePath)) ?? (await getDocumentBySuffix(db, project.id, relativePath));
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
