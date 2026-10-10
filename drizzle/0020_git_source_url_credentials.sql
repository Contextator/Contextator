-- Strips credentials pasted into a git source's URL (`https://user:token@host/...`) out of the rows that
-- were stored before the URL was sanitised on write (ADR-0075: URL-embedded credentials are stripped
-- before storage; authentication reads `secret_enc` only). `config` is exposed by the admin API, so a
-- credential left here is a credential returned to every viewer.
--
-- Only the userinfo part of the authority is removed: after `scheme:` and any run of slashes or
-- backslashes (the WHATWG URL parser accepts `https:u:p@host`, `https:///u:p@host` and `https:\\u:p@host`
-- for a special scheme, and so does the `z.url()` that admitted the value), everything up to the last
-- `@` before the first `/`, `?`, `#` or `\`. The rest of the URL is kept byte for byte, which is why a
-- row this rewrites can differ in spelling from what the application's own sanitiser (`URL.toString()`,
-- which lower-cases the host and drops a default port) would have produced; both are credential-free and
-- address the same repository. Rows without userinfo do not match the WHERE clause and are not rewritten.
--
-- The authority rule above is the WHATWG one for a *special* scheme (http, https, ftp, ws, wss, file). For
-- an opaque scheme such as `ssh:` it differs: `ssh:git@host/x` has no authority there and is rewritten
-- anyway, and `ssh://u\p@host/x` has a credential this pattern does not match. Neither can matter: the
-- git driver speaks HTTP(S) only (`src/services/sources/git.ts`), so such a row never synced, and
-- `toSourceView` and `exportedSource` mask any URL with a WHATWG username or password regardless.
--
-- The patterns are `E'...'` strings so the backslash in the bracket expression means the same thing
-- whatever `standard_conforming_strings` is set to. `test/integration/git-url-credentials-migration.itest.ts`
-- runs this file against rows of every shape above, under both settings (the setting is applied on its own
-- round trip, ahead of the file, so that it is in force when the literals are lexed).
--
-- Down path: none that restores data. The removed credential is deliberately destroyed, and the source
-- keeps authenticating with `secret_enc`. Re-running the statement is a no-op.

UPDATE "document_sources"
SET "config" = jsonb_set(
  "config",
  '{url}',
  to_jsonb(regexp_replace("config" ->> 'url', E'^([A-Za-z][A-Za-z0-9+.-]*:[/\\\\]*)[^/?#\\\\]*@', E'\\1'))
)
WHERE "type" = 'git'
  AND jsonb_typeof("config" -> 'url') = 'string'
  AND "config" ->> 'url' ~ E'^[A-Za-z][A-Za-z0-9+.-]*:[/\\\\]*[^/?#\\\\]*@';
