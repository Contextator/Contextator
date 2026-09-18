-- The shape a Contextator 0.1 database had *before* the v3 source model.
--
-- Derived, not invented. `git log --oneline -- src/db/ensure-schema.ts` has four revisions and the
-- earliest of them (746cc79, "first") already carries SCHEMA_VERSION = 3 — so no revision of that file
-- ever produced this schema; the pre-v3 shape survives only as the three upgrade steps that 746cc79
-- wrote to repair it, and each line below is one of them read backwards:
--
--   ALTER TABLE projects ALTER COLUMN root_path DROP NOT NULL         -> root_path was NOT NULL
--   ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_id …        -> documents had no source_id
--   CREATE TABLE IF NOT EXISTS document_sources …                     -> there were no sources at all
--   (and its own comment: "Pre-v3 databases created the table without the column")
--
-- Everything else is 746cc79's DDL with the v4 (accounts) and v5 (per-project MCP tokens) tables and
-- the `projects.mcp_auth` column removed, because neither existed. schema_version is 2 for the same
-- reason: 3 is the version whose migration this fixture is the input to.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE project_status AS ENUM ('idle', 'indexing', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  root_path text NOT NULL,
  status project_status NOT NULL DEFAULT 'idle',
  chunk_count integer NOT NULL DEFAULT 0,
  document_count integer NOT NULL DEFAULT 0,
  last_indexed_at timestamptz,
  last_error text,
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relative_path text NOT NULL,
  title text NOT NULL,
  content_hash text NOT NULL,
  size_bytes integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_project_path_uq UNIQUE (project_id, relative_path)
);
CREATE INDEX documents_project_idx ON documents (project_id);

CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  heading_path text NOT NULL DEFAULT '',
  content text NOT NULL,
  token_count integer NOT NULL,
  embedding vector(384) NOT NULL
);
CREATE INDEX chunks_project_idx ON chunks (project_id);
CREATE INDEX chunks_document_idx ON chunks (document_id);
CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE index_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode text NOT NULL,
  status text NOT NULL,
  files_total integer NOT NULL DEFAULT 0,
  files_skipped integer NOT NULL DEFAULT 0,
  files_updated integer NOT NULL DEFAULT 0,
  files_removed integer NOT NULL DEFAULT 0,
  chunks_written integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0,
  error text
);
CREATE INDEX index_runs_project_idx ON index_runs (project_id, started_at DESC);

INSERT INTO settings (key, value) VALUES
  ('embedding_dimensions', '384'),
  ('schema_version', '2');
