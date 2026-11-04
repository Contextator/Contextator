-- The database a Contextator 1.0.0 start leaves behind (schema_version 5, drizzle journal 0000-0031),
-- with a handful of seed rows. The counterpart of schema-0.1.sql: that one is the oldest shape the
-- bootstrap refuses, this one is the shape 1.x promises to carry forward (ADR-0137, Tier 1).
--
-- Recorded, not hand-written. Against the product's own `bootstrapDatabase` (embedding dimension 384,
-- PostgreSQL 16 + pgvector from `pgvector/pgvector:pg16`): the bootstrap on an empty database, then one
-- project (`handbook`, through `createProject`, so it carries its own HNSW index), one `root` user, one
-- `upload` source with one document and two chunks. `pg_dump --no-owner --no-privileges --column-inserts
-- --rows-per-insert=100` (16.15) wrote the rest, and the only edits are removals: the `\restrict` lines and the session `SET`s, which
-- would otherwise outlive the script on the pooled connection that runs it. The password hash is a
-- placeholder and the vectors are constant: nothing here is a credential or a real embedding.
--
-- It is kept for the whole of 1.x. A later migration changes the schema, never this file: the test loads
-- it, runs the bootstrap, and compares the result with a database the bootstrap built from nothing.
-- Re-recording it to make a failure go away would remove the thing it checks.

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';

--
-- Name: project_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.project_status AS ENUM (
    'idle',
    'indexing',
    'error'
);

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;

--
-- Name: api_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    token_hash text NOT NULL,
    prefix text NOT NULL,
    scope jsonb NOT NULL,
    project_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    expires_at timestamp with time zone
);

--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    action text NOT NULL,
    actor_kind text NOT NULL,
    actor_user_id uuid,
    actor_label text NOT NULL,
    actor_ip text,
    project_id uuid,
    target_type text,
    target_id text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    status_code integer NOT NULL,
    CONSTRAINT audit_events_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'token'::text, 'api_token'::text]))),
    CONSTRAINT audit_events_actor_label_check CHECK ((length(btrim(actor_label)) > 0)),
    CONSTRAINT audit_events_actor_user_check CHECK (((actor_kind = ANY (ARRAY['user'::text, 'api_token'::text])) OR (actor_user_id IS NULL)))
);

--
-- Name: chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    document_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    heading_path text DEFAULT ''::text NOT NULL,
    content text NOT NULL,
    token_count integer NOT NULL,
    embedding public.vector(384) NOT NULL,
    index_generation integer DEFAULT 0 NOT NULL,
    content_tsv tsvector,
    text_search_config text DEFAULT 'simple'::text NOT NULL
);

--
-- Name: document_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_changes (
    project_id uuid NOT NULL,
    relative_path text NOT NULL,
    change text NOT NULL,
    title text NOT NULL,
    version text DEFAULT ''::text NOT NULL,
    added_at timestamp with time zone,
    changed_at timestamp with time zone NOT NULL,
    run_id uuid,
    CONSTRAINT document_changes_change_check CHECK ((change = ANY (ARRAY['added'::text, 'modified'::text, 'removed'::text])))
);

--
-- Name: document_findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_findings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    document_id uuid NOT NULL,
    rule text NOT NULL,
    line integer NOT NULL,
    col integer NOT NULL,
    start_offset integer NOT NULL,
    length integer NOT NULL,
    preview text NOT NULL,
    value_hmac text,
    hmac_key_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_findings_rule_check CHECK ((rule = ANY (ARRAY['aws_access_key'::text, 'github_token'::text, 'private_key'::text, 'jwt'::text, 'tckn'::text, 'iban'::text])))
);

--
-- Name: document_scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_scans (
    document_id uuid NOT NULL,
    project_id uuid NOT NULL,
    status text NOT NULL,
    ruleset smallint NOT NULL,
    content_hash text NOT NULL,
    hmac_key_id text,
    finding_count integer NOT NULL,
    capped boolean NOT NULL,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_scans_status_check CHECK ((status = ANY (ARRAY['scanned'::text, 'no_content'::text])))
);

