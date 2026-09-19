/**
 * OpenAPI / Swagger: **one source file, one document per operation**
 * ([ADR-0057](../../.ssot/ADR.md#adr-0057)).
 *
 * This is the first type in the product that breaks "a file is a document". Every other reader —
 * `services/doc-types/` for a `.pdf`, `services/flavors.ts` for an Obsidian note — answers with the one
 * Markdown string that file becomes. A specification answers with `N` of them, one per `(method, path)`
 * pair, because that is the unit an agent asks about: nobody searches for "the API", they search for
 * "how do I delete a pet", and a single 4 000-line document that contains the answer three hundred
 * times over retrieves for every question and answers none of them.
 *
 * **It is a flavor and not a document type, and the difference is who decides.** A `.pdf` is a PDF
 * whatever anyone believes about it, so `doc-types` keys off the extension and the compiler checks the
 * table is total. A `.yaml` is not anything in particular — it is a CI config, a Helm chart, a
 * fixture — so no extension can imply this reader. The operator saying "this source holds API
 * specifications" is the only thing that can, and a flavor is exactly that statement. That is also why
 * `yaml`, `yml` and `json` are reachable **only** under this flavor (`allowedExtensionsFor`): a `plain`
 * source cannot be talked into parsing its lockfile as an API.
 *
 * Two guards bound the schema renderer, and they answer different questions. The **ref stack** catches
 * a genuine cycle — `Node.children: [Node]` — and names it, which is information the reader wants: the
 * schema really is recursive. The **depth limit** catches everything else, including a schema that is
 * merely enormous, and is what actually makes termination a property of the code rather than of the
 * input. Neither subsumes the other: without the stack a cycle would render `MAX_SCHEMA_DEPTH` levels
 * of noise before stopping, and without the limit an acyclic schema with a large branching factor
 * would expand until the process died.
 */

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { bytesLabel, DocumentExtractionError } from './doc-types/index.js';
import { normalizeRelativePath } from './fs-scan.js';

/** One of the documents a single source file expands into. */
export interface DerivedDocument {
  /** The full stored path, already through `normalizeRelativePath`. */
  relativePath: string;
  /** The Markdown that is both chunked and stored ([ADR-0043](../../.ssot/ADR.md#adr-0043)). */
  markdown: string;
  /** Bytes of that Markdown — the derived document's own size, not the specification's. */
  sizeBytes: number;
}

/** The HTTP methods a path item may carry, in the order they are rendered when a path has several. */
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * How deep a schema tree is expanded before the renderer says so and stops.
 *
 * Eight is chosen against what is readable rather than against what is possible: a chunk is
 * `CHUNK_MAX_TOKENS` wide, and a bullet indented eight times is already past the point where the
 * indentation carries meaning to either a reader or an embedder.
 */
export const MAX_SCHEMA_DEPTH = 8;

/** Lines one schema may render to. A wide-but-shallow schema is bounded by this and not by the depth. */
const MAX_SCHEMA_LINES = 400;

/**
 * Lines one rendered document may contain, across everything in it.
 *
 * **`MAX_SCHEMA_LINES` alone is not a bound on a document, and that gap was a way to kill the
 * process.** It is per schema, and the number of schemas a document renders is the number of responses
 * times the number of media types on each — neither of which the file size bounds usefully. A single
 * operation with `'2001': {$ref: …}` repeated at forty-eight bytes a line, pointing at a schema of four
 * hundred properties, fits about a hundred and seventy-five thousand responses under an 8 MiB file and
 * renders gigabytes of Markdown out of it, in an array, before anything is joined or stored. The file
 * ceiling bounds the **parse**; this bounds the **render**, and the product's promise that nothing a
 * specification contains can fail a run needs both.
 *
 * Two thousand lines is far more than any real endpoint needs — the Petstore's largest is under a
 * hundred — and about 160 KB of Markdown, comfortably inside `MAX_STORED_DOCUMENT_BYTES`. Past it the
 * document says it was cut, because a document that is silently a third of an endpoint is worse than
 * one that is honest about being a third of an endpoint.
 */
export const MAX_DOCUMENT_LINES = 2000;

/**
 * Operations one specification may declare before it is refused whole.
 *
 * **Refused and not truncated, which is the opposite of the line budget above, and deliberately.**
 * Cutting a schema loses detail about an endpoint that is still in the index and still says so.
 * Cutting the *operation list* would silently drop endpoints altogether — an agent asking about one of
 * them gets "not in the documentation", which is a wrong answer rather than a partial one. The largest
 * specifications anyone publishes are around a thousand operations (Kubernetes ~1 000, GitHub ~900,
 * Stripe ~500), so five thousand is five times the real ceiling and is only reached by a file written
 * to be indexed.
 */
export const MAX_OPERATIONS = 5000;

