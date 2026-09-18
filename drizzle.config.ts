import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Load-bearing, not a convenience. `npm run db:generate` writes `drizzle/*.sql` from the schema
// below, `npm run db:check` proves the two still agree, and `src/db/bootstrap.ts` applies those
// files at every start (ADR-0033). `dbCredentials` is used only by `npm run db:studio`: both
// `generate` and `check` work against the snapshot in `drizzle/meta`, never against a database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://contextator:contextator@localhost:5432/contextator',
  },
});
