import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The `eval` job in `.github/workflows/ci.yml` decides from the changed paths whether a pull request can
 * have moved retrieval, and skips a 470 MB model download when it cannot. The filter began as
 * `src/services/`, `eval/` and `scripts/eval`, which is the code that *looks* like retrieval, and the
 * harness imports more than that: a change to `src/config.ts` or to the schema changes what the eval
 * measures and used to merge without the eval ever running.
 *
 * This test closes the gap mechanically. It reads the pattern out of the workflow, follows the relative
 * imports of both eval entry points recursively, and asserts that every file reached is one the pattern
 * matches. A new import in `scripts/eval*.ts` that lands outside the filter fails here, in the unit
 * suite, rather than silently shrinking the gate.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY_POINTS = ['scripts/eval.ts', 'scripts/eval-external.ts'];

/** The ERE the "Does this change touch retrieval?" step hands to `grep -qE`. */
function filterPattern(): RegExp {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const step = workflow.indexOf('Does this change touch retrieval?');
  expect(step, 'the retrieval filter step is gone from ci.yml').toBeGreaterThan(-1);
  const found = /grep -qE '(\^\([^']+\))'/.exec(workflow.slice(step));
  expect(found, 'no `grep -qE` pattern in the retrieval filter step').not.toBeNull();
  // The pattern is a plain alternation of anchored literals, which means the same in ERE and in JS.
  return new RegExp((found as RegExpExecArray)[1] as string);
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g;

/** `./x.js` is written, `./x.ts` or `./x/index.ts` is on disk. */
function resolveImport(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every file the entry points reach through relative imports (type-only ones too: they are part of the closure the harness compiles). */
function importClosure(entries: string[]): { files: string[]; unresolved: string[] } {
  const seen = new Set<string>();
  const unresolved: string[] = [];
  const queue = entries.map((entry) => path.join(ROOT, entry));
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const specifier = match[1] as string;
      const target = resolveImport(file, specifier);
      if (target) queue.push(target);
      else unresolved.push(`${path.relative(ROOT, file)} -> ${specifier}`);
    }
  }
  return { files: [...seen].map((file) => path.relative(ROOT, file)).sort(), unresolved };
}

describe('the eval job path filter in ci.yml', () => {
  const closure = importClosure(ENTRY_POINTS);

  it('can resolve every relative import of the eval harness', () => {
    expect(closure.unresolved).toEqual([]);
  });

  it('reaches the harness files it is meant to protect', () => {
    // A guard on the walker itself: an empty or truncated closure would make the next test pass for nothing.
    expect(closure.files).toEqual(
      expect.arrayContaining([...ENTRY_POINTS, 'src/services/eval-scoring.ts', 'src/config.ts', 'src/services/search.ts']),
    );
  });

  it('matches every file the harness imports, directly or through another file', () => {
    const filter = filterPattern();
    const uncovered = closure.files.filter((file) => !filter.test(file));
    expect(
      uncovered,
      `these files are imported by scripts/eval*.ts but a change to them does not start the eval job: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('starts the eval job for a pull request that changes only src/config.ts', () => {
    expect(filterPattern().test('src/config.ts')).toBe(true);
  });

  it('starts the eval job for a dependency or migration change (D3)', () => {
    const filter = filterPattern();
    for (const file of ['drizzle/x.sql', 'drizzle/meta/_journal.json', 'package.json', 'package-lock.json']) {
      expect(filter.test(file), file).toBe(true);
    }
    // Only the repository root's manifests: a nested one is somebody else's.
    expect(filter.test('charts/contextator/package.json')).toBe(false);
    expect(filter.test('docs/demo/package-lock.json')).toBe(false);
  });

  it('still lets a change with nothing to do with retrieval skip the job', () => {
    const filter = filterPattern();
    for (const file of [
      'README.md',
      'docs/configuration.md',
      'CHANGELOG.md',
      'charts/contextator/README.md',
      'public/app.js',
      'src/admin/routes.ts',
    ]) {
      expect(filter.test(file), file).toBe(false);
    }
  });
});
