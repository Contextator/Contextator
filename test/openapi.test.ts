import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DocumentExtractionError } from '../src/services/doc-types/index.js';
import { allowedExtensionsFor, expandsToManyDocuments, FLAVORS, transformContent } from '../src/services/flavors.js';
import { extensionMatcher } from '../src/services/fs-scan.js';
import { MAX_DOCUMENT_LINES, MAX_OPERATIONS, MAX_SCHEMA_DEPTH, readOpenApi, type DerivedDocument } from '../src/services/openapi.js';

/**
 * The flavor that breaks "a file is a document" ([ADR-0057](../../.ssot/ADR.md#adr-0057)).
 *
 * Three of the claims below are load-bearing for the database rather than for the reader, and they are
 * the ones written as mutation targets: the derived path depends on `(method, path)` and on nothing
 * else, the same bytes produce the same set of paths twice, and two operations that slug to the same
 * thing are *both* disambiguated. `documents_project_generation_path_uq` is `(project_id, index_generation,
 * relative_path)`, so a path that moved with the order of a YAML map would make the incremental run
 * delete and re-create every document of a file whose bytes merely got reformatted.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'openapi');
const LIMITS = { maxSpecBytes: 8 * 1024 * 1024 };

function fixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES, name));
}

/** Every document of a specification, in one array — the shape these assertions are written against. */
function expandOpenApi(storedPath: string, bytes: Buffer, limits = LIMITS): DerivedDocument[] {
  return [...readOpenApi(storedPath, bytes, limits).documents()];
}

function expand(name: string, storedPath = `api/${name}`): DerivedDocument[] {
  return expandOpenApi(storedPath, fixture(name));
}

/** The six operations `petstore.yaml` declares. The number is the test. */
const PETSTORE_OPERATIONS = 6;

describe('expandOpenApi — one document per operation', () => {
  it('turns one specification into exactly one document per operation', () => {
    const docs = expand('petstore.yaml');
    expect(docs).toHaveLength(PETSTORE_OPERATIONS);
    expect(docs.map((d) => d.relativePath)).toEqual([
      'api/petstore.yaml/get-pets',
      'api/petstore.yaml/post-pets',
      'api/petstore.yaml/get-pets-petId',
      'api/petstore.yaml/delete-pets-petId',
      'api/petstore.yaml/get-pets-petId-photos',
      'api/petstore.yaml/post-stores-storeId-orders',
    ]);
  });

  it('titles each document with its method and path, so a hit says which endpoint it is', () => {
    const docs = expand('petstore.yaml');
    const byPath = new Map(docs.map((d) => [d.relativePath, d.markdown]));
    expect(byPath.get('api/petstore.yaml/delete-pets-petId')?.split('\n')[0]).toBe('# DELETE /pets/{petId}');
    expect(byPath.get('api/petstore.yaml/get-pets')?.split('\n')[0]).toBe('# GET /pets');
  });

  it('carries the operation into the document and leaves the other operations out of it', () => {
    const doc = expand('petstore.yaml').find((d) => d.relativePath.endsWith('get-pets-petId'));
    const md = doc?.markdown ?? '';
    expect(md).toContain('operation `getPetById`');
    expect(md).toContain('Find a pet by its identifier');
    expect(md).toContain('## Path parameters');
    // Inherited from the path item, not written on the operation.
    expect(md).toContain("| `petId` | integer (int64) | yes | The pet's identifier. |");
    expect(md).toContain('### 404 — No pet with that identifier');
    expect(md).toContain('- `name` (string, required) — What the pet answers to.');
    // The whole point: one endpoint's document does not contain the next endpoint's.
    expect(md).not.toContain('Add a new pet to the store');
    expect(md).not.toContain('Place an order at one store');
  });

  it('resolves $ref into the fields a reader can act on, one level down as well', () => {
    const doc = expand('petstore.yaml').find((d) => d.relativePath.endsWith('post-pets'));
    const md = doc?.markdown ?? '';
    expect(md).toContain('## Request body');
    expect(md).toContain('**Required.**');
    expect(md).toContain('- `category` (`Category`)');
    expect(md).toContain('  - `id` (integer (int64))');
    expect(md).toContain('- `status` (string) — one of `available`, `pending`, `sold`');
  });

  it('reports the security an operation actually has, including the one that waives it', () => {
    const docs = expand('petstore.yaml');
    const get = docs.find((d) => d.relativePath.endsWith('get-pets'))?.markdown ?? '';
    const del = docs.find((d) => d.relativePath.endsWith('delete-pets-petId'))?.markdown ?? '';
    expect(get).toContain('## Security');
    expect(get).toContain('- `api_key`');
    // `security: []` on the operation means public, and must not inherit the document's scheme.
    expect(del).not.toContain('## Security');
  });

  it('reads Swagger 2.0 as well, including its body parameter and host/basePath servers', () => {
    const docs = expand('legacy-swagger.json');
    expect(docs.map((d) => d.relativePath)).toEqual(['api/legacy-swagger.json/get-invoices', 'api/legacy-swagger.json/post-invoices']);
    const post = docs[1].markdown;
    expect(post).toContain('# POST /invoices');
    expect(post).toContain('## Request body');
    expect(post).toContain('The invoice to issue.');
    expect(post).toContain('- `amountCents` (integer (int64), required)');
    const get = docs[0].markdown;
    expect(get).toContain('- `https://billing.example.com/api`');
    expect(get).toContain('| `since` | string (date) | no | Only invoices issued on or after this date. |');
  });
});