/** Characters of the derived path's last segment. Past this it is cut and always disambiguated. */
const MAX_SEGMENT_CHARS = 120;

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `1.0.6`, `2`, `true` — a version is a string in the schema and a number in half the specifications. */
function asScalar(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Whether this flavor should even look at the file.
 *
 * A specification source is still a documentation source: a repository of API specs almost always has
 * a `README.md` next to them, and that file is an ordinary Markdown document. So the flavor expands
 * only the structured extensions and leaves everything else on the one-file-one-document path.
 */
export function isSpecificationFile(relativePath: string): boolean {
  return /\.(ya?ml|json)$/i.test(relativePath);
}

/** `#/components/schemas/Pet` → the node it points at, or `undefined`. Local pointers only. */
function resolvePointer(root: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    // `decodeURIComponent` throws `URIError` on a lone `%` — and `#/components/schemas/100%` is a
    // schema name somebody has written. A pointer that will not decode is a pointer that resolves to
    // nothing, which is a note in the document; it is not a reason to fail the run.
    let key: string;
    try {
      key = decodeURIComponent(raw.replace(/~1/g, '/').replace(/~0/g, '~'));
    } catch {
      return undefined;
    }
    const record = asRecord(node);
    // `Object.hasOwn` and not `in`: `in` walks the prototype chain, so `#/definitions/__proto__`
    // resolves to `Object.prototype`, which `asRecord` then accepts as a perfectly good empty schema.
    // Nothing is written through it, so it is not prototype pollution — it is a reference that reads as
    // resolved and renders as nothing, instead of saying it could not be found.
    if (!record || !Object.hasOwn(record, key)) return undefined;
    node = record[key];
  }
  return node;
}

/** The trailing name of a pointer — `Pet` for `#/components/schemas/Pet` — for the reader's benefit. */
function refName(ref: string): string {
  const last = ref.split('/').pop() ?? ref;
  return last || ref;
}

interface SchemaCtx {
  root: Json;
  lines: string[];
  /** Pointers currently being expanded, innermost last. Membership is the cycle test. */
  stack: string[];
  truncated: boolean;
  /** Lines this one schema may render to: `MAX_SCHEMA_LINES`, or what the document has left. */
  max: number;
}

function push(ctx: SchemaCtx, line: string): boolean {
  if (ctx.lines.length >= ctx.max) {
    if (!ctx.truncated) {
      ctx.truncated = true;
      ctx.lines.push(`_(schema truncated at ${ctx.max} lines)_`);
    }
    return false;
  }
  ctx.lines.push(line);
  return true;
}

/**
 * `string`, `integer (int64)`, `array of Pet`, `Pet` — the one-phrase description of a schema node.
 *
 * `left` bounds the walk into `items`. A `$ref` cycle cannot reach here (this function never follows
 * one), but a YAML **anchor** cycle — `Wide: &w {items: *w}` — is an object graph that really does
 * point at itself, and nothing above would stop it.
 */
function typeLabel(schema: Json, left = MAX_SCHEMA_DEPTH): string {
  const ref = asText(schema.$ref);
  if (ref) return `\`${refName(ref)}\``;
  const type = Array.isArray(schema.type) ? schema.type.map(asScalar).filter(Boolean).join(' | ') : asScalar(schema.type);
  const format = asScalar(schema.format);
  if (type === 'array') {
    const items = asRecord(schema.items);
    return items && left > 0 ? `array of ${typeLabel(items, left - 1)}` : 'array';
  }
  const base = type || (schema.properties ? 'object' : schema.enum ? 'enum' : '');
  return format ? `${base || 'string'} (${format})` : base;
}

/**
 * Whether there is anything *under* this node worth indenting for.
 *
 * Without this test every scalar field rendered twice — once as the property line that names it, and
 * again as the anonymous leaf one level in — which is noise in a chunk whose budget is a hundred tokens.
 * Bounded for the same reason `typeLabel` is.
 */
function isStructured(schema: Json, left = MAX_SCHEMA_DEPTH): boolean {
  if (asText(schema.$ref)) return true;
  if (schema.properties !== undefined || schema.allOf !== undefined || schema.oneOf !== undefined || schema.anyOf !== undefined) return true;
  const items = asRecord(schema.items);
  return items !== undefined && left > 0 && isStructured(items, left - 1);
}