--
-- Name: document_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    type text NOT NULL,
    name text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    secret_enc text,
    webhook_secret text,
    flavor text DEFAULT 'plain'::text NOT NULL,
    status text DEFAULT 'idle'::text NOT NULL,
    last_synced_at timestamp with time zone,
    last_error text,
    document_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sync_interval_minutes integer,
    next_sync_at timestamp with time zone,
    webhook_verification_expires_at timestamp with time zone,
    webhook_due_at timestamp with time zone,
    webhook_min_interval_minutes integer
);

--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    source_id uuid,
    relative_path text NOT NULL,
    title text NOT NULL,
    content_hash text NOT NULL,
    size_bytes integer DEFAULT 0 NOT NULL,
    chunk_count integer DEFAULT 0 NOT NULL,
    indexed_at timestamp with time zone DEFAULT now() NOT NULL,
    index_generation integer DEFAULT 0 NOT NULL,
    content text,
    content_truncated boolean DEFAULT false NOT NULL,
    version text DEFAULT ''::text NOT NULL,
    source_url text,
    source_modified_at timestamp with time zone
);

--
-- Name: eval_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eval_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    trigger text NOT NULL,
    status text NOT NULL,
    error text,
    generation integer NOT NULL,
    embedding_model text NOT NULL,
    question_count integer NOT NULL,
    scored_count integer NOT NULL,
    recall5 double precision,
    mrr double precision,
    regressed boolean DEFAULT false NOT NULL,
    compared_to uuid,
    lost_keys text[] DEFAULT '{}'::text[] NOT NULL,
    skipped_keys text[] DEFAULT '{}'::text[] NOT NULL,
    newly_skipped_keys text[] DEFAULT '{}'::text[] NOT NULL,
    results jsonb,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    CONSTRAINT eval_runs_figures_check CHECK ((((status = 'ok'::text) AND (recall5 IS NOT NULL) AND (mrr IS NOT NULL)) OR ((status = 'error'::text) AND (error IS NOT NULL)))),
    CONSTRAINT eval_runs_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'error'::text]))),
    CONSTRAINT eval_runs_trigger_check CHECK ((trigger = ANY (ARRAY['index_rebuild'::text, 'index_incremental'::text, 'golden_set'::text, 'manual'::text])))
);

--
-- Name: floor_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.floor_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    trigger text NOT NULL,
    embedding_model text NOT NULL,
    live_generation integer NOT NULL,
    suggested_floor double precision NOT NULL,
    previous_floor double precision,
    basis jsonb NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT floor_suggestions_floor_check CHECK (((suggested_floor > (0)::double precision) AND (suggested_floor <= (1)::double precision))),
    CONSTRAINT floor_suggestions_trigger_check CHECK ((trigger = ANY (ARRAY['model_change'::text, 'operator'::text])))
);

--
-- Name: golden_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.golden_questions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    key text NOT NULL,
    lang text NOT NULL,
    query text NOT NULL,
    expect_file text NOT NULL,
    expect_heading text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT golden_questions_lang_check CHECK ((lang = ANY (ARRAY['en'::text, 'tr'::text])))
);

--
-- Name: index_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.index_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    mode text NOT NULL,
    status text NOT NULL,
    files_total integer DEFAULT 0 NOT NULL,
    files_skipped integer DEFAULT 0 NOT NULL,
    files_updated integer DEFAULT 0 NOT NULL,
    files_removed integer DEFAULT 0 NOT NULL,
    chunks_written integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    duration_ms integer DEFAULT 0 NOT NULL,
    error text,
    generation integer,
    trigger text,
    CONSTRAINT index_runs_trigger_check CHECK ((trigger = ANY (ARRAY['manual'::text, 'webhook'::text, 'scheduled'::text])))
);

--
-- Name: mcp_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_rate_limits (
    key text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    count integer NOT NULL
);

--
-- Name: mcp_token_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_token_sources (
    token_id uuid NOT NULL,
    source_id uuid NOT NULL
);

--
-- Name: mcp_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    token_hash text NOT NULL,
    prefix text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    kind text DEFAULT 'static'::text NOT NULL,
    user_id uuid,
    client_id text,
    expires_at timestamp with time zone,
    allowed_cidrs cidr[],
    source_scoped boolean DEFAULT false NOT NULL,
    CONSTRAINT mcp_tokens_kind_check CHECK ((kind = ANY (ARRAY['static'::text, 'access'::text, 'refresh'::text]))),
    CONSTRAINT mcp_tokens_source_scope_static_check CHECK (((NOT source_scoped) OR (kind = 'static'::text)))
);

