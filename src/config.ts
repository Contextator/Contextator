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

/**
 * Held back from `CHUNK_MAX_TOKENS` when it is checked against the model's window (ADR-0035).
 *
 * Both of the things it was originally sized for are now counted rather than guessed at (ADR-0036): the
 * chunker subtracts each section's own heading breadcrumb, and `CHUNK_TOKENIZER_RESERVE_TOKENS` below
 * covers the tokenizer's special tokens. What is left for this margin to absorb is the tiny-chunk merge,
 * which can append a stub to a chunk that was already at budget, and the fact that a subword tokenizer
 * is not additive — `count(a) + count(b)` and `count(a + b)` differ by a token either way.
 */
export const CHUNK_BUDGET_RESERVE_TOKENS = 16;

/**
 * What the chunker itself sets aside, per chunk, on top of the breadcrumb it counts (ADR-0036): the
 * `<s>`/`</s>` the tokenizer wraps every input in, which `EmbeddingProvider.countTokens` deliberately
 * does not report. PR 1.4's `passage: ` prefix is added here when it lands.
 */
export const CHUNK_TOKENIZER_RESERVE_TOKENS = 2;

/** `CHUNK_MAX_TOKENS`' own floor, so a suggested budget is never a value the schema would refuse. */
export const CHUNK_MAX_TOKENS_MIN = 50;

