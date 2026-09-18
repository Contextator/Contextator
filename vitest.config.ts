import { defineConfig } from 'vitest/config';

/**
 * Two projects, because they have different costs (ADR-0031). `unit` is what `npm test` runs: no
 * Docker, no container, seconds. `integration` starts one PostgreSQL + pgvector for the run and is
 * opted into explicitly, by `npm run test:integration` or by CI's own job.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          // `*.itest.ts` does not match `*.test.ts`, but the default loop staying Docker-free is not
          // a property worth resting on a glob subtlety.
          exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.itest.ts'],
          globalSetup: ['test/integration/globalSetup.ts'],
          // A cold run pulls an image; a warm one still has to start a server and apply the schema.
          testTimeout: 120_000,
          hookTimeout: 180_000,
          // Safe, and the reason each file creates its own database: no two files share any state.
          fileParallelism: true,
        },
      },
    ],
  },
});
