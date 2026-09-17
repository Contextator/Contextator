import path from 'node:path';
import { z } from 'zod';

/** Project names double as URL segments (`/mcp/:projectName`), so keep them URL-safe. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const flag = (value: string): boolean => value === '1' || value.toLowerCase() === 'true';

const EnvSchema = z
  .object({
    // Server
    PORT: z.coerce.number().int().positive().default(3444),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    PUBLIC_BASE_URL: z.url().optional(),
    ADMIN_TOKEN: z.string().min(1).optional(),
    ALLOWED_ORIGINS: z.string().default('').transform(csv),
    SESSION_IDLE_TTL_MS: z.coerce.number().int().min(60_000).default(30 * 60_000),

    // Database: a connection string, or (when unset) the libpq PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
    // variables that node-postgres reads itself. The Docker image uses the latter for its embedded PostgreSQL.
    DATABASE_URL: z.string().min(1).optional(),
    RESET_VECTORS: z.string().default('0').transform(flag),

    // Documents
    ALLOWED_DOC_ROOTS: z.string().default('/docs').transform(csv),
    IGNORE_GLOBS: z.string().default('').transform(csv),
    /** Writable directory for materialised sources (git checkouts, uploads, Notion pulls). */
    DATA_DIR: z.string().default('.data').transform((p) => path.resolve(p)),
    /** Encrypts source secrets (git / Notion tokens) at rest. Only needed once such a source exists. */
    SECRET_KEY: z.string().min(32, 'must be at least 32 characters').optional(),

    // Uploads and archives
    UPLOAD_MAX_FILE_BYTES: z.coerce.number().int().min(1024).default(50 * 1024 * 1024),
    UPLOAD_MAX_FILES_PER_REQUEST: z.coerce.number().int().min(1).max(5000).default(500),
    UPLOAD_MAX_ARCHIVE_BYTES: z.coerce.number().int().min(1024).default(256 * 1024 * 1024),
    ARCHIVE_MAX_ENTRIES: z.coerce.number().int().min(1).default(20_000),
    ARCHIVE_MAX_TOTAL_BYTES: z.coerce.number().int().min(1024).default(1024 * 1024 * 1024),

    // Embeddings
    EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('local'),
    EMBEDDING_MODEL: z.string().default('Xenova/paraphrase-multilingual-MiniLM-L12-v2'),
    // 2000 is the pgvector HNSW limit for the `vector` type
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(2000).default(384),
    EMBEDDING_DTYPE: z.enum(['fp32', 'fp16', 'q8']).default('fp32'),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(256).default(16),
    MODEL_CACHE_DIR: z.string().default('.cache/models'),
    EMBEDDING_OFFLINE: z.string().default('0').transform(flag),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

    // Chunking (tokens are approximated as chars / 4)
    CHUNK_MAX_TOKENS: z.coerce.number().int().min(50).max(4000).default(400),
    CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).default(50),
  })
  .superRefine((c, ctx) => {
    if (c.EMBEDDING_PROVIDER === 'openai' && !c.OPENAI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['OPENAI_API_KEY'], message: 'required when EMBEDDING_PROVIDER=openai' });
    }
    if (c.CHUNK_OVERLAP_TOKENS >= c.CHUNK_MAX_TOKENS) {
      ctx.addIssue({ code: 'custom', path: ['CHUNK_OVERLAP_TOKENS'], message: 'must be smaller than CHUNK_MAX_TOKENS' });
    }
    if (c.ALLOWED_DOC_ROOTS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['ALLOWED_DOC_ROOTS'], message: 'at least one directory is required' });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

/**
 * Parses and validates process.env. Empty-string values are treated as unset so that
 * `.env.example` placeholders such as `ADMIN_TOKEN=` behave like missing keys.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    console.error('Invalid configuration:\n' + z.prettifyError(result.error));
    process.exit(1);
  }
  if (!result.data.DATABASE_URL && !raw.PGHOST && !raw.PGDATABASE) {
    console.error('Invalid configuration:\n✖ Set DATABASE_URL, or the libpq variables PGHOST/PGUSER/PGPASSWORD/PGDATABASE.');
    process.exit(1);
  }
  return result.data;
}

/**
 * Lightweight accessor used by db/schema.ts. The Drizzle schema needs the vector
 * dimension at module-load time (drizzle-kit imports it without the full config).
 */
export function embeddingDimensionsFromEnv(): number {
  const n = Number(process.env.EMBEDDING_DIMENSIONS);
  return Number.isInteger(n) && n > 0 ? n : 384;
}