--
-- Name: oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_clients (
    client_id text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    redirect_uris jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);

--
-- Name: oidc_group_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oidc_group_mappings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_name text NOT NULL,
    project_id uuid NOT NULL,
    role text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oidc_group_mappings_group_name_check CHECK (((char_length(group_name) >= 1) AND (char_length(group_name) <= 256))),
    CONSTRAINT oidc_group_mappings_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text])))
);

--
-- Name: project_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_members (
    user_id uuid NOT NULL,
    project_id uuid NOT NULL,
    role text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT 'manual'::text NOT NULL,
    oidc_groups text[],
    CONSTRAINT project_members_origin_check CHECK ((((origin = 'manual'::text) AND (oidc_groups IS NULL)) OR ((origin = 'oidc_group'::text) AND (cardinality(oidc_groups) > 0)))),
    CONSTRAINT project_members_role_check CHECK ((role = ANY (ARRAY['viewer'::text, 'editor'::text])))
);

--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    root_path text,
    status public.project_status DEFAULT 'idle'::public.project_status NOT NULL,
    chunk_count integer DEFAULT 0 NOT NULL,
    document_count integer DEFAULT 0 NOT NULL,
    last_indexed_at timestamp with time zone,
    last_error text,
    embedding_model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mcp_auth text DEFAULT 'token'::text NOT NULL,
    live_generation integer DEFAULT 0 NOT NULL,
    query_log_enabled boolean DEFAULT true NOT NULL,
    score_floor double precision,
    last_legacy_sse_at timestamp with time zone,
    max_documents integer,
    max_chunks integer,
    max_upload_bytes bigint,
    CONSTRAINT projects_max_chunks_check CHECK (((max_chunks IS NULL) OR (max_chunks >= 0))),
    CONSTRAINT projects_max_documents_check CHECK (((max_documents IS NULL) OR (max_documents >= 0))),
    CONSTRAINT projects_max_upload_bytes_check CHECK (((max_upload_bytes IS NULL) OR (max_upload_bytes >= 0))),
    CONSTRAINT projects_mcp_auth_check CHECK ((mcp_auth = ANY (ARRAY['open'::text, 'token'::text, 'account'::text]))),
    CONSTRAINT projects_score_floor_check CHECK (((score_floor IS NULL) OR ((score_floor >= (0)::double precision) AND (score_floor <= (1)::double precision))))
);

--
-- Name: reported_gaps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reported_gaps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mcp_token_id uuid,
    rate_key text NOT NULL,
    query text NOT NULL,
    query_norm text NOT NULL,
    note text,
    live_generation integer NOT NULL
);

--
-- Name: search_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_queries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    actor text NOT NULL,
    mcp_token_id uuid,
    query text NOT NULL,
    query_norm text NOT NULL,
    result_limit integer NOT NULL,
    filter_source text,
    filter_path_prefix text,
    hit_count integer DEFAULT 0 NOT NULL,
    top_score double precision,
    below_floor boolean DEFAULT false NOT NULL,
    duration_ms integer DEFAULT 0 NOT NULL,
    embedding_model text NOT NULL,
    live_generation integer DEFAULT 0 NOT NULL,
    filter_version text,
    score_floor double precision,
    CONSTRAINT search_queries_actor_check CHECK ((actor = ANY (ARRAY['mcp'::text, 'dashboard'::text])))
);

--
-- Name: search_query_hits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_query_hits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    query_id uuid NOT NULL,
    rank integer NOT NULL,
    relative_path text NOT NULL,
    heading_path text DEFAULT ''::text NOT NULL,
    chunk_index integer NOT NULL,
    score double precision NOT NULL
);

--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: user_federated_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_federated_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone
);

--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    user_agent text DEFAULT ''::text NOT NULL,
    ip text,
    auth_method text DEFAULT 'password'::text NOT NULL,
    CONSTRAINT user_sessions_auth_method_check CHECK ((auth_method = ANY (ARRAY['password'::text, 'sso'::text])))
);

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username text NOT NULL,
    email text,
    display_name text DEFAULT ''::text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    password_hash text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    failed_login_count integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    last_login_at timestamp with time zone,
    password_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mcp_credentials_epoch integer DEFAULT 0 NOT NULL,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['root'::text, 'admin'::text, 'member'::text])))
);

--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);