/** `one of `a`, `b`` when the node is an enumeration, and nothing otherwise. */
function enumNote(schema: Json): string {
  const values = asArray(schema.enum).map(asScalar).filter(Boolean);
  return values.length ? `one of ${values.map((v) => `\`${v}\``).join(', ')}` : '';
}

/**
 * `allOf` is composition, so it is merged rather than listed: the reader wants the fields of the thing,
 * not the three fragments the author assembled it from. `oneOf`/`anyOf` are genuine alternatives and
 * are listed as such.
 */
function mergeAllOf(schema: Json, ctx: SchemaCtx): Json {
  const parts = asArray(schema.allOf);
  if (parts.length === 0) return schema;
  const merged: Json = { ...schema };
  delete merged.allOf;
  const properties: Json = { ...(asRecord(schema.properties) ?? {}) };
  const required = new Set(asArray(schema.required).map(asScalar).filter(Boolean));
  for (const part of parts) {
    const target = resolved(deref(part, ctx));
    if (!target) continue;
    Object.assign(properties, asRecord(target.properties) ?? {});
    for (const name of asArray(target.required).map(asScalar)) if (name) required.add(name);
    if (!merged.type && target.type) merged.type = target.type;
    if (!merged.description && target.description) merged.description = target.description;
  }
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

/**
 * What following a `$ref` chain ended in.
 *
 * **It says *why* it failed, and that is not decoration.** The stack cannot be consulted afterwards:
 * a chain `A → B → A` unwinds everything it pushed on its way out, so by the time a caller asked
 * `stack.includes(ref)` about the *outer* ref the answer was no, and a mutual recursion was reported
 * as a dangling pointer. Which of the two it is is knowable only here, so it is returned from here.
 */
type Resolution = { readonly node: Json } | { readonly failed: 'cycle' | 'missing' | 'external' };

function resolved(r: Resolution): Json | undefined {
  return 'node' in r ? r.node : undefined;
}

/** Follows `$ref` until something concrete is reached, leaving `ctx.stack` exactly as it found it. */
function deref(node: unknown, ctx: SchemaCtx): Resolution {
  let current = asRecord(node);
  const opened: string[] = [];
  try {
    while (current) {
      const ref = asText(current.$ref);
      if (!ref) break;
      if (ctx.stack.includes(ref) || opened.includes(ref)) return { failed: 'cycle' };
      if (!ref.startsWith('#/')) return { failed: 'external' };
      const target = asRecord(resolvePointer(ctx.root, ref));
      if (!target) return { failed: 'missing' };
      ctx.stack.push(ref);
      opened.push(ref);
      current = target;
    }
  } finally {
    for (const _ of opened) ctx.stack.pop();
  }
  return current ? { node: current } : { failed: 'missing' };
}

/** The note a `$ref` that cannot be expanded renders as, so the document never silently omits a field. */
function unexpandable(ref: string, failed: 'cycle' | 'missing' | 'external'): string {
  if (failed === 'external') return `\`${ref}\` (reference to another file; not resolved)`;
  if (failed === 'cycle') return `\`${refName(ref)}\` (circular reference)`;
  return `\`${ref}\` (unresolved reference)`;
}

/**
 * One schema as an indented bullet list.
 *
 * A bullet list and not the raw JSON: what is stored is what `read_document` serves and what the
 * embedder sees ([ADR-0043](../../.ssot/ADR.md#adr-0043)), and a wall of braces is worse than prose at
 * both jobs. Every field's name, type and description end up on one line, which is also the line a
 * chunk can carry whole.
 */
function renderSchema(node: unknown, ctx: SchemaCtx, depth: number, indent: string): void {
  const raw = asRecord(node);
  if (!raw) return;

  const ref = asText(raw.$ref);
  if (ref) {
    const resolution = deref(raw, ctx);
    if ('failed' in resolution) {
      push(ctx, `${indent}- ${unexpandable(ref, resolution.failed)}`);
      return;
    }
    const target = resolution.node;
    if (depth >= MAX_SCHEMA_DEPTH) {
      push(ctx, `${indent}- \`${refName(ref)}\` _(nesting stopped at depth ${MAX_SCHEMA_DEPTH})_`);
      return;
    }
    ctx.stack.push(ref);
    try {
      renderSchema(target, ctx, depth, indent);
    } finally {
      ctx.stack.pop();
    }
    return;
  }

  const schema = mergeAllOf(raw, ctx);
  const description = asText(schema.description);

  for (const key of ['oneOf', 'anyOf'] as const) {
    const variants = asArray(schema[key]);
    if (variants.length === 0) continue;
    if (!push(ctx, `${indent}- ${key === 'oneOf' ? 'exactly one of' : 'any of'}:`)) return;
    for (const variant of variants) renderSchema(variant, ctx, depth + 1, `${indent}  `);
    return;
  }

  const properties = asRecord(schema.properties);
  if (properties) {
    if (depth >= MAX_SCHEMA_DEPTH) {
      push(ctx, `${indent}- _(nesting stopped at depth ${MAX_SCHEMA_DEPTH})_`);
      return;
    }
    const required = new Set(asArray(schema.required).map(asScalar));
    for (const [name, value] of Object.entries(properties)) {
      const child = asRecord(value);
      if (!child) continue;
      const flags = [typeLabel(child), required.has(name) ? 'required' : ''].filter(Boolean).join(', ');
      const note = [enumNote(child), asText(child.description)].filter(Boolean).join(' — ');
      if (!push(ctx, `${indent}- \`${name}\`${flags ? ` (${flags})` : ''}${note ? ` — ${note}` : ''}`)) return;
      // The `$ref` branch at the top of this function handles a property that is one; it is the same
      // code path for a named field, an array item and a whole body, which is why there is only one.
      if (isStructured(child)) renderSchema(child, ctx, depth + 1, `${indent}  `);
    }
    return;
  }

  const items = asRecord(schema.items);
  if (items) {
    if (depth >= MAX_SCHEMA_DEPTH) {
      push(ctx, `${indent}- _(nesting stopped at depth ${MAX_SCHEMA_DEPTH})_`);
      return;
    }
    const note = [enumNote(items), asText(items.description)].filter(Boolean).join(' — ');
    if (!push(ctx, `${indent}- each item: ${typeLabel(items) || 'value'}${note ? ` — ${note}` : ''}`)) return;
    if (isStructured(items)) renderSchema(items, ctx, depth + 1, `${indent}  `);
    return;
  }

  const parts = [typeLabel(schema) || 'value', enumNote(schema), description].filter(Boolean).join(' — ');
  if (parts) push(ctx, `${indent}- ${parts}`);
}

