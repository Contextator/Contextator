import { sql } from 'drizzle-orm';

import type { Logger } from '../context.js';
import type { Db } from './client.js';

/**
 * One partial HNSW index per project, `WHERE project_id = '<uuid>'`, instead of one index every project
 * shares (ROADMAP.md Item 16, `eval/BASELINE.md` "One index per project").
 *
 * **Why.** A shared index answers a project's question by walking the *instance's* nearest neighbours
 * and throwing away every row that belongs to somebody else. `hnsw.max_scan_tuples` bounds that walk by
 * the instance's tuples, and pgvector's own memory cap (`hnsw.scan_mem_multiplier` × `work_mem`) ends it
 * sooner still — so a project whose best rows sit behind enough of its neighbours' is answered short,
 * or not at all, and nothing says so. Measured on `scripts/hnsw-tenancy.ts`'s corpus at 210 500 chunks:
 * the crowded project's recall@10 was 1 % with nine empty pages in ten, and the same project alone in its
 * database scored 88 %. Its own index scores the 88 %.
 *
 * **What it costs, and where it is paid.** Creating a project builds an index over nothing, but a partial
 * index is built by scanning the whole table, so the cost grows with the *instance*: 39 ms at 210 500
 * chunks with writes blocked, 90 ms `CONCURRENTLY` without. Creation is done concurrently, because
 * blocking every other project's indexing to create an empty one is the wrong way round.
 *
 * **Not declared in `schema.ts`**, for the global index's old reason: an HNSW index needs the dimension
 * the bootstrap settles, and a per-project index has a name drizzle's snapshot could never describe.
 *
 * **ADR-0039 is untouched.** Both generations of a project are rows of that project, so both live in its
 * one index during a rebuild; `index_generation` stays the post-filter it always was, now over one
 * project's rows rather than the instance's.
 */

/** The index every project shared before this one existed. The bootstrap drops it. */
export const LEGACY_VECTOR_INDEX = 'chunks_embedding_hnsw_idx';

/** Every per-project index name starts with this and ends with the project's uuid, undashed. */
export const PROJECT_VECTOR_INDEX_PREFIX = 'chunks_embedding_hnsw_p_';

/** NFR-02's parameters, and the operator class [ADR-0040](../../.ssot/ADR.md#adr-0040) searches with. */
const HNSW_METHOD = 'USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Anything with `execute` — the pooled handle or a transaction. */
type Executor = Pick<Db, 'execute'>;

/**
 * DDL takes no parameters, so the uuid is interpolated — and therefore checked here first, against the
 * one shape `projects.id` can have. Every id reaching this came off a `projects` row; the check is what
 * keeps that an observation rather than a precondition.
 */
function checkedProjectId(projectId: string): string {
  const id = projectId.toLowerCase();
  if (!UUID_RE.test(id)) throw new Error(`not a project id: ${JSON.stringify(projectId)}`);
  return id;
}

/** `chunks_embedding_hnsw_p_` + 32 hex digits: 56 characters, inside PostgreSQL's 63. */
export function projectVectorIndexName(projectId: string): string {
  return PROJECT_VECTOR_INDEX_PREFIX + checkedProjectId(projectId).replaceAll('-', '');
}

function createStatement(projectId: string, concurrently: boolean): string {
  const id = checkedProjectId(projectId);
  // The predicate is written exactly as the search's own `c.project_id = $1` resolves once the uuid is
  // bound: the planner proves the partial index applies by matching the two, and a search is planned
  // with its parameters in hand (node-postgres sends unnamed statements, which are planned at bind).
  return `CREATE INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS ${projectVectorIndexName(id)}
    ON chunks ${HNSW_METHOD} WHERE project_id = '${id}'`;
}

/**
 * Builds a new project's index, without blocking anybody else's writes to `chunks`.
 *
 * `CONCURRENTLY` cannot run inside a transaction, so this takes the pooled handle, never a `tx`. A
 * concurrent build that fails leaves an `INVALID` index behind, which `IF NOT EXISTS` would then treat
 * as done forever — so a failure drops what it left before rethrowing. If that cleanup fails too, the
 * original error is still the one that matters, and the bootstrap drops invalid indexes on the next start.
 */