describe('derived paths', () => {
  /**
   * **Mutation target 1.** Replace the `(method, path)` hash in `segmentsFor` with a counter over the
   * operation list and this goes red: the two orderings below produce `…-1` and `…-2` assigned to
   * different operations.
   */
  it('depends on the operation and not on where it sits in the file', () => {
    const forward = expandOpenApi('spec.yaml', Buffer.from(twoColliding('a', 'b')), LIMITS);
    const reversed = expandOpenApi('spec.yaml', Buffer.from(twoColliding('b', 'a')), LIMITS);
    expect([...forward.map((d) => d.relativePath)].sort()).toEqual([...reversed.map((d) => d.relativePath)].sort());
    // And each operation keeps *its own* path across the reordering, not merely the set.
    const pathOf = (docs: DerivedDocument[], title: string) => docs.find((d) => d.markdown.startsWith(`# ${title}\n`))?.relativePath;
    expect(pathOf(forward, 'GET /pets/{petId}/')).toBe(pathOf(reversed, 'GET /pets/{petId}/'));
    expect(pathOf(forward, 'GET /pets/{petId}')).toBe(pathOf(reversed, 'GET /pets/{petId}'));
  });

  /**
   * **Mutation target 2.** Suffix only the second of two colliding slugs and this goes red — the first
   * one's path would then be `get-pets-petId`, which is the winner-takes-the-clean-name behaviour that
   * makes a path depend on read order.
   */
  it('disambiguates both sides of a collision, never just the loser', () => {
    const docs = expandOpenApi('spec.yaml', Buffer.from(twoColliding('a', 'b')), LIMITS);
    expect(docs).toHaveLength(2);
    for (const doc of docs) expect(doc.relativePath).toMatch(/^spec\.yaml\/get-pets-petId-[0-9a-f]{8}$/);
    expect(new Set(docs.map((d) => d.relativePath)).size).toBe(2);
  });

  it('produces the same paths for the same bytes, every time', () => {
    const once = expand('petstore.yaml').map((d) => d.relativePath);
    const twice = expand('petstore.yaml').map((d) => d.relativePath);
    expect(twice).toEqual(once);
  });

  it('never produces a path normalizeRelativePath would refuse', () => {
    const docs = expandOpenApi('api/spec.yaml', Buffer.from(oddPaths()), LIMITS);
    for (const doc of docs) {
      expect(doc.relativePath.startsWith('api/spec.yaml/')).toBe(true);
      for (const segment of doc.relativePath.split('/')) expect(segment).not.toMatch(/^\.{1,2}$/);
    }
    expect(new Set(docs.map((d) => d.relativePath)).size).toBe(docs.length);
  });

  it('cuts a path that is too long to be a segment, and disambiguates every cut one', () => {
    const long = 'x'.repeat(400);
    const docs = expandOpenApi('spec.yaml', Buffer.from(longPaths(long)), LIMITS);
    expect(docs).toHaveLength(2);
    for (const doc of docs) {
      const segment = doc.relativePath.split('/').pop() ?? '';
      expect(segment.length).toBeLessThanOrEqual(129);
      expect(segment).toMatch(/-[0-9a-f]{8}$/);
    }
    expect(new Set(docs.map((d) => d.relativePath)).size).toBe(2);
  });
});

