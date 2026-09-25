import { and, asc, eq, ne } from 'drizzle-orm';
import { PROJECT_NAME_RE } from '../config.js';
import type { Db } from '../db/client.js';
import { projects, type ProjectRow } from '../db/schema.js';
import { createProjectVectorIndex, dropProjectVectorIndex } from '../db/vector-indexes.js';
import { createMcpToken, type McpTokenView } from './auth/mcp-tokens.js';
import { resolveProjectRoot } from './fs-scan.js';
import type { KeyedMutex } from './locks.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export async function listProjects(db: Db): Promise<ProjectRow[]> {
  return db.select().from(projects).orderBy(asc(projects.name));
}

export async function getProjectById(db: Db, id: string): Promise<ProjectRow | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row;
}

/**
 * The project row under `FOR KEY SHARE`, for a transaction that is about to insert rows pointing at it
 * and has already locked a row the project's `ON DELETE CASCADE` would have to delete.
 *
 * A delete locks the project row first and the cascaded rows after it; such a transaction holds a
 * cascaded row first and needs the project row (the foreign key check of its insert) after it. Those
 * are opposite orders, and the two deadlock — Postgres then aborts one of them, and when that is the
 * transaction it answers with a server error. Taking the project row here, before the other lock,
 * puts both in the same order: a delete that got there first has committed by the time this returns
 * (and the row is gone), and one that comes later waits for this commit and cascades over whatever it
 * inserted. `KEY SHARE` is the weakest lock that does it — only a delete or a key change waits on it.
 */
export async function keyShareProjectRow(tx: Db, id: string): Promise<ProjectRow | undefined> {
  const [row] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1).for('key share');
  return row;
}

/**
 * Sets this project's own relevance floor, or with `null` hands it back to `SEARCH_SCORE_FLOOR`.
 *
 * It takes effect on the next search: `searchProject` re-reads the row on every call. Returns what the
 * row now holds, `undefined` when there is no such project.
 */
export async function setProjectScoreFloor(db: Db, id: string, floor: number | null): Promise<{ scoreFloor: number | null } | undefined> {
  const [row] = await db.update(projects).set({ scoreFloor: floor }).where(eq(projects.id, id)).returning({ scoreFloor: projects.scoreFloor });
  return row;
}

export async function getProjectByName(db: Db, name: string): Promise<ProjectRow | undefined> {
  const [row] = await db.select().from(projects).where(eq(projects.name, name)).limit(1);
  return row;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

/**
 * Validates the name and inserts the project. Documents come from the project's sources
 * (services/sources.ts); a legacy `rootPath` is validated here and turned into a local source by the caller.
 */
export async function createProject(db: Db, input: { name: string; rootPath?: string }, allowedRoots: string[]): Promise<ProjectRow> {
  const name = input.name.trim();
  if (!PROJECT_NAME_RE.test(name)) {
    throw new ValidationError('Project name must be 1-63 characters of lowercase letters, digits, "-" or "_", and start with a letter or digit');
  }
  const rootPath = input.rootPath?.trim() || null;
  if (rootPath) await resolveProjectRoot(rootPath, allowedRoots); // throws PathNotAllowedError

  let row: ProjectRow;
  try {
    [row] = await db.insert(projects).values({ name, rootPath }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`A project named "${name}" already exists`);
    throw err;
  }

  // The project's own vector index, before its first chunk (src/db/vector-indexes.ts). A project the
  // index could not be built for is taken back rather than left to be searched without one: an exact
  // scan would answer correctly, but the next start would build the index under the bootstrap lock.
  try {
    await createProjectVectorIndex(db, row.id);
  } catch (err) {
    await db.delete(projects).where(eq(projects.id, row.id));
    throw err;
  }
  return row;
}

/** The name the first token is given, so the list says where it came from without anybody typing it. */
export const FIRST_TOKEN_NAME = 'First token';

export interface CreatedProject {
  project: ProjectRow;
  /**
   * The first token in the clear, or `null` when the project was born in a mode that needs none. The
   * secret is here once and never again: the database holds its sha256, exactly as for a token minted
   * later from the MCP access panel.
   */
  mcpToken: { secret: string; view: McpTokenView } | null;
}

/**
 * The dashboard's creation path: a project, and the credential to reach it with
 * ([ADR-0065](../../.ssot/ADR.md#adr-0065), PRD.md FR-510).
 *
 * A project is born `token` (`DEFAULT_MCP_AUTH` in `src/db/schema.ts`), which means it is born
 * unreachable until somebody mints one — so the minting happens here, in the same call, rather than
 * being a second step an operator discovers by finding their new endpoint answering `401`. The two
 * halves are what make the new default cost nothing: the endpoint is closed from its first second, and
 * the operator leaves the creation dialog holding the one thing that opens it.
 *
 * **Separate from `createProject` on purpose.** The import path restores a project's *recorded* mode
 * from the manifest and mints nothing, because a token minted there would be a credential nobody asked
 * for attached to a project whose real credentials live on the instance it came from.
 */
export async function createProjectWithFirstToken(
  db: Db,
  input: { name: string; rootPath?: string; createdBy: string | null },
  allowedRoots: string[],
): Promise<CreatedProject> {
  const project = await createProject(db, input, allowedRoots);
  if (project.mcpAuth !== 'token') return { project, mcpToken: null };
  const { token, view } = await createMcpToken(db, project.id, FIRST_TOKEN_NAME, input.createdBy);
  return { project, mcpToken: { secret: token, view } };
}

/**
 * Deletes a project and (via ON DELETE CASCADE) all of its documents and chunks.
 *
 * Its vector index goes first: dropped concurrently it blocks nobody, and a delete that then fails
 * leaves a project searched by exact scan until the next start rebuilds its index — correct, if slow.
 * The other order would leave an index over rows that no longer exist until that same start.
 *
 * **The "is it busy" check and the delete are one step.** Checked once and deleted afterwards, a
 * re-index enqueued in between would start on a project that is about to vanish, and both would
 * happen. So the decision is taken again under the project's mutex — the one an index run holds from
 * the moment it touches the project until it has finished (`Indexer.indexProject`) — and the delete
 * happens before that mutex is let go. A run that was enqueued before the re-check makes the delete a
 * conflict; one enqueued after it waits for the mutex, finds the project gone and does nothing. The
 * first look, outside the mutex, only spares a request the wait when the answer is already no.
 */
export async function deleteProject(
  db: Db,
  id: string,
  isBusy: (projectId: string) => boolean,
  locks: Pick<KeyedMutex, 'runExclusive'>,
): Promise<ProjectRow> {
  const busy = () => new ConflictError('Project is currently being indexed; try again when it finishes');
  const project = await getProjectById(db, id);
  if (!project) throw new NotFoundError('Project not found');
  if (project.status === 'indexing' || isBusy(id)) throw busy();

  return locks.runExclusive(id, async () => {
    const current = await getProjectById(db, id);
    if (!current) throw new NotFoundError('Project not found');
    if (current.status === 'indexing' || isBusy(id)) throw busy();
    await dropProjectVectorIndex(db, id);
    // Conditional as well, so the row the decision was about is the row that goes: a status of
    // `indexing` written by anything that does not go through this process's mutex still wins.
    const deleted = await db
      .delete(projects)
      .where(and(eq(projects.id, id), ne(projects.status, 'indexing')))
      .returning({ id: projects.id });
    if (deleted.length === 0) {
      if (!(await getProjectById(db, id))) throw new NotFoundError('Project not found');
      throw busy();
    }
    return current;
  });
}
