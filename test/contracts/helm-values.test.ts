import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **The Helm chart's values as a contract** ([ADR-0137](../../.ssot/ADR.md#adr-0137), Tier 2): every key
 * `charts/contextator/values.schema.json` accepts, flattened into lines sorted by path, one per node:
 *
 *     path: type [enum] {bounds} (required) (additionalProperties:false)
 *
 * `path` is dotted, `[]` is an array's item, `|anyOf[n]`, `|not`, `|if` and `|then` are the branches of the
 * keyword; `.*` is the schema every other key of an open object (`additionalProperties`) must satisfy. `(required)` marks a key its parent lists under `required`; a `required` list that names a key
 * the node has no entry for (an `if`/`then` branch) is written `(requires: a, b)` on the node itself.
 * `{bounds}` carries `minimum`, `maximum`, `minLength`, `minItems`, `uniqueItems` and `pattern`: tightening
 * a value an operator already sets is as much a change as renaming it. `$ref` is followed, so a shared
 * definition is written out where it is used.
 *
 * `title` and `description` are dropped (Tier 3). A schema keyword this flattening does not know fails the
 * test instead of being skipped, so the snapshot cannot quietly stop covering part of the schema. No `helm`
 * binary is needed: the chart's version bump is `helm-chart.yml`'s `version-bump` job.
 *
 * Re-record after a deliberate change, then review the diff like any other change:
 *
 *     npx vitest run --project unit test/contracts -u
 *
 * Outside CI a missing snapshot file is written silently; run with `CI=1` to check rather than extend.
 */

const SNAPSHOT = path.join(import.meta.dirname, '__snapshots__', 'helm-values.txt');
const SCHEMA = path.join(import.meta.dirname, '..', '..', 'charts', 'contextator', 'values.schema.json');

type Node = Record<string, unknown>;

const KNOWN = new Set([
  '$ref',
  '$schema',
  'additionalProperties',
  'anyOf',
  'definitions',
  'description',
  'enum',
  'if',
  'items',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'not',
  'pattern',
  'properties',
  'required',
  'then',
  'title',
  'type',
  'uniqueItems',
]);

const schema = JSON.parse(readFileSync(SCHEMA, 'utf8')) as Node;
const definitions = (schema.definitions ?? {}) as Record<string, Node>;

function resolve(node: Node): Node {
  const ref = node.$ref;
  if (typeof ref !== 'string') return node;
  const match = /^#\/definitions\/(.+)$/.exec(ref);
  const target = match ? definitions[match[1] as string] : undefined;
  if (!target) throw new Error(`values.schema.json: cannot resolve ${ref}`);
  // Anything written beside the `$ref` wins, as in the definition it points at.
  const { $ref: _ignored, ...beside } = node;
  return { ...target, ...beside };
}

function describeNode(node: Node, flags: string[]): string {
  const type = node.type === undefined ? '(any)' : Array.isArray(node.type) ? (node.type as string[]).join('|') : String(node.type);
  const parts = [type];
  if (node.enum !== undefined) parts.push(`[${(node.enum as unknown[]).map(String).join(', ')}]`);
  const bounds: string[] = [];
  for (const key of ['minimum', 'maximum', 'minLength', 'minItems', 'uniqueItems', 'pattern'] as const) {
    if (node[key] !== undefined) bounds.push(`${key}=${JSON.stringify(node[key])}`);
  }
  if (bounds.length > 0) parts.push(`{${bounds.join(', ')}}`);
  parts.push(...flags);
  return parts.join(' ');
}

function flatten(rawNode: Node, at: string, flags: string[], lines: string[]): void {
  const node = resolve(rawNode);
  for (const key of Object.keys(node)) {
    if (!KNOWN.has(key))
      throw new Error(
        `values.schema.json: "${key}" at ${at || '(root)'} is a keyword this contract does not flatten; teach test/contracts/helm-values.test.ts`,
      );
  }
  const own = [...flags];
  if (node.additionalProperties === false) own.push('(additionalProperties:false)');
  else if (node.additionalProperties !== undefined && typeof node.additionalProperties === 'object') own.push('(additionalProperties:*)');
  const properties = (node.properties ?? {}) as Record<string, Node>;
  const required = (node.required ?? []) as string[];
  const unlisted = required.filter((name) => !(name in properties));
  if (unlisted.length > 0) own.push(`(requires: ${[...unlisted].sort().join(', ')})`);
  if (at !== '') lines.push(`${at}: ${describeNode(node, own)}`);

  for (const [name, child] of Object.entries(properties)) {
    flatten(child, at === '' ? name : `${at}.${name}`, required.includes(name) ? ['(required)'] : [], lines);
  }
  // The schema every other key of an open object must satisfy (`envSecret`'s entries, a string map's values) is a
  // node of its own, written as `<path>.*`, so what it requires and bounds is part of the contract too.
  if (node.additionalProperties !== undefined && typeof node.additionalProperties === 'object') {
    flatten(node.additionalProperties as Node, at === '' ? '*' : `${at}.*`, [], lines);
  }
  if (node.items !== undefined) flatten(node.items as Node, `${at}[]`, [], lines);
  for (const [i, branch] of ((node.anyOf ?? []) as Node[]).entries()) flatten(branch, `${at}|anyOf[${i}]`, [], lines);
  if (node.not !== undefined) flatten(node.not as Node, `${at}|not`, [], lines);
  if (node.if !== undefined) flatten(node.if as Node, `${at}|if`, [], lines);
  if (node.then !== undefined) flatten(node.then as Node, `${at}|then`, [], lines);
}

describe('the Helm chart values are a contract', () => {
  it('matches the recorded keys, types, enums, bounds and required lists of values.schema.json', async () => {
    const lines: string[] = [];
    flatten(schema, '', [], lines);
    // The root object's own rules are not a path; its flags are the first line.
    const rootFlags = [
      ...(schema.additionalProperties === false ? ['(additionalProperties:false)'] : []),
      ...((schema.required as string[] | undefined)?.length ? [`(requires-at-root: ${[...(schema.required as string[])].sort().join(', ')})`] : []),
    ];
    // By path, so a node sits next to the lines of its children; a plain sort of the lines would put
    // `a.b` before `a` ('.' sorts below ':').
    const pathOf = (line: string): string => line.slice(0, line.indexOf(': '));
    const out = [`(root): ${describeNode(schema, rootFlags)}`, ...lines].sort((a, b) => (pathOf(a) < pathOf(b) ? -1 : pathOf(a) > pathOf(b) ? 1 : 0));

    // Guard the walk itself: one that silently produced nothing would record itself as the contract.
    expect(out.length).toBeGreaterThan(150);
    expect(new Set(out).size).toBe(out.length);
    for (const expected of ['image.repository', 'database.url', 'metrics.serviceMonitor.enabled']) {
      expect(
        out.some((line) => line.startsWith(`${expected}:`)),
        expected,
      ).toBe(true);
    }
    // No `replicaCount`: the chart does not offer the key at all (ADR-0078).
    expect(out.some((line) => line.startsWith('replicaCount'))).toBe(false);

    await expect(`${out.join('\n')}\n`).toMatchFileSnapshot(SNAPSHOT);
  });
});
