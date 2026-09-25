import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Resource,
} from '@modelcontextprotocol/sdk/types.js';
import { LIST_TOPICS_DEFAULT_LIMIT } from '../config.js';
import type { ProjectRow } from '../db/schema.js';
import { normalizeRelativePath } from '../services/fs-scan.js';
import { getProjectById } from '../services/projects.js';
import { getDocument, listDocumentsForProject } from '../services/vector-store.js';
import { type ToolContext, decodeCursor, encodeCursor } from './tools.js';

/**
 * The project's documents as MCP resources (spec 2025-06-18 / 2025-11-25, `resources/list`,
 * `resources/templates/list`, `resources/read`).
 *
 * **This is an access surface, not a convenience, and its boundary is `read_document`'s — narrower,
 * never wider.** [ADR-0019](../../.ssot/ADR.md#adr-0019) closes access to indexed paths, and since
 * [ADR-0051](../../.ssot/ADR.md#adr-0051) `read_document` serves only text that was indexed. A resource
 * is served under the same three conditions and one more:
 *
 * 1. the URI names *this* session's project — a session is bound to one project by the router's auth
 *    ([ADR-0001](../../.ssot/ADR.md#adr-0001)), and a URI naming another is not found, not forbidden,
 *    so the answer does not confirm that project exists;
 * 2. the path is a row of `documents` in the project's **live** generation, looked up exactly — the
 *    filesystem is never touched, so a file beside an indexed one, a file that was excluded, or a file
 *    of a generation still being built is not reachable however its URI is spelled;
 * 3. the text returned is `documents.content`, the stored text `read_document` returns;
 * 4. and, unlike `read_document`, there is **no suffix fallback**: a resource URI is an identifier the
 *    list issued, not a path somebody remembered, so it either names an indexed path or nothing.
 *
 * The URI is `contextator://<project>/<source>/<path>`: the project name (URI-safe by `PROJECT_NAME_RE`)
 * as the authority, and the indexed path — whose first segment is the source since
 * [ADR-0011](../../.ssot/ADR.md#adr-0011) — as the path, one percent-encoded segment at a time. Parsing
 * is done here by hand rather than with `new URL()`, because a WHATWG URL resolves `.` and `..`
 * segments before anything could refuse them, and a dot segment is exactly what has to be refused.
 *
 * The list pages with `list_topics`' keyset cursor ([ADR-0043](../../.ssot/ADR.md#adr-0043)), so a
 * project of any size answers `resources/list` in pages of a fixed size and never all at once.
 */

export const RESOURCE_SCHEME = 'contextator:';

/** The spec's code for a resource that does not exist; the SDK has no name for it. */
export const RESOURCE_NOT_FOUND = -32002;

/** One `resources/list` page; `list_topics`' default page, for the same reason it has that default. */
export const RESOURCE_LIST_PAGE_SIZE = LIST_TOPICS_DEFAULT_LIMIT;

/** `read_document`'s bound on a path, applied to the whole URI with room for the scheme and project. */
const MAX_URI_LENGTH = 1024 + 128;

/** The resource URI of one indexed path. */
export function documentUri(projectName: string, relativePath: string): string {
  return `${RESOURCE_SCHEME}//${projectName}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The project and the indexed path a URI names, or null for anything this server would not have issued.
 *
 * Refused: another scheme; a query or a fragment; an empty, `.` or `..` segment, whether written plainly
 * or percent-encoded; a segment that decodes to a `/` or a `\` (so `%2F` cannot join two segments into
 * one the list never showed); a malformed escape; a control character. What is left must be a path
 * `normalizeRelativePath` returns unchanged, which is the rule every indexed path was written under.
 */
export function parseDocumentUri(uri: string): { project: string; relativePath: string } | null {
  if (uri.length > MAX_URI_LENGTH) return null;
  const prefix = `${RESOURCE_SCHEME}//`;
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  if (rest.includes('?') || rest.includes('#')) return null;
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const project = rest.slice(0, slash);
  const segments: string[] = [];
  for (const raw of rest.slice(slash + 1).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === '' || segment === '.' || segment === '..' || /[/\\\u0000-\u001f\u007f]/.test(segment)) return null;
    segments.push(segment);
  }
  const relativePath = segments.join('/');
  return normalizeRelativePath(relativePath) === relativePath ? { project, relativePath } : null;
}

