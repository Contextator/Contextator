import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Only used by `npm run db:studio`. The runtime schema is applied by src/db/ensure-schema.ts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://contextator:contextator@localhost:5432/contextator',
  },
});