--
-- Data for Name: __drizzle_migrations; Type: TABLE DATA; Schema: drizzle; Owner: -
--

INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES
	(1, '30e807ea7dbe92372a727547df2dfb93ef881955196beba51595b4a31480f0d7', 1789733542507),
	(2, 'f634892fc68782b1d64c2767d49c6d1539fe075ed32754cead9f3f6b7dcb2e08', 1789749934303),
	(3, '9cec569a2e32d77bcd970bec9e3af53b6d79c5902e1a50990f131714bf983147', 1789751902331),
	(4, '58decc8cac3d0348a6125cd0cad3caa05f5fee369f7f70dfef2d9a734f15ce07', 1789757530345),
	(5, '612ac6babb0351c3b5155733764dcd2a771adcd5be580c6b2b8544813cb90d59', 1789758758724),
	(6, '44cacf07a5e6f4dd1fec43f67c99e5c76ab3ff93e5028305bb08e41671bf7f02', 1789766908971),
	(7, '71e184ebd4437d4d7f68a3576f452b30bd7e9ca203b3849d452eaeb221ff3c7e', 1789787912940),
	(8, 'cea40bd681b6ea4296f23c0844791a5184472f788600d689c2254bf063e9ecd9', 1789789693549),
	(9, 'db9b484e5949a49f4749fd54c92c6a1a9da9ef908af51e0fc2c830c75094535a', 1789796255412),
	(10, '2fc2fa0a3524428ef91072716fd98915ccef639004a8b22b39ae267984799719', 1789806490645),
	(11, 'c3a6aa6f1d4de881da6af774c09ddde9a51942660480e0210aa113e322470fa2', 1789807870966),
	(12, '307a552ae88665e45fa4bb11a270e4adaf54e4ed7b93d07113e07a1af3be1559', 1789810889638),
	(13, '3cc78291355f7a52418375909ff286d334128475ebfd93b723fd28175c61a035', 1789994536185),
	(14, '41bbd614feaada866a8980c909e6c9f890d951cc1edfcd0bf344a62264e0d7d7', 1789994775642),
	(15, '08888728bfed2eb58c582fd3a39bab56ee374a09b41c77c91ef30f5480cc7488', 1790150246987),
	(16, '01e502b0b2974ff4d53e2a197100cf4b3b8f866de0d95e7f7c7e5c58cfd7557d', 1790160616082),
	(17, 'a9296d71f4b5d80695666856cfd4eea9a92034a886cf9146b983a9610f3cf842', 1790175403707),
	(18, 'e6a25b9a38fb8cfcd3479e040c5d09efa096001917456abd7755beabe67641e7', 1790292860241),
	(19, 'f51c5c3f2d7e555b44877c3502358369bfd16483f490a6a4d213c5a19b004ce2', 1790333114810),
	(20, 'b4fc116809a60bbd1fa154228c8a7ccfa31cced9f9f783f7b2b87d7cb90a99ef', 1790933181551),
	(21, '663a80f7ac79777db2a9c319b2106444b77f5a820c23256639d7c73b361ee92c', 1791620908053),
	(22, '4b71d0b496412f9a07060232154b2ee47d1dd93eabe4aa42962540d11266e822', 1792654237198),
	(23, '8b80e7a8324e577954c6b5d28b1c7ac95a3739fc3b4969ae63213051fcb916ce', 1792731733295),
	(24, 'a3e0a30f77f456a61fc9720d89ac9766578cb8d214496a7545ca41decbc649e0', 1792841495440),
	(25, '8a17fed57520ee618157ecc35bc54428d2d5c53fb462c31147f3afb9884155e5', 1792841496440),
	(26, '1354ec1dbe25fbd1f90c9b1fea98bdf0f3febc81f76b20056acd83b28b8d2574', 1792845113101),
	(27, '215c3c76d8b3f8cb2caf9f4c7c4d49d365e091ae76176f856eb546fda8daa53c', 1792957511911),
	(28, '1b524c9cbbe0f8b5ef707bb9f2e0f3fd139ff6e3139d3f9d375c2c889420d1ee', 1792989267924),
	(29, '79bb08fb2ffc940fe287278d092887d51b68c75b0f93e4975f40c4c8540a820f', 1792991392378),
	(30, 'bfda5f3a6253808e82c3a598830b2ad1c280fc3aca296a44d89084cfe35e38f6', 1793199093258),
	(31, '5a47987066bcc80341f55cecb3e9b5c2d22274e4cc6e686092759b227e222d46', 1793209203864),
	(32, '227acf1b1cbf34eb7d0c9c330efe14b6e8c6bfd7fb72527bad9ec20bd51b0bb7', 1793213815155);