const notFound = (uri: string): McpError => new McpError(RESOURCE_NOT_FOUND, `Resource not found: ${uri}`, { uri });

/**
 * Registers the three resource handlers on the session's server. Low-level handlers rather than
 * `McpServer.registerResource`, whose list ignores the cursor and would answer a large project in one
 * page — criterion 4 of the phase that added this, and the reason `list_topics` pages at all.
 *
 * Must be called before the server connects: it declares the `resources` capability.
 */
export function registerResources(
  server: McpServer,
  ctx: Pick<ToolContext, 'db' | 'log'>,
  project: ProjectRow,
  opts: { pageSize?: number } = {},
): void {
  const { db, log } = ctx;
  const pageSize = opts.pageSize ?? RESOURCE_LIST_PAGE_SIZE;
  server.server.registerCapabilities({ resources: { listChanged: false } });

  const unexpected = (err: unknown, method: string): McpError => {
    if (err instanceof McpError) return err;
    log.error({ err, method, project: project.name }, 'resource handler failed');
    return new McpError(ErrorCode.InternalError, `${method} failed`);
  };

  server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    try {
      const cursor = request.params?.cursor;
      const after = cursor === undefined ? undefined : decodeCursor(cursor);
      if (after === null) throw new McpError(ErrorCode.InvalidParams, 'That cursor is not one this server issued.');

      // Re-read for the live generation, as list_topics does: a session outlives a re-index (ADR-0039).
      const live = await getProjectById(db, project.id);
      if (!live) throw new McpError(RESOURCE_NOT_FOUND, `Project "${project.name}" no longer exists.`);

      const rows = await listDocumentsForProject(db, project.id, live.liveGeneration, { limit: pageSize + 1, after });
      const docs = rows.slice(0, pageSize);
      const resources: Resource[] = docs.map((doc) => ({
        uri: documentUri(project.name, doc.relativePath),
        name: doc.relativePath,
        title: doc.title,
        mimeType: 'text/markdown',
      }));
      return rows.length > pageSize ? { resources, nextCursor: encodeCursor(docs[docs.length - 1].relativePath) } : { resources };
    } catch (err) {
      throw unexpected(err, 'resources/list');
    }
  });

  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${RESOURCE_SCHEME}//${project.name}/{+path}`,
        name: 'document',
        title: `A ${project.name} document`,
        description: 'One indexed document, by the path search_docs and list_topics show ("<source>/<path>").',
        mimeType: 'text/markdown',
      },
    ],
  }));

  server.server.setRequestHandler(ReadResourceRequestSchema, async (request): Promise<ReadResourceResult> => {
    const { uri } = request.params;
    try {
      const target = parseDocumentUri(uri);
      // Another project's URI is answered exactly as a path that does not exist.
      if (!target || target.project !== project.name) throw notFound(uri);

      const live = await getProjectById(db, project.id);
      if (!live) throw notFound(uri);
      // Exact, and confined to the live generation: the whole of the access check (see the header).
      const doc = await getDocument(db, project.id, live.liveGeneration, target.relativePath);
      if (!doc) throw notFound(uri);
      if (doc.content === null) {
        // read_document's legacy row: indexed before the text was stored. There is nothing to serve,
        // and serving the file instead is what ADR-0051 removed.
        throw new McpError(
          RESOURCE_NOT_FOUND,
          `"${doc.relativePath}" was indexed before this server stored document text; re-index the project to make it readable.`,
          { uri },
        );
      }
      return {
        contents: [
          {
            uri: documentUri(project.name, doc.relativePath),
            mimeType: 'text/markdown',
            text: doc.content,
            ...(doc.contentTruncated ? { _meta: { storedTextTruncated: true } } : {}),
          },
        ],
      };
    } catch (err) {
      throw unexpected(err, 'resources/read');
    }
  });
}