describe('cycles and depth', () => {
  it('finishes on a specification whose schemas reference each other, and names the cycle', () => {
    const docs = expand('cyclic.yaml');
    expect(docs.map((d) => d.relativePath)).toEqual([
      'api/cyclic.yaml/get-trees',
      'api/cyclic.yaml/get-chains',
      'api/cyclic.yaml/get-aliases',
      'api/cyclic.yaml/get-pairs',
    ]);
    const by = (suffix: string) => docs.find((d) => d.relativePath.endsWith(suffix))?.markdown ?? '';
    expect(by('get-trees')).toContain('`Node` (circular reference)');
    expect(by('get-pairs')).toContain('`Left` (circular reference)');
  });

  /**
   * **A cycle made of nothing but references used to be reported as a dangling pointer.** `deref`
   * followed `Alias → Mirror → Alias` internally and unwound its whole stack on the way out, so by the
   * time the caller asked "is this ref on the stack?" the answer was no and the note said
   * "(unresolved reference)" — which sends a reader looking for a `$ref` that is in fact right there.
   * Mutation: drop the `failed` discriminator and read the stack again, and this goes red.
   */
  it('calls a cycle made of references a cycle, not a missing pointer', () => {
    const alias = expand('cyclic.yaml').find((d) => d.relativePath.endsWith('get-aliases'))?.markdown ?? '';
    expect(alias).toContain('(circular reference)');
    expect(alias).not.toContain('(unresolved reference)');
  });

  /** Acceptance criterion 3: the document says the expansion was cut, rather than silently ending. */
  it('says it reached the depth limit on the chain that would otherwise run round for ever', () => {
    const chain = expand('cyclic.yaml').find((d) => d.relativePath.endsWith('get-chains'))?.markdown ?? '';
    // The note names what was cut, so a reader knows the document is not the whole schema.
    expect(chain).toContain(`\`L9\` _(nesting stopped at depth ${MAX_SCHEMA_DEPTH})_`);
    // Eight links of it, and not the ninth's fields: the limit is the limit.
    expect(chain).toContain('- `next` (`L8`)');
    expect(chain).not.toContain('`L10`');
  });

  /**
   * **The bound the file ceiling does not give you.** `MAX_SCHEMA_LINES` is per schema, and the number
   * of schemas a document renders is responses × media types — a count the file size bounds only by
   * dividing it by about forty bytes. Six hundred responses at a hundred properties each is already a
   * hundred thousand lines from a 40 KB file; a hundred and seventy-five thousand fit under the 8 MiB
   * ceiling, which is gigabytes of Markdown in an array before anything is joined or stored.
   *
   * Mutation: remove the document budget (`emit` → `doc.lines.push`) and this goes red on the line
   * count long before it goes red on the note.
   */
  it('bounds what one document may render, not just what one schema may', () => {
    const docs = expand('render-bomb.yaml');
    expect(docs).toHaveLength(1);
    const lines = docs[0].markdown.split('\n');
    // The budget plus the two-line note it ends with, and nothing like the hundred thousand the
    // specification asks for.
    expect(lines.length).toBeLessThanOrEqual(MAX_DOCUMENT_LINES + 4);
    expect(docs[0].markdown).toContain(`this document was cut at ${MAX_DOCUMENT_LINES} lines`);
    // It is cut, not empty: the endpoint is still identifiable and still says what it is.
    expect(lines[0]).toBe('# GET /bomb');
    expect(docs[0].markdown).toContain('A response for every status code anyone ever imagined');
    expect(docs[0].sizeBytes).toBeLessThan(1024 * 1024);
  });

  it('refuses a specification with more operations than anyone publishes, rather than cutting the list', () => {
    // Truncating schemas loses detail about an endpoint that is still there and still says so.
    // Truncating the operation list would drop endpoints silently, and "not in the documentation" is a
    // wrong answer rather than a partial one — so this one is a refusal.
    const paths = Array.from(
      { length: MAX_OPERATIONS + 1 },
      (_, i) => `  /p${i}:\n    get:\n      responses:\n        '200':\n          description: ok\n`,
    ).join('');
    const spec = `openapi: 3.0.0\ninfo:\n  title: Many\n  version: "1"\npaths:\n${paths}`;
    expect(() => expandOpenApi('many.yaml', Buffer.from(spec))).toThrow(/declares \d+ operations, over the/);
  }, 30_000);

  it('bounds a schema that is wide rather than deep', () => {
    const docs = expandOpenApi('spec.yaml', Buffer.from(wideSchema(600)), LIMITS);
    expect(docs[0].markdown).toContain('_(schema truncated at 400 lines)_');
  });
});

