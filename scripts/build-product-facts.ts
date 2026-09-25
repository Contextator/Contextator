/**
 * Builds `public/product-facts.json`: the numbers and identifiers this product can be asked about,
 * read out of the code that defines them.
 *
 * **Why it exists.** The marketing site lives in another repository and states those same numbers in
 * prose — how many source types there are, what the score floor is, which parameters a tool takes.
 * Nothing connected the two, so the site drifted: a claim was written once and then the product moved
 * underneath it. This file is the machine-readable half of that bond. The site reads it and fails its
 * own build when a claim and a fact disagree; `test/product-facts.test.ts` fails this repository's
 * build when the committed file and the code disagree. It is the pattern
 * `test/dockerhub-description.test.ts` already applies to `DOCKERHUB.md`, pushed past the repository
 * boundary.
 *
 * **Nothing here is written down twice.** Every field below is *read* from the declaration that
 * already governs it — the zod default, the `as const` tuple, the table's check constraint, the tool
 * registration itself. A field that had to be typed in by hand would be a second source of truth, and
 * a second source of truth is the thing this file exists to remove: it would start lying on the first
 * release that changed the real one, and nothing would notice. So a fact with no declaration to read
 * is not emitted as a fact — it is named in `notMachineReadable` with the reason, and the site is
 * expected to treat it as unchecked prose rather than a verified number.
 *
 * Regenerate with `npm run build:facts` and commit what it writes. The file is served from `public/`,
 * so a running instance answers `/product-facts.json` for its own release.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EnvSchema } from '../src/config.js';
import { type ProjectRow, projects } from '../src/db/schema.js';
import { registerTools, type ToolContext } from '../src/mcp/tools.js';
import { ARCHIVE_RE } from '../src/services/archives.js';
import { FLAVOR_ONLY_EXTENSIONS, FLAVORS } from '../src/services/flavors.js';
import { SUPPORTED_EXTENSIONS } from '../src/services/fs-scan.js';
import { SOURCE_TYPES } from '../src/services/sources.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCT_FACTS_PATH = path.join(ROOT, 'public', 'product-facts.json');

export interface ToolFact {
  name: string;
  title: string;
  parameters: Array<{ name: string; required: boolean }>;
}

export interface ProductFacts {
  generator: string;
  productVersion: string;
  sourceTypes: readonly string[];
  sourceFlavors: readonly string[];
  fileExtensions: {
    document: readonly string[];
    flavorOnly: readonly string[];
    archive: readonly string[];
  };
  mcpAuthModes: readonly string[];
  scoreFloorDefault: number;
  embeddingModel: string;
  embeddingDimensions: number;
  tools: ToolFact[];
  notMachineReadable: Record<string, string>;
}

/**
 * The default a zod field declares, obtained by parsing the absence of that field.
 *
 * Reading `.def.defaultValue` off the internals would work today and break on a zod upgrade; asking
 * the schema what it does with `{}` is the same question put through the public API, and it also
 * covers a default produced by a coercion rather than stated literally.
 */
function defaultOf<T>(key: keyof z.infer<typeof EnvSchema>): T {
  // `EnvSchema` is `z.object(...).superRefine(...)`, and that `.shape` survives the refinement is a
  // property of this zod version rather than a promise it makes — so it is checked rather than
  // assumed. A version that stops exposing it has to fail here, saying which symbol went missing,
  // and not one line later as a bare `TypeError` about indexing undefined.
  const shape = (EnvSchema as unknown as { shape?: Record<string, z.ZodType> }).shape;
  if (typeof shape !== 'object' || shape === null) {
    throw new Error('EnvSchema no longer exposes `.shape`: this generator cannot read the defaults out of src/config.ts');
  }
  const field = shape[key as string];
  if (!field) throw new Error(`src/config.ts declares no ${String(key)} — this generator is out of date`);
  return z.object({ value: field }).parse({}).value as T;
}

/**
 * The values `projects.mcp_auth` may hold, read off the table's own check constraint.
 *
 * The TypeScript `McpAuthMode` union cannot be read at runtime — it is erased — and the zod enums in
 * the routes are copies of it. The constraint is the one statement of the set that the database
 * itself enforces, so it is the one worth reporting.
 */
function mcpAuthModes(): string[] {
  const check = getTableConfig(projects).checks.find((c) => c.name === 'projects_mcp_auth_check');
  if (!check) throw new Error('projects_mcp_auth_check is gone from src/db/schema.ts — this generator is out of date');
  const { sql } = new PgDialect().sqlToQuery(check.value);
  const list = sql.match(/\bin\s*\(([^)]*)\)/i)?.[1];
  const modes = list?.match(/'([^']*)'/g)?.map((quoted) => quoted.slice(1, -1)) ?? [];
  if (modes.length === 0) throw new Error(`cannot read the allowed values out of: ${sql}`);
  return modes;
}

