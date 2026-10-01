import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