--
-- Data for Name: api_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: audit_events; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: chunks; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.chunks (id, project_id, document_id, chunk_index, heading_path, content, token_count, embedding, index_generation, content_tsv, text_search_config) VALUES
	('d32bf8cd-ee59-4eab-a2e1-1b0e63d7450d', '487c1aae-7af6-4d50-b062-3884b13c98e0', '00000000-0000-4000-8000-000000000003', 0, 'Index', 'chunk 0', 3, '[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]', 0, '''0'':3 ''chunk'':2 ''index'':1', 'simple'),
	('755d94db-3616-4970-bb96-580172331ff7', '487c1aae-7af6-4d50-b062-3884b13c98e0', '00000000-0000-4000-8000-000000000003', 1, 'Index', 'chunk 1', 3, '[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1]', 0, '''1'':3 ''chunk'':2 ''index'':1', 'simple');

--
-- Data for Name: document_changes; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: document_findings; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: document_scans; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: document_sources; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.document_sources (id, project_id, type, name, label, config, secret_enc, webhook_secret, flavor, status, last_synced_at, last_error, document_count, created_at, sync_interval_minutes, next_sync_at, webhook_verification_expires_at, webhook_due_at, webhook_min_interval_minutes) VALUES
	('00000000-0000-4000-8000-000000000002', '487c1aae-7af6-4d50-b062-3884b13c98e0', 'upload', 'docs', 'Uploaded files', '{}', NULL, NULL, 'plain', 'idle', NULL, NULL, 1, '2026-11-04 10:34:21.702181+00', NULL, NULL, NULL, NULL, NULL);

--
-- Data for Name: documents; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.documents (id, project_id, source_id, relative_path, title, content_hash, size_bytes, chunk_count, indexed_at, index_generation, content, content_truncated, version, source_url, source_modified_at) VALUES
	('00000000-0000-4000-8000-000000000003', '487c1aae-7af6-4d50-b062-3884b13c98e0', '00000000-0000-4000-8000-000000000002', 'docs/index.md', 'Index', 'hash-index', 24, 2, '2026-11-04 10:34:21.70267+00', 0, '# Index

Welcome.
', false, '', NULL, NULL);

--
-- Data for Name: eval_runs; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: floor_suggestions; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: golden_questions; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: index_runs; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: mcp_rate_limits; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: mcp_token_sources; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: mcp_tokens; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: oauth_clients; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: oidc_group_mappings; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: project_members; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: projects; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.projects (id, name, root_path, status, chunk_count, document_count, last_indexed_at, last_error, embedding_model, created_at, mcp_auth, live_generation, query_log_enabled, score_floor, last_legacy_sse_at, max_documents, max_chunks, max_upload_bytes) VALUES
	('487c1aae-7af6-4d50-b062-3884b13c98e0', 'handbook', NULL, 'idle', 2, 1, NULL, NULL, NULL, '2026-11-04 10:34:21.69963+00', 'token', 0, true, NULL, NULL, NULL, NULL, NULL);

--
-- Data for Name: reported_gaps; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: search_queries; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: search_query_hits; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: settings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.settings (key, value, updated_at) VALUES
	('embedding_dimensions', '384', '2026-11-04 10:34:21.693789+00'),
	('schema_version', '5', '2026-11-04 10:34:21.693789+00'),
	('document_changes_tracking_since', '2026-11-04T10:34:21.697Z', '2026-11-04 10:34:21.697575+00');

--
-- Data for Name: user_federated_identities; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: user_sessions; Type: TABLE DATA; Schema: public; Owner: -
--

--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.users (id, username, email, display_name, role, password_hash, is_active, must_change_password, failed_login_count, locked_until, last_login_at, password_changed_at, created_by, created_at, mcp_credentials_epoch) VALUES
	('00000000-0000-4000-8000-000000000001', 'root', NULL, 'Root', 'root', 'fixture-not-a-real-password-hash', true, false, 0, NULL, NULL, '2026-11-04 10:34:21.701788+00', NULL, '2026-11-04 10:34:21.701788+00', 0);

--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE SET; Schema: drizzle; Owner: -
--

SELECT pg_catalog.setval('drizzle.__drizzle_migrations_id_seq', 32, true);

--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);

--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);

