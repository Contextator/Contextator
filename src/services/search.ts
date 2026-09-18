import type { Db } from '../db/client.js';
import type { ProjectRow } from '../db/schema.js';
import type { EmbeddingProvider } from './embeddings/provider.js';
import { getProjectById } from './projects.js';
import { searchChunks, type SearchHit } from './vector-store.js';

/**
 * The one search path in the product (ROADMAP Item 3). It used to live inside the `search_docs`
 * handler; three callers now enter here — the MCP tool, `GET /api/projects/:id/search`, and the
 * evaluation harness — because a `recall@k` measured through a second implementation would be a
 * measurement of the second implementation and not of what an agent receives.
 *
 * Deliberately not a Fastify handler and deliberately not a class: it takes a `Db` and an
 * `EmbeddingProvider` by structure, so `ctx` satisfies it as it stands and a harness with nothing
 * but a connection and a provider satisfies it too.
 */

export const DEFAULT_SEARCH_LIMIT = 5;

export interface SearchDeps {
  db: Db;
  embeddings: EmbeddingProvider;
}

export interface SearchInput {
  projectId: string;
  query: string;
  /** 1–20; callers that parse user input should have validated it before getting here. */
  limit?: number;
}

/**
 * Why a union rather than an exception: the three refusals are not failures, they are answers, and
 * each caller says something different about them. The tool turns two of them into an error result
 * and one into an ordinary message; the route turns one into `404` and two into `409`; the harness
 * treats all three as a run it cannot score. An exception would have made the tool's "nothing is
 * indexed yet" — which is not an error — travel as one.
 *
 * `searchProject` still throws for what genuinely broke: an unreachable database, a model that
 * cannot embed. Those are the caller's existing catch, not a case to enumerate here.
 */
export type SearchOutcome =
  /** The project row is re-read on every call, so `project` is what the database holds now. */
  | { status: 'ok'; project: ProjectRow; hits: SearchHit[] }
  /** Deleted between the caller acquiring its project and asking this question. */
  | { status: 'project_gone' }
  /** The project exists and has no chunks. Searching it would honestly return nothing at all. */
  | { status: 'not_indexed'; project: ProjectRow }
  /** Those chunks and this query are not in the same space; the next run re-embeds the project. */
  | { status: 'model_mismatch'; project: ProjectRow; indexedWith: string; serverUses: string };

export async function searchProject({ db, embeddings }: SearchDeps, input: SearchInput): Promise<SearchOutcome> {
  // Re-read rather than trust the row the caller is holding: an MCP session can outlive a
  // re-index, a delete, or a change of embedding model, and each of the three guards below is
  // about a project that is no longer what it was when the caller picked it up.
  const project = await getProjectById(db, input.projectId);
  if (!project) return { status: 'project_gone' };
  if (project.chunkCount === 0) return { status: 'not_indexed', project };
  if (project.embeddingModel && project.embeddingModel !== embeddings.id) {
    return { status: 'model_mismatch', project, indexedWith: project.embeddingModel, serverUses: embeddings.id };
  }

  // `embedQuery`, never `embedPassages`: on an asymmetric model these are different encodings of the
  // same string, and the wrong one here costs recall without failing (ADR-0038).
  const vector = await embeddings.embedQuery(input.query);
  // The live generation off the row that was just re-read, passed as a value (ADR-0039). A rebuild
  // may be filling `liveGeneration + 1` at this very moment; this query cannot see it, and the moment
  // the swap commits the next call reads the new number here instead. There is no gap between the two.
  const hits = await searchChunks(db, project.id, project.liveGeneration, vector, input.limit ?? DEFAULT_SEARCH_LIMIT);
  return { status: 'ok', project, hits };
}