/**
 * One document under construction, and the only thing that may be written into.
 *
 * Every line of a document goes through `emit`, which is what makes `MAX_DOCUMENT_LINES` a bound
 * rather than a suggestion: there is no `out.push` anywhere for a caller to reach past it.
 */
interface Doc {
  lines: string[];
  /** Lines still available. Never negative. */
  left: number;
  truncated: boolean;
}

/** Says once that the document was cut. Called wherever a loop stops early for the same reason. */
function cut(doc: Doc): void {
  if (doc.truncated) return;
  doc.truncated = true;
  doc.lines.push('', `_(this document was cut at ${MAX_DOCUMENT_LINES} lines; the operation has more than fits in one document)_`);
}

/** Appends lines while the budget allows. Returns false once it does not, so a caller can stop looping. */
function emit(doc: Doc, ...lines: string[]): boolean {
  for (const line of lines) {
    if (doc.left <= 0) {
      cut(doc);
      return false;
    }
    doc.lines.push(line);
    doc.left--;
  }
  return true;
}

/**
 * A context for following `$ref` alone: it renders nothing, so its line budget is zero.
 *
 * `deref` needs the ref stack and the root and nothing else, and several callers want a target rather
 * than a rendering. Giving them a shared zero-budget context says that in the type rather than in a
 * comment at four call sites.
 */
function derefCtx(root: Json): SchemaCtx {
  return { root, lines: [], stack: [], truncated: false, max: 0 };
}

/**
 * A schema's bullet list.
 *
 * **The `Math.min` saves work; it is not what bounds the document.** `emit` is — a block longer than
 * the budget would simply be cut when it is written. Narrowing the cap here only avoids building four
 * hundred lines in order to keep ten of them, which on a specification with many responses is the
 * difference between a bounded document and a bounded document that took a while.
 */
function schemaLines(node: unknown, root: Json, doc: Doc): string[] {
  if (doc.left <= 0) return [];
  const ctx: SchemaCtx = { root, lines: [], stack: [], truncated: false, max: Math.min(MAX_SCHEMA_LINES, doc.left) };
  renderSchema(node, ctx, 0, '');
  return ctx.lines;
}

/** An example is many lines in one string; split so that every one of them is charged to the budget. */
function exampleLines(value: unknown, doc: Doc): string[] {
  if (doc.left <= 0) return [];
  return ['', 'Example:', '', '```json', ...exampleJson(value).split('\n'), '```'];
}

/**
 * An example rendered as JSON, with no way to throw.
 *
 * `JSON.stringify` throws `TypeError` on a cyclic object, and `yaml` really does produce one: an anchor
 * that refers to itself (`example: &e {self: *e}`) parses into a JS object that points at itself, which
 * is exactly what `maxAliasCount` does *not* prevent. It also throws on a `BigInt`. Both would have
 * escaped this module as something other than a `DocumentExtractionError` and failed the whole run —
 * deterministically, on every run after — which is the defect [ADR-0056](../../.ssot/ADR.md#adr-0056)
 * built its boundary to close.
 *
 * So the cycle is cut where it closes and named there, the same way a `$ref` cycle is, and the depth is
 * bounded for the same reason the schema renderer's is.
 */