--
-- Name: api_tokens api_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash);

--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

--
-- Name: chunks chunks_document_chunk_index_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_document_chunk_index_uq UNIQUE (document_id, chunk_index);

--
-- Name: chunks chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_pkey PRIMARY KEY (id);

--
-- Name: document_changes document_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_changes
    ADD CONSTRAINT document_changes_pkey PRIMARY KEY (project_id, relative_path);

--
-- Name: document_findings document_findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_findings
    ADD CONSTRAINT document_findings_pkey PRIMARY KEY (id);

--
-- Name: document_scans document_scans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_scans
    ADD CONSTRAINT document_scans_pkey PRIMARY KEY (document_id);

--
-- Name: document_sources document_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sources
    ADD CONSTRAINT document_sources_pkey PRIMARY KEY (id);

--
-- Name: document_sources document_sources_project_name_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sources
    ADD CONSTRAINT document_sources_project_name_uq UNIQUE (project_id, name);

--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

--
-- Name: documents documents_project_generation_path_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_project_generation_path_uq UNIQUE (project_id, index_generation, relative_path);

--
-- Name: eval_runs eval_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_pkey PRIMARY KEY (id);

--
-- Name: floor_suggestions floor_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.floor_suggestions
    ADD CONSTRAINT floor_suggestions_pkey PRIMARY KEY (id);

--
-- Name: golden_questions golden_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_questions
    ADD CONSTRAINT golden_questions_pkey PRIMARY KEY (id);

--
-- Name: golden_questions golden_questions_project_key_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_questions
    ADD CONSTRAINT golden_questions_project_key_uq UNIQUE (project_id, key);

--
-- Name: index_runs index_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.index_runs
    ADD CONSTRAINT index_runs_pkey PRIMARY KEY (id);

--
-- Name: mcp_rate_limits mcp_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_rate_limits
    ADD CONSTRAINT mcp_rate_limits_pkey PRIMARY KEY (key);

--
-- Name: mcp_token_sources mcp_token_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_token_sources
    ADD CONSTRAINT mcp_token_sources_pkey PRIMARY KEY (token_id, source_id);

--
-- Name: mcp_tokens mcp_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_pkey PRIMARY KEY (id);

--
-- Name: mcp_tokens mcp_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_token_hash_key UNIQUE (token_hash);

--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (client_id);

--
-- Name: oidc_group_mappings oidc_group_mappings_group_project_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_group_mappings
    ADD CONSTRAINT oidc_group_mappings_group_project_key UNIQUE (group_name, project_id);

--
-- Name: oidc_group_mappings oidc_group_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_group_mappings
    ADD CONSTRAINT oidc_group_mappings_pkey PRIMARY KEY (id);

--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (user_id, project_id);

--
-- Name: projects projects_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_name_key UNIQUE (name);

--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

--
-- Name: reported_gaps reported_gaps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reported_gaps
    ADD CONSTRAINT reported_gaps_pkey PRIMARY KEY (id);

--
-- Name: search_queries search_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_queries
    ADD CONSTRAINT search_queries_pkey PRIMARY KEY (id);

--
-- Name: search_query_hits search_query_hits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_query_hits
    ADD CONSTRAINT search_query_hits_pkey PRIMARY KEY (id);

--
-- Name: search_query_hits search_query_hits_query_rank_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_query_hits
    ADD CONSTRAINT search_query_hits_query_rank_uq UNIQUE (query_id, rank);

--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);

--
-- Name: user_federated_identities user_federated_identities_issuer_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federated_identities
    ADD CONSTRAINT user_federated_identities_issuer_subject_key UNIQUE (issuer, subject);

--
-- Name: user_federated_identities user_federated_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federated_identities
    ADD CONSTRAINT user_federated_identities_pkey PRIMARY KEY (id);

--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);

--
-- Name: user_sessions user_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_token_hash_key UNIQUE (token_hash);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);

--
-- Name: api_tokens_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_tokens_expires_idx ON public.api_tokens USING btree (expires_at) WHERE (expires_at IS NOT NULL);

--
-- Name: api_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_tokens_user_idx ON public.api_tokens USING btree (user_id);

