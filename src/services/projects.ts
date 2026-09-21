import { asc, eq } from 'drizzle-orm';
import { PROJECT_NAME_RE } from '../config.js';
import type { Db } from '../db/client.js';
import { projects, type ProjectRow } from '../db/schema.js';
import { createMcpToken, type McpTokenView } from './auth/mcp-tokens.js';
import { resolveProjectRoot } from './fs-scan.js';

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

  try {
    const [row] = await db.insert(projects).values({ name, rootPath }).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`A project named "${name}" already exists`);
    throw err;
  }
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

/** Deletes a project and (via ON DELETE CASCADE) all of its documents and chunks. */
export async function deleteProject(db: Db, id: string, isBusy: (projectId: string) => boolean): Promise<ProjectRow> {
  const project = await getProjectById(db, id);
  if (!project) throw new NotFoundError('Project not found');
  if (project.status === 'indexing' || isBusy(id)) {
    throw new ConflictError('Project is currently being indexed; try again when it finishes');
  }
  await db.delete(projects).where(eq(projects.id, id));
  return project;
}
