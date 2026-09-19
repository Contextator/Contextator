import type { Db } from '../db/client.js';
import type { ProjectRow } from '../db/schema.js';
import type { EmbeddingProvider } from './embeddings/provider.js';
import { normalizeRelativePath } from './fs-scan.js';
import { getProjectById } from './projects.js';
import type { QueryLogSink } from './query-log.js';
import { belowRelevanceFloor } from './relevance.js';
import { getSourceByName, listSources } from './sources.js';
import type { TextSearchConfig } from './text-search.js';
import type { Reranker } from './reranker.js';
import { documentVersionExists, type HnswScan, listDocumentVersions, type ResultSelection, searchChunks, type SearchHit } from './vector-store.js';

/**
 * The one search path in the product (ROADMAP Item 3) — hybrid since
 * [ADR-0041](../../.ssot/ADR.md#adr-0041), which changed what `searchChunks` does and nothing about
 * who calls it. It used to live inside the `search_docs`
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
  /**
   * How far into the HNSW index this search may look (ADR-0040). Optional for the same reason the two
   * fields above are structural: a caller with no configuration still gets a working search, at the
   * schema's own defaults. The server and the evaluation harness both pass `scanFrom(config)`, so an
   * operator who changes `HNSW_EF_SEARCH` changes what they measure and what an agent receives.
   */
  scan?: HnswScan;
  /**
   * The text search configuration the lexical half parses the question with
   * ([ADR-0041](../../.ssot/ADR.md#adr-0041)). Optional for the same structural reason `scan` is, and
   * unset it is `simple` — which is what the server passes, by not passing anything. The evaluation
   * harness is the one caller that varies it, so that `simple` against stemming is a measurement
   * rather than an opinion.
   */
  textSearchConfig?: TextSearchConfig;
  /**
   * The per-document cap and the neighbour context ([ADR-0042](../../.ssot/ADR.md#adr-0042)). Optional
   * for `scan`'s structural reason; unset it is the schema's own defaults.
   */
  selection?: ResultSelection;
  /**
   * The cosine similarity below which this answers `no_good_match` instead of its best hit. Optional,
   * and **unset it is off**, which is deliberately not the schema's default: a caller with no
   * configuration in hand — a test, the harness that measures what the floor would cost — must get the
   * retrieval result rather than a refusal it did not ask for.
   */
  scoreFloor?: number;
  /**
   * Where this search is written down ([ADR-0047](../../.ssot/ADR.md#adr-0047)). Optional, and **unset
   * it is off** — the convention the three fields above already document, and the reason
   * `npm run eval` records nothing: the harness passes no sink, so there is nothing for it to remember
   * not to do.
   *
   * The sink is bound to its actor by the caller, because this function cannot know who is asking.
   * `record()` returns nothing and is never awaited here: **a search must never fail or wait because
   * of the log.**
   */
  queryLog?: QueryLogSink;
  /**
   * The cross-encoder that reorders the fused pool before it is truncated
   * ([ROADMAP.md](../../.ssot/ROADMAP.md) Item 12). Optional, and **unset it is off** — the convention
   * every field above already follows, and here it is also what the product ships: `SEARCH_RERANK`
   * defaults to `off`, so the server passes nothing unless an operator asked for it.
   */
  rerank?: Reranker;
}