--
-- Name: audit_events_action_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_action_created_idx ON public.audit_events USING btree (action, created_at DESC);

--
-- Name: audit_events_actor_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_actor_created_idx ON public.audit_events USING btree (actor_user_id, created_at DESC);

--
-- Name: audit_events_actor_label_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_actor_label_created_idx ON public.audit_events USING btree (actor_label, created_at DESC);

--
-- Name: audit_events_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_created_idx ON public.audit_events USING btree (created_at);

--
-- Name: audit_events_project_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_project_created_idx ON public.audit_events USING btree (project_id, created_at DESC);

--
-- Name: chunks_content_tsv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_content_tsv_idx ON public.chunks USING gin (content_tsv);

--
-- Name: chunks_document_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_document_idx ON public.chunks USING btree (document_id);

--
-- Name: chunks_embedding_hnsw_p_487c1aae7af64d50b0623884b13c98e0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_embedding_hnsw_p_487c1aae7af64d50b0623884b13c98e0 ON public.chunks USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (project_id = '487c1aae-7af6-4d50-b062-3884b13c98e0'::uuid);

--
-- Name: chunks_project_generation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_project_generation_idx ON public.chunks USING btree (project_id, index_generation, text_search_config);

--
-- Name: chunks_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunks_project_idx ON public.chunks USING btree (project_id);

--
-- Name: document_changes_changed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_changes_changed_at_idx ON public.document_changes USING btree (changed_at);

--
-- Name: document_changes_project_changed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_changes_project_changed_idx ON public.document_changes USING btree (project_id, changed_at DESC);

--
-- Name: document_findings_document_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_findings_document_idx ON public.document_findings USING btree (document_id);

--
-- Name: document_findings_project_hmac_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_findings_project_hmac_idx ON public.document_findings USING btree (project_id, value_hmac) WHERE (value_hmac IS NOT NULL);

--
-- Name: document_findings_project_rule_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_findings_project_rule_idx ON public.document_findings USING btree (project_id, rule);

--
-- Name: document_scans_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_scans_project_idx ON public.document_scans USING btree (project_id);

--
-- Name: document_sources_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_sources_due_idx ON public.document_sources USING btree (next_sync_at NULLS FIRST) WHERE (sync_interval_minutes IS NOT NULL);

--
-- Name: document_sources_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_sources_project_idx ON public.document_sources USING btree (project_id);

--
-- Name: document_sources_webhook_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_sources_webhook_due_idx ON public.document_sources USING btree (webhook_due_at) WHERE (webhook_due_at IS NOT NULL);

--
-- Name: documents_project_generation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_project_generation_idx ON public.documents USING btree (project_id, index_generation);

--
-- Name: documents_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_project_idx ON public.documents USING btree (project_id);

--
-- Name: documents_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_source_idx ON public.documents USING btree (source_id);

--
-- Name: eval_runs_project_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eval_runs_project_started_idx ON public.eval_runs USING btree (project_id, started_at DESC);

--
-- Name: floor_suggestions_project_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX floor_suggestions_project_created_idx ON public.floor_suggestions USING btree (project_id, created_at DESC);

--
-- Name: index_runs_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_runs_project_idx ON public.index_runs USING btree (project_id, started_at DESC);

--
-- Name: mcp_rate_limits_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_rate_limits_window_idx ON public.mcp_rate_limits USING btree (window_start);

--
-- Name: mcp_token_sources_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_token_sources_source_idx ON public.mcp_token_sources USING btree (source_id);

--
-- Name: mcp_tokens_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tokens_expires_idx ON public.mcp_tokens USING btree (expires_at) WHERE (expires_at IS NOT NULL);

--
-- Name: mcp_tokens_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tokens_project_idx ON public.mcp_tokens USING btree (project_id);

--
-- Name: mcp_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tokens_user_idx ON public.mcp_tokens USING btree (user_id);

--
-- Name: oauth_clients_last_used_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_clients_last_used_idx ON public.oauth_clients USING btree (last_used_at);

--
-- Name: oidc_group_mappings_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oidc_group_mappings_project_idx ON public.oidc_group_mappings USING btree (project_id);

--
-- Name: project_members_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_members_project_idx ON public.project_members USING btree (project_id);

--
-- Name: reported_gaps_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reported_gaps_created_idx ON public.reported_gaps USING btree (created_at);

