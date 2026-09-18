import type { TestProject } from 'vitest/node';

import { startPostgres } from './support/postgres.js';

/**
 * Runs once for the whole `integration` project (ADR-0031): one container, started before the first
 * test file and stopped after the last. Test files do not start anything — they `inject` this URL and
 * create their own database from it.
 */

declare module 'vitest' {
  interface ProvidedContext {
    /** Connection URL of the container's bootstrap database. */
    postgresBaseUrl: string;
    /** Which image it came from, so a version-sensitive failure says what it ran against. */
    postgresImage: string;
    /**
     * The container's Docker id. `backup-restore.itest.ts` needs it because `pg_dump` and
     * `pg_restore` have to run inside the container, next to the server they speak to, rather than
     * against whatever version the host happens to have installed.
     */
    postgresContainerId: string;
  }
}

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const postgres = await startPostgres();
  project.provide('postgresBaseUrl', postgres.baseUrl);
  project.provide('postgresImage', postgres.image);
  project.provide('postgresContainerId', postgres.containerId);
  return async () => {
    await postgres.stop();
  };
}