/** Exported for the tests: the cross-field rules are the only part of this file that has behaviour. */
export const EnvSchema = z
  .object({
    // Server
    PORT: z.coerce.number().int().positive().default(3444),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    PUBLIC_BASE_URL: z.url().optional(),
    /** Machine access to /api/*, acting with root permissions. People sign in with an account. */
    ADMIN_TOKEN: z.string().min(1).optional(),
    ALLOWED_ORIGINS: z.string().default('').transform(csv),
    /** MCP transport sessions, not dashboard sign-ins — those are AUTH_SESSION_IDLE_MS. */
    SESSION_IDLE_TTL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(30 * 60_000),

    // Authentication (dashboard accounts). See src/auth/.
    /** A dashboard session that goes unused for this long has to sign in again. */
    AUTH_SESSION_IDLE_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(12 * 60 * 60_000),
    /** Hard ceiling on a session's life, however actively it is used. */
    AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    /** `auto` sets Secure when the request arrived over HTTPS; force it behind a proxy. */
    AUTH_COOKIE_SECURE: z.enum(['auto', '1', '0']).default('auto'),
    AUTH_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(1000).default(10),
    AUTH_LOGIN_WINDOW_MIN: z.coerce.number().int().min(1).max(1440).default(15),
    PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(12),
    /** Pins the first-run setup code instead of generating one. Ignored once an account exists. */
    SETUP_CODE: z.string().min(8).max(128).optional(),

    // Database: a connection string, or (when unset) the libpq PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
    // variables that node-postgres reads itself. The Docker image uses the latter for its embedded PostgreSQL.
    DATABASE_URL: z.string().min(1).optional(),
    RESET_VECTORS: z.string().default('0').transform(flag),

    // Documents
    ALLOWED_DOC_ROOTS: z.string().default('/docs').transform(csv),
    IGNORE_GLOBS: z.string().default('').transform(csv),
    /** Writable directory for materialised sources (git checkouts, uploads, Notion pulls). */
    DATA_DIR: z
      .string()
      .default('.data')
      .transform((p) => path.resolve(p)),
    /** Encrypts source secrets (git / Notion tokens) at rest. Only needed once such a source exists. */
    SECRET_KEY: z.string().min(32, 'must be at least 32 characters').optional(),

    // Uploads and archives
    UPLOAD_MAX_FILE_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(50 * 1024 * 1024),
    UPLOAD_MAX_FILES_PER_REQUEST: z.coerce.number().int().min(1).max(5000).default(500),
    UPLOAD_MAX_ARCHIVE_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(256 * 1024 * 1024),
    ARCHIVE_MAX_ENTRIES: z.coerce.number().int().min(1).default(20_000),
    ARCHIVE_MAX_TOTAL_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(1024 * 1024 * 1024),

    // Embeddings
    EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('local'),
    /**
     * `multilingual-e5-small` is trained for retrieval rather than for paraphrase similarity, reads 512
     * tokens where the previous default read 128, and is 384-dimensional — so the swap needs no
     * `EMBEDDING_DIMENSIONS` change, no re-typed column and no `RESET_VECTORS` (ADR-0037). It does change
     * the provider id, and every project indexed with the old one re-indexes itself on its next run.
     */
    EMBEDDING_MODEL: z.string().default('Xenova/multilingual-e5-small'),
    // 2000 is the pgvector HNSW limit for the `vector` type
    EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(2000).default(384),
    EMBEDDING_DTYPE: z.enum(['fp32', 'fp16', 'q8']).default('fp32'),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(256).default(16),
    MODEL_CACHE_DIR: z.string().default('.cache/models'),
    EMBEDDING_OFFLINE: z.string().default('0').transform(flag),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    /**
     * What the model reads usefully — the window it was trained at, not where the tokenizer cuts.
     * Deliberately optional and deliberately without a default: the window is a runtime fact the local
     * provider discovers from the loaded tokenizer, and a number guessed here from `process.env` would
     * be wrong for exactly the operator running a model this product has never heard of (ADR-0035).
     * Setting it both overrules what the provider discovers and makes the check below fire at startup.
     */
    EMBEDDING_MAX_INPUT_TOKENS: z.coerce.number().int().min(64).max(32_000).optional(),

    // Chunking (counted with the embedding model's own tokenizer — ADR-0036)
    /**
     * 96, and it is a measurement rather than a derivation. The default model reads 512 tokens, so the
     * budget check would allow 496 — and 496 measures worse than 96 on the golden set, because a long
     * passage's mean-pooled vector is an average of more things and there are fewer chunks to hit
     * (ADR-0037). 88, 96, 104 and 108 all measure identically; 96 is the interior of that plateau rather
     * than its edge, which is at 112. An operator on OpenAI's 8191-token window should still raise it.
     */
    CHUNK_MAX_TOKENS: z.coerce.number().int().min(CHUNK_MAX_TOKENS_MIN).max(4000).default(96),
    /** A quarter of the budget, because what has to survive a chunk boundary is a sentence, and a sentence does not get shorter when the budget does. */
    CHUNK_OVERLAP_TOKENS: z.coerce.number().int().min(0).default(24),
  })
  .superRefine((c, ctx) => {
    if (c.EMBEDDING_PROVIDER === 'openai' && !c.OPENAI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['OPENAI_API_KEY'], message: 'required when EMBEDDING_PROVIDER=openai' });
    }
    if (c.CHUNK_OVERLAP_TOKENS >= c.CHUNK_MAX_TOKENS) {
      ctx.addIssue({ code: 'custom', path: ['CHUNK_OVERLAP_TOKENS'], message: 'must be smaller than CHUNK_MAX_TOKENS' });
    }
    // Only when the operator has stated the window. Unset, this rule says nothing at all — the runtime
    // half in src/services/chunk-budget.ts is what checks a window that had to be discovered, and it
    // warns rather than exiting. Stated and contradicted is the one case that is a refusal (ADR-0035).
    if (c.EMBEDDING_MAX_INPUT_TOKENS !== undefined && c.CHUNK_MAX_TOKENS + CHUNK_BUDGET_RESERVE_TOKENS > c.EMBEDDING_MAX_INPUT_TOKENS) {
      const suggested = Math.max(CHUNK_MAX_TOKENS_MIN, c.EMBEDDING_MAX_INPUT_TOKENS - CHUNK_BUDGET_RESERVE_TOKENS);
      ctx.addIssue({
        code: 'custom',
        path: ['CHUNK_MAX_TOKENS'],
        message:
          `plus ${CHUNK_BUDGET_RESERVE_TOKENS} reserved tokens does not fit in EMBEDDING_MAX_INPUT_TOKENS=${c.EMBEDDING_MAX_INPUT_TOKENS}; ` +
          `set it to ${suggested} or lower, or raise the window if the model really reads that much`,
      });
    }
    if (c.ALLOWED_DOC_ROOTS.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['ALLOWED_DOC_ROOTS'], message: 'at least one directory is required' });
    }
    if (c.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60_000 < c.AUTH_SESSION_IDLE_MS) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_SESSION_TTL_DAYS'], message: 'must not be shorter than AUTH_SESSION_IDLE_MS' });
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