export async function createProjectVectorIndex(db: Db, projectId: string): Promise<void> {
  try {
    await db.execute(sql.raw(createStatement(projectId, true)));
  } catch (err) {
    await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${projectVectorIndexName(projectId)}`)).catch(() => undefined);
    throw err;
  }
}

/**
 * Drops a project's index. `CONCURRENTLY`, because a plain `DROP INDEX` takes `ACCESS EXCLUSIVE` on
 * `chunks` and would queue every other project's searches behind whatever is reading the table.
 */
export async function dropProjectVectorIndex(db: Db, projectId: string): Promise<void> {
  await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${projectVectorIndexName(projectId)}`));
}

interface ExistingIndex {
  name: string;
  valid: boolean;
}

async function existingProjectVectorIndexes(executor: Executor): Promise<ExistingIndex[]> {
  const result = await executor.execute(sql`
    SELECT c.relname AS name, i.indisvalid AS valid
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'chunks'::regclass
      AND starts_with(c.relname, ${PROJECT_VECTOR_INDEX_PREFIX})`);
  return result.rows as unknown as ExistingIndex[];
}

/**
 * Drops every per-project index. `RESET_VECTORS` needs this before it re-types the column, for the reason
 * the global index needed it: an HNSW index fixes the dimension of what it indexes.
 */
export async function dropAllProjectVectorIndexes(executor: Executor): Promise<number> {
  const existing = await existingProjectVectorIndexes(executor);
  for (const index of existing) await executor.execute(sql.raw(`DROP INDEX IF EXISTS ${index.name}`));
  return existing.length;
}

/**
 * Makes the indexes on `chunks` say what `projects` says, on every start and inside the bootstrap's
 * transaction ([ADR-0033](../../.ssot/ADR.md#adr-0033)'s "nothing for the operator to run").
 *
 * - The shared `chunks_embedding_hnsw_idx` goes. It is what an upgrade finds, and what a start of an
 *   older build recreates — which is the rollback: nothing here has to be undone by hand for an older
 *   binary to run, it merely leaves the per-project indexes behind unused.
 * - An index whose project is gone, or that a failed concurrent build left `INVALID`, is dropped.
 * - A project with no valid index gets one. Built plainly rather than concurrently: this is a start,
 *   nothing is serving, and it is the one moment an upgrade pays for every project at once.
 *
 * Steady state is two catalogue reads and nothing else.
 */
export async function reconcileProjectVectorIndexes(executor: Executor, log: Logger): Promise<void> {
  const legacy = await executor.execute(sql`SELECT 1 FROM pg_class WHERE relname = ${LEGACY_VECTOR_INDEX} AND relkind = 'i'`);
  if (legacy.rows.length > 0) {
    await executor.execute(sql.raw(`DROP INDEX IF EXISTS ${LEGACY_VECTOR_INDEX}`));
    log.info({ index: LEGACY_VECTOR_INDEX }, 'dropped the shared vector index; every project gets its own');
  }

  const projectRows = await executor.execute(sql`SELECT id::text AS id FROM projects`);
  const wanted = new Map((projectRows.rows as Array<{ id: string }>).map((row) => [projectVectorIndexName(row.id), row.id]));

  const kept = new Set<string>();
  let dropped = 0;
  for (const index of await existingProjectVectorIndexes(executor)) {
    if (index.valid && wanted.has(index.name)) {
      kept.add(index.name);
      continue;
    }
    await executor.execute(sql.raw(`DROP INDEX IF EXISTS ${index.name}`));
    dropped++;
  }

  let created = 0;
  for (const [name, projectId] of wanted) {
    if (kept.has(name)) continue;
    await executor.execute(sql.raw(createStatement(projectId, false)));
    created++;
  }

  if (created > 0 || dropped > 0) log.info({ created, dropped, projects: wanted.size }, 'reconciled the per-project vector indexes');
}