function exampleJson(value: unknown): string {
  const seen = new Set<object>();
  const render = (node: unknown, depth: number): unknown => {
    if (typeof node === 'bigint') return `${node.toString()}`;
    if (typeof node === 'function' || typeof node === 'symbol' || node === undefined) return null;
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return '[circular]';
    if (depth >= MAX_SCHEMA_DEPTH) return '[…]';
    seen.add(node);
    try {
      if (Array.isArray(node)) return node.map((item) => render(item, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) out[key] = render(item, depth + 1);
      return out;
    } finally {
      seen.delete(node);
    }
  };
  try {
    return JSON.stringify(render(value, 0), null, 2) ?? 'null';
  } catch {
    // Unreachable by construction; a `toJSON` that throws would be the way in, and a document is worth
    // more than the one example it could not print.
    return '"[could not be rendered]"';
  }
}

/** `|` ends a cell in GFM and a newline ends the row, so both have to stop being themselves. */
function cell(value: string): string {
  const text = value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? ' ' : text;
}

interface Operation {
  method: string;
  path: string;
  node: Json;
  /** Path-item level parameters, which apply to every operation under it. */
  inherited: unknown[];
}

/**
 * The slug of one operation's derived path segment.
 *
 * **It is a pure function of `(method, path)` and of nothing else** — not of position in the file, not
 * of how many operations came before it. That is the property `documents_project_generation_path_uq` needs and
 * the one a test mutates to prove: re-indexing the same specification with its `paths` map written in
 * another order has to produce the same set of stored paths, or the incremental run below would delete
 * and re-create every document of a file whose bytes merely moved.
 */
function slugFor(method: string, urlPath: string): string {
  const cleaned = urlPath
    .replace(/[{}]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const base = cleaned ? `${method}-${cleaned}` : method;
  if (base.length <= MAX_SEGMENT_CHARS) return base;
  // A cut slug could collide with another cut slug, so a cut one is always disambiguated.
  return `${base.slice(0, MAX_SEGMENT_CHARS)}-${digest(method, urlPath)}`;
}

/** Eight hex of `sha256("get /pets/{petId}")`: short, stable, and derived from the operation alone. */
function digest(method: string, urlPath: string): string {
  return createHash('sha256').update(`${method} ${urlPath}`).digest('hex').slice(0, 8);
}

/**
 * Final path segments for a whole specification, collisions resolved.
 *
 * Two operations can only collide after slugging — `/pets/{petId}` and `/pets/{pet-id}` both cleaning
 * to `pets-petId` — and when they do, **both** get the hash suffix rather than the second one. Suffixing
 * only the loser would make the winner's path depend on which was read first, which is exactly the
 * order-dependence this function exists to avoid.
 */
function segmentsFor(operations: Operation[]): string[] {
  const slugs = operations.map((op) => slugFor(op.method, op.path));
  const counts = new Map<string, number>();
  for (const slug of slugs) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  return slugs.map((slug, i) => ((counts.get(slug) ?? 0) > 1 ? `${slug}-${digest(operations[i].method, operations[i].path)}` : slug));
}

interface SpecInfo {
  title: string;
  version: string;
  /** `3.0.3`, or `2.0` for a Swagger document. */
  specVersion: string;
  swagger: boolean;
  servers: string[];
}

function specInfo(root: Json): SpecInfo {
  const info = asRecord(root.info) ?? {};
  const swagger = asScalar(root.swagger) !== '';
  const servers = swagger
    ? (() => {
        const host = asText(root.host);
        const basePath = asText(root.basePath);
        const schemes = asArray(root.schemes).map(asScalar).filter(Boolean);
        if (!host) return basePath ? [basePath] : [];
        return (schemes.length ? schemes : ['https']).map((scheme) => `${scheme}://${host}${basePath}`);
      })()
    : asArray(root.servers)
        .map((s) => asText(asRecord(s)?.url))
        .filter(Boolean);
  return {
    title: asText(info.title) || 'API',
    version: asScalar(info.version),
    specVersion: swagger ? asScalar(root.swagger) : asScalar(root.openapi),
    swagger,
    servers,
  };
}

/** Parameters, deduplicated by `(name, in)` with the operation's own winning over the path item's. */
function parametersOf(operation: Operation, root: Json): Json[] {
  const out = new Map<string, Json>();
  for (const list of [operation.inherited, asArray(operation.node.parameters)]) {
    for (const entry of list) {
      const ctx = derefCtx(root);
      const parameter = resolved(deref(entry, ctx)) ?? asRecord(entry);
      if (!parameter) continue;
      const name = asText(parameter.name);
      const location = asText(parameter.in);
      if (!name || !location) continue;
      out.set(`${location}:${name}`, parameter);
    }
  }
  return [...out.values()];
}

const PARAMETER_SECTIONS: Array<[string, string]> = [
  ['path', 'Path parameters'],
  ['query', 'Query parameters'],
  ['header', 'Header parameters'],
  ['cookie', 'Cookie parameters'],
  ['formData', 'Form parameters'],
];

function renderParameters(parameters: Json[], doc: Doc): void {
  for (const [location, heading] of PARAMETER_SECTIONS) {
    const group = parameters.filter((p) => asText(p.in) === location);
    if (group.length === 0) continue;
    if (!emit(doc, `## ${heading}`, '| Name | Type | Required | Description |', '| --- | --- | --- | --- |')) return;
    for (const parameter of group) {
      // OpenAPI 3 puts the type under `schema`; Swagger 2 puts it on the parameter itself.
      const schema = asRecord(parameter.schema) ?? parameter;
      const type = typeLabel(schema) || 'string';
      const required = parameter.required === true ? 'yes' : 'no';
      if (!emit(doc, `| \`${cell(asText(parameter.name))}\` | ${cell(type)} | ${required} | ${cell(asText(parameter.description))} |`)) return;
    }
    if (!emit(doc, '')) return;
  }
}

function renderBody(operation: Operation, parameters: Json[], root: Json, doc: Doc): void {
  // Swagger 2: the body is a parameter with `in: body`.
  const swaggerBody = parameters.find((p) => asText(p.in) === 'body');
  if (swaggerBody) {
    if (!emit(doc, '## Request body', swaggerBody.required === true ? '**Required.**' : 'Optional.')) return;
    const description = asText(swaggerBody.description);
    if (description && !emit(doc, description)) return;
    const block = schemaLines(swaggerBody.schema, root, doc);
    if (block.length && !emit(doc, '', ...block)) return;
    emit(doc, '');
    return;
  }

  const body = resolved(deref(operation.node.requestBody, derefCtx(root)));
  if (!body) return;
  if (!emit(doc, '## Request body', body.required === true ? '**Required.**' : 'Optional.')) return;
  const description = asText(body.description);
  if (description && !emit(doc, description)) return;
  const content = asRecord(body.content) ?? {};
  for (const [mediaType, value] of Object.entries(content)) {
    // Every loop that can run as long as the file allows checks the budget itself, so a document with
    // a hundred thousand of something stops looping rather than filling an array nobody reads.
    if (!emit(doc, '', `### ${mediaType}`)) return;
    const media = asRecord(value);
    const block = media ? schemaLines(media.schema, root, doc) : [];
    if (block.length && !emit(doc, ...block)) return;
    const example = media?.example ?? asRecord(media?.examples)?.default;
    if (example !== undefined && !emit(doc, ...exampleLines(example, doc))) return;
  }
  emit(doc, '');
}

function renderResponses(operation: Operation, root: Json, doc: Doc): void {
  const responses = asRecord(operation.node.responses);
  if (!responses) return;
  if (!emit(doc, '## Responses')) return;
  // **The loop a specification can make arbitrarily long.** A response is one map entry — about fifty
  // bytes with a `$ref` in it — and each one renders a schema, so the count is bounded by the file size
  // divided by fifty rather than by anything sensible. `emit` returning false is what ends it.
  for (const [status, value] of Object.entries(responses)) {
    const response = resolved(deref(value, derefCtx(root)));
    const description = asText(response?.description);
    if (!emit(doc, '', `### ${status}${description ? ` — ${description}` : ''}`)) return;
    if (!response) continue;

    // Swagger 2: one `schema` for every media type the operation produces.
    if (response.schema !== undefined) {
      const block = schemaLines(response.schema, root, doc);
      if (block.length && !emit(doc, '', ...block)) return;
      continue;
    }
    const content = asRecord(response.content) ?? {};
    for (const [mediaType, mediaValue] of Object.entries(content)) {
      if (!emit(doc, '', `#### ${mediaType}`)) return;
      const media = asRecord(mediaValue);
      const block = media ? schemaLines(media.schema, root, doc) : [];
      if (block.length && !emit(doc, ...block)) return;
      const example = media?.example ?? asRecord(media?.examples)?.default;
      if (example !== undefined && !emit(doc, ...exampleLines(example, doc))) return;
    }
  }
  emit(doc, '');
}

/**
 * One operation as a Markdown document.
 *
 * The `# H1` is `GET /pets/{petId}` because that is what `chunkMarkdown` takes as the title, what
 * `search_docs` prints beside every hit, and what somebody looking at a list of three hundred documents
 * reads. Every `##` below it becomes a heading breadcrumb, so a chunk of the response schema retrieves
 * carrying "GET /pets/{petId} > Responses > 200" rather than a bare list of field names.
 */
function renderOperation(operation: Operation, info: SpecInfo, root: Json): string {
  const node = operation.node;
  const title = `${operation.method.toUpperCase()} ${operation.path}`;
  // **The one place a document's lines are allocated, and the reason the budget cannot be got around.**
  // Nothing below appends to `doc.lines` directly; everything goes through `emit`.
  const doc: Doc = { lines: [], left: MAX_DOCUMENT_LINES, truncated: false };
  emit(doc, `# ${title}`, '');

  const provenance = [`\`${title}\``, `in **${info.title}**${info.version ? ` ${info.version}` : ''}`].join(' ');
  const operationId = asText(node.operationId);
  emit(doc, `${provenance}${operationId ? ` — operation \`${operationId}\`` : ''}.`, '');

  const summary = asText(node.summary);
  if (summary) emit(doc, summary, '');
  const description = asText(node.description);
  if (description && description !== summary) emit(doc, description, '');
  if (node.deprecated === true) emit(doc, '**Deprecated.**', '');

  const parameters = parametersOf(operation, root);
  renderParameters(parameters, doc);
  renderBody(operation, parameters, root, doc);
  renderResponses(operation, root, doc);

  const tags = asArray(node.tags).map(asScalar).filter(Boolean);
  // An operation's own `security` replaces the document's — including an explicit empty array, which
  // is how a specification says "this one endpoint is public".
  const security = node.security !== undefined ? asArray(node.security) : asArray(root.security);
  const schemes = security.flatMap((entry) => Object.keys(asRecord(entry) ?? {})).filter((v, i, a) => a.indexOf(v) === i);

  if (schemes.length > 0) {
    emit(doc, '## Security', '', ...schemes.map((s) => `- \`${s}\``), '');
  }
  const servers = asArray(node.servers)
    .map((s) => asText(asRecord(s)?.url))
    .filter(Boolean);
  const effective = servers.length ? servers : info.servers;
  if (effective.length > 0) {
    emit(doc, '## Servers', '', ...effective.map((url) => `- \`${url}\``), '');
  }
  if (tags.length > 0) emit(doc, '## Tags', '', tags.map((t) => `\`${t}\``).join(', '), '');

  return `${doc.lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/**
 * Every `(method, path)` pair in the specification, in the order the document writes them.
 *
 * A path item may itself be a `$ref` — OpenAPI 3.1 says so explicitly and 3.0 tolerates it — and a
 * specification that factors its path items out that way would otherwise index as no operations at
 * all and be refused whole.
 */
function operationsOf(root: Json): Operation[] {
  const paths = asRecord(root.paths) ?? {};
  const out: Operation[] = [];
  const ctx = derefCtx(root);
  for (const [urlPath, value] of Object.entries(paths)) {
    if (urlPath.startsWith('x-')) continue;
    const declared = asRecord(value);
    if (!declared) continue;
    // **Siblings of a path item's `$ref` win, and that is our choice rather than the specification's.**
    // Both 3.0 and 3.1 say the behaviour is *undefined* when a field appears on the referencing object
    // and on the referenced one. Preferring the sibling is the only reading under which a `summary` or
    // a `description` written beside the reference means anything at all, and writing one there is the
    // reason an author uses a sibling in the first place.
    const item = asText(declared.$ref) ? { ...(resolved(deref(declared, ctx)) ?? {}), ...declared } : declared;
    const inherited = asArray(item.parameters);
    for (const method of METHODS) {
      const node = asRecord(item[method]);
      if (!node) continue;
      out.push({ method, path: urlPath, node, inherited });
    }
  }
  return out;
}

/** What a specification may weigh before it is parsed ([ADR-0057](../../.ssot/ADR.md#adr-0057)). */
export interface SpecLimits {
  maxSpecBytes: number;
}

/**
 * Refuses a specification on the size the scan recorded, **before** it is read.
 *
 * It is a separate ceiling from `MAX_CONVERTED_FILE_BYTES` and much lower, because the two bound
 * different costs. A converted type is streamed or read a page at a time and its output is roughly the
 * size of its input. A specification is parsed whole into a JS object graph, and that graph is
 * **about fifty-five times the file**.
 *
 * **How that was measured, so it can be re-measured.** A generated specification of the shape a real
 * one has — a path item, two parameters, two responses, a `$ref` to a shared schema — grown to a
 * target byte size, parsed with `yaml@2.9.1` under `--expose-gc`, with `heapUsed` read after a double
 * collection either side of the parse: 1 MiB → 60 MiB, 2 MiB → 113 MiB, 4 MiB → 218 MiB, 8 MiB →
 * 444 MiB. Then the number an operator actually needs, by running the same parse under falling
 * `--max-old-space-size`: an 8 MiB specification completes at 384 MB and is OOM-killed at 320.
 *
 * **The graph is not transient, and the earlier wording that called it so was wrong.** `documents()`
 * closes over `root`, and the indexer holds that generator across the whole embedding loop, so the
 * graph is resident for as long as that one file is being indexed — beside an embedding model that is
 * itself ~470 MB on the default provider. That is the cost 8 MiB buys, it is written into
 * `README.md`'s limits table in those terms, and an instance whose container cannot spare it should
 * lower the ceiling rather than discover the number from an OOM kill.
 */
export function checkSpecSize(relativePath: string, sizeBytes: number, limits: SpecLimits): void {
  if (sizeBytes <= limits.maxSpecBytes) return;
  throw new DocumentExtractionError(
    `"${relativePath}" is ${bytesLabel(sizeBytes)}, over the ${bytesLabel(limits.maxSpecBytes)} a specification may be when it is parsed. ` +
      `Parsing one produces an object graph around fifty-five times the size of the file, held in the server's own process for as long as the file ` +
      `is being indexed, so the limit is there to keep one specification from taking the dashboard and the MCP endpoint down with it; ` +
      `raise MAX_SPEC_FILE_BYTES if this file is genuinely one API and the host has the headroom — about 400 MB at the default ceiling.`,
  );
}