export interface SearchInput {
  projectId: string;
  query: string;
  /** 1–20; callers that parse user input should have validated it before getting here. */
  limit?: number;
  /** A source's name, as `list_topics` shows it and as every path is prefixed with. */
  source?: string;
  /** A path prefix, normalised and pattern-escaped below. */
  pathPrefix?: string;
  /**
   * A release label, as `documents.version` carries it ([ADR-0058](../../.ssot/ADR.md#adr-0058)).
   * Matched for equality; there is no ordering and no "latest". Trimmed and resolved below, so that a
   * version this index does not carry is answered with the ones it does.
   */
  version?: string;
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
  /**
   * The project row is re-read on every call, so `project` is what the database holds now.
   *
   * `belowFloor` is an answer and not a failure, which is why it rides here rather than being a status
   * of its own: the hits are returned either way. The MCP tool declines to show them and says so
   * ([ADR-0042](../../.ssot/ADR.md#adr-0042)); the dashboard shows them *under* the notice, because an
   * operator asking why an agent was refused needs to see what was withheld.
   */
  | { status: 'ok'; project: ProjectRow; hits: SearchHit[]; belowFloor: boolean }
  /** The `source` filter named something this project does not have; `available` is what it does have. */
  | { status: 'unknown_source'; project: ProjectRow; requested: string; available: string[] }
  /** `path_prefix` was not a relative path — absolute, or climbing out with `..`. */
  | { status: 'invalid_path_prefix'; project: ProjectRow; requested: string }
  /**
   * The `version` filter named a label nothing in the published index carries; `available` is what it
   * does carry ([ADR-0058](../../.ssot/ADR.md#adr-0058)). `unknown_source`'s shape, and for its
   * reason: an empty page is indistinguishable from a corpus with nothing to say, and the list is
   * also the only honest answer to the question "which is the latest" — the agent reads it and picks.
   */
  | { status: 'unknown_version'; project: ProjectRow; requested: string; available: string[] }
  /** Deleted between the caller acquiring its project and asking this question. */
  | { status: 'project_gone' }
  /** The project exists and has no chunks. Searching it would honestly return nothing at all. */
  | { status: 'not_indexed'; project: ProjectRow }
  /** Those chunks and this query are not in the same space; the next run re-embeds the project. */
  | { status: 'model_mismatch'; project: ProjectRow; indexedWith: string; serverUses: string };

export async function searchProject(
  { db, embeddings, scan, textSearchConfig, selection, scoreFloor, queryLog, rerank }: SearchDeps,
  input: SearchInput,
): Promise<SearchOutcome> {
  const startedAt = Date.now();
  // Re-read rather than trust the row the caller is holding: an MCP session can outlive a
  // re-index, a delete, or a change of embedding model, and each of the three guards below is
  // about a project that is no longer what it was when the caller picked it up.
  const project = await getProjectById(db, input.projectId);
  if (!project) return { status: 'project_gone' };
  if (project.chunkCount === 0) return { status: 'not_indexed', project };
  if (project.embeddingModel && project.embeddingModel !== embeddings.id) {
    return { status: 'model_mismatch', project, indexedWith: project.embeddingModel, serverUses: embeddings.id };
  }

  // The filters are resolved before anything is embedded, because both of their refusals are answers
  // the caller can act on and neither needs a model to produce (ADR-0042). `source` becomes an id
  // here: `documents.source_id` is the real key, a `relative_path LIKE '<source>/%'` prefix match
  // would quietly accept a source that does not exist, and the resolution is what lets the tool say
  // which sources this project *does* have.
  let sourceId: string | undefined;
  if (input.source !== undefined) {
    const source = await getSourceByName(db, project.id, input.source);
    if (!source) {
      const available = (await listSources(db, project.id)).map((row) => row.name);
      return { status: 'unknown_source', project, requested: input.source, available };
    }
    sourceId = source.id;
  }

  // The third filter, resolved here for the two above it's reason and with one difference worth
  // stating: it is checked against the **documents of the live generation** rather than against a
  // configuration table, because a source's `config.version` is what the next run will stamp and this
  // question is about the index being searched now (ADR-0058).
  let version: string | undefined;
  if (input.version !== undefined) {
    const requested = input.version.trim();
    // **The existence check first, and the catalogue only when it fails.** The list is what the
    // *refusal* is built from; asking for it on every search would make a successful one pay for an
    // error message it does not produce. `version` carries no index, deliberately (ADR-0058), so the
    // difference is a scan that stops at the first matching document against one that reads every
    // document of the generation to fold them.
    if (!(await documentVersionExists(db, project.id, project.liveGeneration, requested))) {
      const available = await listDocumentVersions(db, project.id, project.liveGeneration);
      return { status: 'unknown_version', project, requested: input.version, available };
    }
    version = requested;
  }

  let pathPrefix: string | undefined;
  if (input.pathPrefix !== undefined) {
    // `read_document`'s normaliser, deliberately: a path an agent got out of one tool has to be
    // spelled the same way when it is handed to the other, and `..` is refused here for the reason it
    // is refused there rather than being escaped into a pattern that matches nothing.
    const normalized = normalizeRelativePath(input.pathPrefix);
    if (normalized === null) return { status: 'invalid_path_prefix', project, requested: input.pathPrefix };
    pathPrefix = normalized;
  }

  // `embedQuery`, never `embedPassages`: on an asymmetric model these are different encodings of the
  // same string, and the wrong one here costs recall without failing (ADR-0038).
  const vector = await embeddings.embedQuery(input.query);
  // The live generation off the row that was just re-read, passed as a value (ADR-0039). A rebuild
  // may be filling `liveGeneration + 1` at this very moment; this query cannot see it, and the moment
  // the swap commits the next call reads the new number here instead. There is no gap between the two.
  //
  // `input.query` goes to the lexical half **unprefixed**, beside the vector the provider prefixed for
  // the dense one (ADR-0038, ADR-0041): they are two encodings of one question, and the prefix belongs
  // to exactly one of them.
  const hits = await searchChunks(db, {
    projectId: project.id,
    generation: project.liveGeneration,
    queryEmbedding: vector,
    queryText: input.query,
    limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
    sourceId,
    pathPrefix,
    version,
    scan,
    selection,
    textSearchConfig,
    // `rerank.score` and not the reranker: `searchChunks` takes a function of strings for the reason
    // it takes a vector rather than a provider, and binding it here is what keeps the model out of it.
    rerank: rerank ? (query, passages) => rerank.score(query, passages) : undefined,
  });
  const belowFloor = belowRelevanceFloor(input.query, hits, scoreFloor ?? 0);

  // **One seam, three callers** ([ADR-0047](../../.ssot/ADR.md#adr-0047)). The MCP tool and the
  // dashboard route pass a sink; the evaluation harness does not, and that is the whole of why it
  // records nothing. A call at each call site would have been three places to forget.
  //
  // Only the `ok` path is a row. The five outcomes above never reached the index — an unknown source,
  // a project with nothing in it, a model the server no longer runs — so they are configuration states
  // rather than questions this corpus failed to answer, and folding them in would put rows with no
  // score into the average that the whole table exists to compute.
  //
  // `project.queryLogEnabled` is free here: the row was re-read at the top of this function anyway, so
  // the per-project switch costs no query. `record()` is not awaited — see `QueryLogSink`.
  if (queryLog && project.queryLogEnabled) {
    queryLog.record({
      projectId: project.id,
      query: input.query,
      limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
      source: input.source,
      // The normalised prefix rather than what was typed, so that two spellings of one filter are one
      // filter in the log, as they are in the query.
      pathPrefix,
      // The resolved label rather than what was typed, for the same reason — and it is only ever
      // recorded when it named a version this index carries, because an unknown one never reached
      // the search at all (ADR-0058).
      version,
      hits: hits.map((hit) => ({
        relativePath: hit.file,
        headingPath: hit.headingPath,
        chunkIndex: hit.chunkIndex,
        score: hit.score,
      })),
      belowFloor,
      durationMs: Date.now() - startedAt,
      // The encoder that answered *this* question and the generation it answered from, taken from the
      // provider and the row in hand rather than from configuration: a log recorded across a model
      // change otherwise averages two different systems (ROADMAP.md Item 6).
      embeddingModel: embeddings.id,
      liveGeneration: project.liveGeneration,
    });
  }

  return { status: 'ok', project, hits, belowFloor };
}
