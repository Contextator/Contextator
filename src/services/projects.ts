import { asc, eq } from 'drizzle-orm';
import { PROJECT_NAME_RE } from '../config.js';
import type { Db } from '../db/client.js';
import { projects, type ProjectRow } from '../db/schema.js';
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