describe('reading is eager, rendering is not', () => {
  /**
   * **Every derived path is decided before any document is rendered, and rendering happens one at a
   * time.** The first half is forced: collision resolution needs the whole multiset of slugs and may
   * not depend on iteration order. The second is the point — a specification with three thousand
   * operations would otherwise hold three thousand rendered documents in memory while the indexer
   * embedded the first of them.
   *
   * What this pins is the shape, not the byte count: that `count` answers before iteration starts, and
   * that what comes back is a generator rather than a materialised array.
   */
  it('knows how many documents there are before rendering one', () => {
    const expansion = readOpenApi('api/petstore.yaml', fixture('petstore.yaml'), LIMITS);
    expect(expansion.count).toBe(PETSTORE_OPERATIONS);
    const iterator = expansion.documents();
    expect(typeof iterator.next).toBe('function');
    const first = iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.relativePath).toBe('api/petstore.yaml/get-pets');
    // Abandoning it half-way is allowed and renders nothing further.
    iterator.return?.(undefined as never);
  });

  it('refuses a file that is not a specification before it yields anything at all', () => {
    // The validation is eager, so `indexer.ts` learns a file is unusable without starting to write.
    expect(() => readOpenApi('api/deploy-values.yaml', fixture('deploy-values.yaml'), LIMITS)).toThrow(DocumentExtractionError);
  });
});

describe('nothing escapes as anything but a refusal', () => {
  /**
   * **The blocker this block exists for.** `yaml` really does build a self-referential JS object for an
   * anchor that points at itself — `maxAliasCount` bounds expansion, not identity — so `JSON.stringify`
   * threw `TypeError: Converting circular structure to JSON`, and `decodeURIComponent` threw `URIError`
   * on a pointer containing a lone `%`. Neither is a `DocumentExtractionError`, so `indexer.ts` rethrew
   * it and failed the whole run — deterministically, on every run after, for every other file in the
   * source. That is exactly the failure ADR-0056's boundary exists to prevent, reached by a new road.
   */
  it('renders a specification written to make a renderer throw, and throws nothing', () => {
    const docs = expand('hostile.yaml');
    expect(docs.map((d) => d.relativePath)).toEqual([
      'api/hostile.yaml/post-self-referential-example',
      'api/hostile.yaml/get-undecodable-pointer',
      'api/hostile.yaml/get-inherited-pointer',
      'api/hostile.yaml/get-external-pointer',
    ]);
    const byPath = new Map(docs.map((d) => [d.relativePath, d.markdown]));
    // The cycle is cut where it closes and named, rather than taking the process with it.
    expect(byPath.get('api/hostile.yaml/post-self-referential-example')).toContain('"[circular]"');
    expect(byPath.get('api/hostile.yaml/post-self-referential-example')).toContain('"name": "a node"');
    // A pointer that will not percent-decode resolves to nothing, which is a note and not an exception.
    expect(byPath.get('api/hostile.yaml/get-undecodable-pointer')).toContain('(unresolved reference)');
    expect(byPath.get('api/hostile.yaml/get-external-pointer')).toContain('(reference to another file; not resolved)');
    // `key in record` walks the prototype chain, so this pointer resolved to `Object.prototype` and
    // rendered as a schema with nothing in it — a reference that reads as found and shows nothing.
    expect(byPath.get('api/hostile.yaml/get-inherited-pointer')).toContain('(unresolved reference)');
  });

  it('terminates on a $ref cycle reached through allOf, which resolves by another path', () => {
    const looped = [
      'openapi: 3.0.0',
      'info: {title: L, version: "1"}',
      'paths:',
      '  /a:',
      '    get:',
      '      responses:',
      '        "200":',
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema: {$ref: "#/components/schemas/A"}',
      'components:',
      '  schemas:',
      '    A: {allOf: [{$ref: "#/components/schemas/A"}], type: object, properties: {id: {type: string}}}',
      '',
    ].join('\n');
    const docs = expandOpenApi('loop.yaml', Buffer.from(looped));
    expect(docs).toHaveLength(1);
    expect(docs[0].markdown).toContain('- `id` (string)');
  });
});

describe('what the flavor refuses', () => {
  it('refuses a YAML file that is not a specification, as a reportable extraction failure', () => {
    expect(() => expand('deploy-values.yaml')).toThrow(DocumentExtractionError);
    try {
      expand('deploy-values.yaml');
    } catch (err) {
      expect((err as Error).message).toContain('is not an OpenAPI or Swagger document');
      expect((err as Error).message).toContain('deploy-values.yaml');
    }
  });

  it('refuses a specification with no operations rather than indexing an empty document', () => {
    const empty = 'openapi: 3.0.0\ninfo:\n  title: Nothing\n  version: "1"\npaths: {}\n';
    expect(() => expandOpenApi('spec.yaml', Buffer.from(empty), LIMITS)).toThrow(/no operations/);
  });

  it('refuses unparseable YAML by name, and does not let the parser escape', () => {
    expect(() => expandOpenApi('spec.yaml', Buffer.from('openapi: 3.0.0\npaths:\n  - [unclosed\n'), LIMITS)).toThrow(DocumentExtractionError);
  });

  it('refuses a specification over its own parse ceiling, which is not the conversion one', () => {
    expect(() => expandOpenApi('spec.yaml', fixture('petstore.yaml'), { maxSpecBytes: 16 })).toThrow(/MAX_SPEC_FILE_BYTES/);
  });
});