--
-- Name: reported_gaps_project_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reported_gaps_project_created_idx ON public.reported_gaps USING btree (project_id, created_at DESC);

--
-- Name: reported_gaps_project_key_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reported_gaps_project_key_created_idx ON public.reported_gaps USING btree (project_id, rate_key, created_at DESC);

--
-- Name: search_queries_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_queries_created_idx ON public.search_queries USING btree (created_at);

--
-- Name: search_queries_project_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_queries_project_created_idx ON public.search_queries USING btree (project_id, created_at DESC);

--
-- Name: search_queries_project_norm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_queries_project_norm_idx ON public.search_queries USING btree (project_id, query_norm);

--
-- Name: search_query_hits_path_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_query_hits_path_idx ON public.search_query_hits USING btree (relative_path);

--
-- Name: user_federated_identities_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_federated_identities_user_idx ON public.user_federated_identities USING btree (user_id);

--
-- Name: user_sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_sessions_expires_idx ON public.user_sessions USING btree (expires_at);

--
-- Name: user_sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_sessions_user_idx ON public.user_sessions USING btree (user_id);

--
-- Name: api_tokens api_tokens_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: api_tokens api_tokens_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: api_tokens api_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: audit_events audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: chunks chunks_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: chunks chunks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunks
    ADD CONSTRAINT chunks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: document_changes document_changes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_changes
    ADD CONSTRAINT document_changes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: document_findings document_findings_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_findings
    ADD CONSTRAINT document_findings_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: document_findings document_findings_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_findings
    ADD CONSTRAINT document_findings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: document_scans document_scans_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_scans
    ADD CONSTRAINT document_scans_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;

--
-- Name: document_scans document_scans_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_scans
    ADD CONSTRAINT document_scans_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: document_sources document_sources_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_sources
    ADD CONSTRAINT document_sources_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: documents documents_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: documents documents_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.document_sources(id) ON DELETE CASCADE;

--
-- Name: eval_runs eval_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_runs
    ADD CONSTRAINT eval_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: floor_suggestions floor_suggestions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.floor_suggestions
    ADD CONSTRAINT floor_suggestions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: golden_questions golden_questions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.golden_questions
    ADD CONSTRAINT golden_questions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: index_runs index_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.index_runs
    ADD CONSTRAINT index_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: mcp_token_sources mcp_token_sources_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_token_sources
    ADD CONSTRAINT mcp_token_sources_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.document_sources(id) ON DELETE CASCADE;

--
-- Name: mcp_token_sources mcp_token_sources_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_token_sources
    ADD CONSTRAINT mcp_token_sources_token_id_fkey FOREIGN KEY (token_id) REFERENCES public.mcp_tokens(id) ON DELETE CASCADE;

--
-- Name: mcp_tokens mcp_tokens_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;

--
-- Name: mcp_tokens mcp_tokens_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: mcp_tokens mcp_tokens_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: mcp_tokens mcp_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: oidc_group_mappings oidc_group_mappings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_group_mappings
    ADD CONSTRAINT oidc_group_mappings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: oidc_group_mappings oidc_group_mappings_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oidc_group_mappings
    ADD CONSTRAINT oidc_group_mappings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: project_members project_members_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: project_members project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: project_members project_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: reported_gaps reported_gaps_mcp_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reported_gaps
    ADD CONSTRAINT reported_gaps_mcp_token_id_fkey FOREIGN KEY (mcp_token_id) REFERENCES public.mcp_tokens(id) ON DELETE SET NULL;

--
-- Name: reported_gaps reported_gaps_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reported_gaps
    ADD CONSTRAINT reported_gaps_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: search_queries search_queries_mcp_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_queries
    ADD CONSTRAINT search_queries_mcp_token_id_fkey FOREIGN KEY (mcp_token_id) REFERENCES public.mcp_tokens(id) ON DELETE SET NULL;

--
-- Name: search_queries search_queries_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_queries
    ADD CONSTRAINT search_queries_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;

--
-- Name: search_query_hits search_query_hits_query_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_query_hits
    ADD CONSTRAINT search_query_hits_query_id_fkey FOREIGN KEY (query_id) REFERENCES public.search_queries(id) ON DELETE CASCADE;

--
-- Name: user_federated_identities user_federated_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_federated_identities
    ADD CONSTRAINT user_federated_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: users users_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- PostgreSQL database dump complete
--
