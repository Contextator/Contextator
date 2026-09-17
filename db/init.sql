-- Runs once when the pgvector container initialises an empty data directory.
-- src/db/ensure-schema.ts repeats this idempotently at app startup, so databases
-- created any other way work as well.
CREATE EXTENSION IF NOT EXISTS vector;