describe('OpenAPI 3.1 shapes', () => {
  /**
   * A path item may itself be a `$ref`, which 3.1 states outright. A specification that factors its
   * path items out that way produced **no** operations and was then refused whole for having none —
   * the worst shape of failure, because the file is a perfectly good specification.
   */
  it('follows a path item that is a $ref, and merges what is written beside it', () => {
    const docs = expand('path-item-ref.yaml');
    expect(docs.map((d) => d.relativePath)).toEqual(['api/path-item-ref.yaml/get-pets', 'api/path-item-ref.yaml/delete-pets-petId']);
    expect(docs[0].markdown).toContain('operation `listPets`');
    // The parameters on the referenced path item still reach the operation under it.
    expect(docs[1].markdown).toContain('## Path parameters');
    expect(docs[1].markdown).toContain('| `petId` |');
  });
});

describe('the flavor as the rest of the product sees it', () => {
  it('is a flavor, and only it reads the structured extensions', () => {
    expect(FLAVORS).toContain('openapi');
    expect(allowedExtensionsFor('openapi')).toContain('yaml');
    expect(allowedExtensionsFor('plain')).not.toContain('yaml');
    // A source that stored `yaml` and was then moved back to `plain` scans no YAML at all.
    expect(extensionMatcher(['md', 'yaml'], allowedExtensionsFor('plain')).test('openapi.yaml')).toBe(false);
    expect(extensionMatcher(['md', 'yaml'], allowedExtensionsFor('openapi')).test('openapi.yaml')).toBe(true);
  });

  it('expands only the structured files of its source, and leaves the README a document', () => {
    expect(expandsToManyDocuments('openapi', 'api/petstore.yaml')).toBe(true);
    expect(expandsToManyDocuments('openapi', 'api/spec.YML')).toBe(true);
    expect(expandsToManyDocuments('openapi', 'api/openapi.json')).toBe(true);
    expect(expandsToManyDocuments('openapi', 'api/README.md')).toBe(false);
    expect(expandsToManyDocuments('plain', 'api/petstore.yaml')).toBe(false);
  });

  it('leaves content alone, because the expansion is not a text transform', () => {
    expect(transformContent('openapi', '# Notes\n\n[[Wiki]]')).toBe('# Notes\n\n[[Wiki]]');
  });
});

/** Two operations whose URL paths slug to the same segment; `first`/`second` set the file order. */
function twoColliding(first: 'a' | 'b', second: 'a' | 'b'): string {
  const blocks: Record<'a' | 'b', string> = {
    a: "  /pets/{petId}:\n    get:\n      operationId: byCamel\n      responses:\n        '200':\n          description: ok\n",
    b: "  /pets/{petId}/:\n    get:\n      operationId: byTrailingSlash\n      responses:\n        '200':\n          description: ok\n",
  };
  return `openapi: 3.0.0\ninfo:\n  title: Collisions\n  version: "1"\npaths:\n${blocks[first]}${blocks[second]}`;
}

function oddPaths(): string {
  const paths = ['/', '/..', '/.', '/a//b', '/%7Bid%7D', '/ünïcode/yol'];
  const body = paths.map((p) => `  "${p}":\n    get:\n      responses:\n        '200':\n          description: ok\n`).join('');
  return `openapi: 3.0.0\ninfo:\n  title: Odd\n  version: "1"\npaths:\n${body}`;
}

function longPaths(long: string): string {
  return (
    `openapi: 3.0.0\ninfo:\n  title: Long\n  version: "1"\npaths:\n` +
    `  /${long}/one:\n    get:\n      responses:\n        '200':\n          description: ok\n` +
    `  /${long}/two:\n    get:\n      responses:\n        '200':\n          description: ok\n`
  );
}

function wideSchema(fields: number): string {
  const properties = Array.from({ length: fields }, (_, i) => `        field${i}:\n          type: string\n`).join('');
  return (
    `openapi: 3.0.0\ninfo:\n  title: Wide\n  version: "1"\npaths:\n` +
    `  /wide:\n    get:\n      responses:\n        '200':\n          description: ok\n` +
    `          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/Wide'\n` +
    `components:\n  schemas:\n    Wide:\n      type: object\n      properties:\n${properties}`
  );
}