/**
 * The extensions `isArchiveName` accepts, read out of the alternation it tests with.
 *
 * The whole pattern is matched and not the first parenthesis in it: an added `(?:...)` would make
 * "the first group" mean something else, and the list would be read wrongly while still being
 * non-empty — a wrong fact published as a verified one, which is the failure this file exists to
 * prevent. Bound to the shape instead: a literal dot, one parenthesis holding nothing but
 * alternatives, an end anchor. Anything else is a pattern this function has no reading of, and it
 * says so rather than returning its best guess.
 */
function archiveExtensions(): string[] {
  const alternation = ARCHIVE_RE.source.match(/^\\\.\(([^()]+)\)\$$/)?.[1];
  if (!alternation) throw new Error(`ARCHIVE_RE is no longer a single alternation of extensions, so it cannot be read: ${ARCHIVE_RE.source}`);
  const extensions = alternation.split('|').map((e) => e.replace(/\\/g, ''));
  const unreadable = extensions.filter((e) => !/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(e));
  if (unreadable.length > 0) throw new Error(`ARCHIVE_RE holds something that is not a file extension: ${unreadable.join(', ')}`);
  return extensions;
}

/**
 * The tools as the MCP client sees them, collected by handing `registerTools` a server that records
 * instead of serving.
 *
 * Parsing `src/mcp/tools.ts` as text would report what the file looks like; this reports what the
 * registration actually produces, which is what a client is answered with. The context is empty but
 * for the one setting registration reads, `MCP_STRUCTURED_OUTPUT` (whether a tool declares an output
 * schema) — only the handlers touch the rest, and no handler is called here. Its default, so the facts
 * describe what an instance answers out of the box; name, title and parameters do not depend on it.
 */
function tools(): ToolFact[] {
  const collected: ToolFact[] = [];
  const recorder = {
    registerTool(name: string, config: { title?: string; inputSchema?: Record<string, z.ZodType> }) {
      collected.push({
        name,
        title: config.title ?? '',
        parameters: Object.entries(config.inputSchema ?? {}).map(([parameter, schema]) => ({
          name: parameter,
          // A parameter that is optional or carries a default accepts its own absence; one that does
          // not is a parameter the caller has to supply.
          required: !schema.safeParse(undefined).success,
        })),
      });
      return undefined;
    },
  } as unknown as McpServer;
  // `registerTools` reads `project.name` into each description and nothing else off the row.
  const config = { MCP_STRUCTURED_OUTPUT: defaultOf<boolean>('MCP_STRUCTURED_OUTPUT') } as ToolContext['config'];
  registerTools(recorder, { config } as ToolContext, { name: 'example' } as ProjectRow);
  return collected;
}

export function buildProductFacts(): ProductFacts {
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  return {
    generator: 'scripts/build-product-facts.ts',
    productVersion: packageJson.version,
    sourceTypes: SOURCE_TYPES,
    sourceFlavors: FLAVORS,
    fileExtensions: {
      document: SUPPORTED_EXTENSIONS,
      flavorOnly: FLAVOR_ONLY_EXTENSIONS,
      archive: archiveExtensions(),
    },
    mcpAuthModes: mcpAuthModes(),
    scoreFloorDefault: defaultOf<number>('SEARCH_SCORE_FLOOR'),
    embeddingModel: defaultOf<string>('EMBEDDING_MODEL'),
    embeddingDimensions: defaultOf<number>('EMBEDDING_DIMENSIONS'),
    tools: tools(),
    notMachineReadable: {
      // The number belongs to the upstream model card, not to this repository: nothing here counts
      // languages, and a count typed in by hand would be exactly the unbacked claim this file exists
      // to stop. Anything reading these facts must treat it as prose a human checked, not as a fact.
      languageCount:
        'No declaration in this repository states one. "100 languages" is a property of the EMBEDDING_MODEL default published by its authors; verify it against that model card, not against this file.',
    },
  };
}

/**
 * Writes the file, then hands it to Biome.
 *
 * The formatter owns the bytes here exactly as it owns every other file in the tree — `biome check .`
 * runs over `public/**` and would fail on `JSON.stringify` output, which expands every array that
 * Biome would keep on one line. Formatting it here rather than exempting the file keeps `npm run
 * build:facts` self-sufficient: what it writes is already what CI expects to find committed.
 */
function writeProductFacts(facts: ProductFacts): void {
  writeFileSync(PRODUCT_FACTS_PATH, `${JSON.stringify(facts, null, 2)}\n`);
  const biome = path.join(ROOT, 'node_modules', '.bin', 'biome');
  const formatted = spawnSync(biome, ['format', '--write', PRODUCT_FACTS_PATH], { stdio: 'inherit' });
  if (formatted.status !== 0) throw new Error(`biome could not format ${PRODUCT_FACTS_PATH}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeProductFacts(buildProductFacts());
  console.log(`wrote ${path.relative(ROOT, PRODUCT_FACTS_PATH)}`);
}