/**
 * A parsed, validated specification and the documents it will yield.
 *
 * **`count` is known before any document is rendered, and `documents()` renders them one at a time.**
 * Which operations exist, and therefore what every derived path is, is decided up front — collision
 * resolution needs the whole multiset of slugs and may not depend on iteration order — but the Markdown
 * is not. A specification with three thousand operations would otherwise hold three thousand rendered
 * documents in memory at once while the indexer embedded the first of them.
 */
export interface OpenApiExpansion {
  readonly count: number;
  documents(): Generator<DerivedDocument>;
}

/**
 * A specification's bytes → the documents it expands into.
 *
 * **Everything this module can throw is a `DocumentExtractionError`, including out of the generator,
 * and that is the whole contract with `indexer.ts`.** A `values.yaml` that wandered into the source, a
 * truncated file, a `$ref` whose pointer will not decode, an example that is a cyclic object — each is
 * a reason on that source and a run that finishes ([ADR-0056](../../.ssot/ADR.md#adr-0056)). A parser's
 * own exception escaping would fail the run and, being deterministic, keep failing it until somebody
 * found the file, which is the defect that boundary exists to prevent.
 */
export function readOpenApi(relativePath: string, bytes: Buffer, limits: SpecLimits): OpenApiExpansion {
  // Checked again on the bytes in hand: `checkSpecSize` runs on the size the scan recorded, and a file
  // that grew between the two moments would otherwise walk past both.
  checkSpecSize(relativePath, bytes.byteLength, limits);

  let parsed: unknown;
  try {
    // `yaml` reads JSON too — JSON is a YAML subset — so one parser covers `.json` and `.yaml` alike.
    // `maxAliasCount` is the billion-laughs bound; it does not stop an anchor that points at itself,
    // which is why `exampleJson` and the schema renderer each carry their own cycle guard.
    parsed = parseYaml(bytes.toString('utf8'), { maxAliasCount: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DocumentExtractionError(`"${relativePath}" could not be parsed as YAML or JSON: ${message}`);
  }

  const root = asRecord(parsed);
  if (!root || (asScalar(root.openapi) === '' && asScalar(root.swagger) === '')) {
    throw new DocumentExtractionError(
      `"${relativePath}" is not an OpenAPI or Swagger document — it declares neither "openapi" nor "swagger". ` +
        `The openapi content type reads every .yaml, .yml and .json file in its source; move this file out of the source, ` +
        `or add it to IGNORE_GLOBS.`,
    );
  }

  let operations: Operation[];
  let info: SpecInfo;
  let segments: string[];
  try {
    operations = operationsOf(root);
    info = specInfo(root);
    segments = segmentsFor(operations);
  } catch (err) {
    throw unexpected(err, relativePath);
  }

  if (operations.length === 0) {
    throw new DocumentExtractionError(
      `"${relativePath}" is an OpenAPI document with no operations under "paths", so it would index as nothing at all.`,
    );
  }
  if (operations.length > MAX_OPERATIONS) {
    throw new DocumentExtractionError(
      `"${relativePath}" declares ${operations.length} operations, over the ${MAX_OPERATIONS} one specification may hold. ` +
        `Each becomes its own document with its own embeddings, so a file this size is either generated or written to be indexed; ` +
        `the largest specifications anyone publishes are around a thousand. Split it by service, or exclude it with IGNORE_GLOBS.`,
    );
  }

  let paths: string[];
  try {
    paths = operations.map((operation, i) => {
      const normalized = normalizeRelativePath(`${relativePath}/${segments[i]}`);
      if (!normalized) {
        // Unreachable for a slug of `[A-Za-z0-9_-]`, and asserted rather than assumed because a path
        // that escaped normalisation is a path `documents_project_generation_path_uq` would not be
        // protecting.
        throw new DocumentExtractionError(`"${relativePath}" produced an unusable document path for ${operation.method} ${operation.path}`);
      }
      return normalized;
    });
  } catch (err) {
    // The same wrapper its neighbours have. Nothing here is known to throw anything else; the pattern
    // is the point, because the next thing added inside this function will be written to match it.
    throw unexpected(err, relativePath);
  }

  return {
    count: operations.length,
    *documents(): Generator<DerivedDocument> {
      for (let i = 0; i < operations.length; i++) {
        let markdown: string;
        try {
          markdown = renderOperation(operations[i], info, root);
        } catch (err) {
          throw unexpected(err, relativePath);
        }
        yield { relativePath: paths[i], markdown, sizeBytes: Buffer.byteLength(markdown, 'utf8') };
      }
    },
  };
}

/**
 * Anything this module did not expect, turned into the one type the indexer knows how to report.
 *
 * Every known way to throw in here has been closed one at a time — the pointer decode, the example
 * serializer, the recursion bounds — and this is the admission that closing them one at a time is not
 * a proof. A specification is attacker-shaped input in every installation where somebody other than the
 * operator can commit one, and the failure it must not have is the one that takes the run down for
 * every *other* file in the source, for ever.
 */
function unexpected(err: unknown, relativePath: string): DocumentExtractionError {
  if (err instanceof DocumentExtractionError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new DocumentExtractionError(`"${relativePath}" could not be read as an OpenAPI document: ${message}`);
}
