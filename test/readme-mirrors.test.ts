import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProductFacts } from '../scripts/build-product-facts.js';

/**
 * `README.md` is the only copy of two destructive procedures — the backup and restore of ADR-0072,
 * and the PostgreSQL major-version upgrade ([ADR-0073](../.ssot/ADR.md) as amended by ADR-0074).
 * There are no mirrors left: the wiki, the documentation site and `.ssot/OPERATIONS.md` link to the
 * README instead of repeating the commands.
 *
 * A mirror is a copy of a command that overwrites a live database, and a copy is a command nobody
 * reviewed when the source changes. So this file guards the absence of *declared* mirrors. It does
 * NOT detect an unmarked copy — someone pasting the restore block into a wiki or site page without a
 * marker passes. That is caught in review, not here:
 *
 *  1. **No `MIRRORED-IN` / `MIRRORED-FROM` marker may appear** in the README, in `.ssot/OPERATIONS.md`,
 *     or in any Markdown file of the wiki and site checkouts. If one appears, a mirror was added — the
 *     way to a green run is to remove it and link to the README, or to take it to a new ADR and
 *     restore the byte-identity comparison from git history, not to loosen this number.
 *  2. **`EXPECTED` is pinned to 0.** Raising it is a decision to write down in the commit.
 *
 * WHAT THIS CANNOT BE: the wiki, the site and `.ssot` are **separate checkouts**, so this cannot be a
 * gate that always runs. It scans the ones that are present and says plainly, as a `todo`, which are
 * not — a skip in a summary line reads as a pass.
 */

const REPO = path.join(__dirname, '..');
const readme = readFileSync(path.join(REPO, 'README.md'), 'utf8');

/** The number of mirrors README.md declares. Zero on purpose; see point 2 above. */
const EXPECTED = { regions: 0 } as const;

const MARKER = /<!--\s*\/?MIRRORED-(IN|FROM)\b/g;
const SOURCE_REGION = /<!--\s*MIRRORED-IN\s+([\w-]+):/g;

/** Sibling checkouts, tried at both the ordinary-clone depth and the git-worktree depth. */
const CHECKOUTS: Array<{ name: string; relative: string; kind: 'file' | 'dir' }> = [
  { name: '.ssot/OPERATIONS.md', relative: '.ssot/OPERATIONS.md', kind: 'file' },
  { name: 'wiki', relative: 'wiki', kind: 'dir' },
  { name: 'contextator.com docs', relative: 'contextator.com/src/content/docs', kind: 'dir' },
];

function locate(relative: string): string | null {
  for (const base of [REPO, path.join(REPO, '..')]) {
    const candidate = path.resolve(base, relative);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function markdownFiles(target: string): string[] {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules') return [];
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

describe('README mirrors', () => {
  it('declares no mirror regions, and the pinned count says so', () => {
    const regions = [...readme.matchAll(SOURCE_REGION)].map((m) => m[1]);
    expect(
      regions.length,
      'a MIRRORED-IN region appeared in README.md — a mirror of a destructive command was added; link to the README instead',
    ).toBe(EXPECTED.regions);
    expect((readme.match(MARKER) ?? []).length, 'a mirror marker is left in README.md').toBe(0);
  });

  for (const checkout of CHECKOUTS) {
    const target = locate(checkout.relative);
    if (target === null) {
      it.todo(`${checkout.name} — checkout not present, absence of mirrors NOT verified in this run`);
      continue;
    }
    it(`${checkout.name} carries no mirror marker`, () => {
      for (const file of markdownFiles(target)) {
        const hits = readFileSync(file, 'utf8').match(MARKER) ?? [];
        expect(hits.length, `${file} carries a MIRRORED marker — a copy of the README's destructive commands; replace it with a link`).toBe(0);
      }
    });
  }
});

/**
 * The README states two defaults that `public/product-facts.json` publishes as facts (ADR-0114): the
 * auth mode a new project is born with and the address the port is published on. The site checks its
 * own prose against the same facts in its repository; this is the same bond for the README, so that
 * changing `DEFAULT_MCP_AUTH` or the compose bind address cannot leave the README promising the old
 * behaviour.
 */
describe('README default auth and bind address', () => {
  const facts = buildProductFacts();

  it('says a new project starts with the auth mode the schema defaults to', () => {
    const phrases: Record<string, RegExp> = {
      token: /A new project requires a \*\*bearer token\*\*/,
      account: /A new project requires an? \*\*account\*\*/,
      open: /A new project is \*\*open\*\*/,
    };
    const expected = phrases[facts.defaultMcpAuth];
    expect(expected, `no README phrasing is known for the default mode "${facts.defaultMcpAuth}"; teach this test the new sentence`).toBeDefined();
    expect(readme, `README no longer states that a new project starts as "${facts.defaultMcpAuth}"`).toMatch(expected);
  });

  it('says the port is published on the default bind address and on no other', () => {
    expect(readme, 'README no longer states the published address').toContain(`**The port is published on \`${facts.defaultBindAddress}\` only.**`);
    const published = [...readme.matchAll(/-p\s+([\d.]+):\d+:3444/g)].map((m) => m[1]);
    expect(published.length, 'README has no `docker run -p <address>:<port>:3444` example to check').toBeGreaterThan(0);
    for (const address of published) expect(address, 'a README `docker run -p` example publishes on another address than the compose files').toBe(facts.defaultBindAddress);
  });
});
