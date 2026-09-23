import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `README.md` is the source for two destructive procedures — the backup and restore of ADR-0072, and
 * the PostgreSQL major-version upgrade — and three other documents carry mirrors of them
 * ([ADR-0073](../.ssot/ADR.md) as amended by ADR-0074). A mirror exists where the source cannot be
 * reached by the audience that needs it: the wiki is the only published documentation until this
 * branch merges, and `.ssot/OPERATIONS.md` is the operations record a maintainer reads.
 *
 * ADR-0074 promised the person editing the README a written list of what else to change. A list is
 * itself a claim, so this file measures it — and measures it in the three ways a list goes wrong:
 *
 *  1. **The copies drift.** Every shell block in a bracketed region has to appear, byte for byte, in
 *     every file the region names.
 *  2. **A mirror grows something the source does not have.** The comparison is an equality of block
 *     lists, not a subset test — a `docker volume rm -f` added to the wiki and to nowhere else is a
 *     destructive command nobody reviewed, and it used to pass.
 *  3. **The list gets shorter.** Region count and per-region mirror counts are pinned to numbers, and
 *     a named file that is not there when its checkout is fails instead of being skipped. A test that
 *     goes quiet as its subject disappears is the failure mode this repository keeps finding, and it
 *     would be absurd for the file that exists to catch it to have it.
 *
 * WHAT THIS CANNOT BE, and it is worth being plain about: the wiki and `.ssot` are **separate
 * repositories**, so this cannot be a gate that always runs. It runs for whoever has the checkouts —
 * which is whoever can edit them — and when a checkout is genuinely absent it says so as a `todo`
 * rather than as a pass. Absent checkout and misspelt path are different things and are reported
 * differently; that distinction is the whole of point 3.
 */

const REPO = path.join(__dirname, '..');
const readme = readFileSync(path.join(REPO, 'README.md'), 'utf8');

/**
 * What this README claims, pinned. These two numbers are the list's own length, and they are the
 * assertion that deleting a marker pair — the quickest way to make a red run go green — is itself red.
 */
const EXPECTED = { regions: 2, mirrors: { 'backup-and-restore': 2, 'postgres-major-upgrade': 1 } } as const;

/** `<!-- MIRRORED-IN <id>: <path> <path> -->` … `<!-- /MIRRORED-IN -->` in the source. */
const SOURCE_REGION = /<!--\s*MIRRORED-IN\s+([\w-]+):\s*([^>]*?)\s*-->([\s\S]*?)<!--\s*\/MIRRORED-IN\s*-->/g;
/** `<!-- MIRRORED-FROM <id>: … -->` … `<!-- /MIRRORED-FROM -->` in a mirror. Several per file is fine. */
const mirrorRegion = (id: string) => new RegExp(`<!--\\s*MIRRORED-FROM\\s+${id}:[^>]*-->([\\s\\S]*?)<!--\\s*/MIRRORED-FROM\\s*-->`, 'g');

const shellBlocks = (text: string): string[] => [...text.matchAll(/```bash\n[\s\S]*?\n```/g)].map((m) => m[0]);

const regions = [...readme.matchAll(SOURCE_REGION)].map((m) => ({
  id: m[1],
  targets: m[2].split(/\s+/).filter(Boolean),
  blocks: shellBlocks(m[3]),
}));

/** An opened region that is never closed matches nothing above, so it would vanish rather than fail. */
const openers = (readme.match(/<!--\s*MIRRORED-IN\s/g) ?? []).length;

/**
 * Where a mirror lives, and whether its repository is checked out at all.
 *
 * A marker's path is relative to the repository root on an ordinary clone (`…/Contextator`, `…/wiki`
 * and `…/.ssot` as siblings). A git worktree puts the repository somewhere else — `…/.worktrees/x` —
 * and the sibling is then one level further up, so both bases are tried rather than one being declared
 * the right layout. `checkoutPresent` is the parent directory: if that is there and the file is not,
 * the path in the README is wrong and that is a failure, not a skip.
 */
function locate(relative: string): { file: string | null; checkoutPresent: boolean } {
  let checkoutPresent = false;
  for (const base of [REPO, path.join(REPO, '..')]) {
    const candidate = path.resolve(base, relative);
    if (existsSync(candidate)) return { file: candidate, checkoutPresent: true };
    if (existsSync(path.dirname(candidate))) checkoutPresent = true;
  }
  return { file: null, checkoutPresent };
}

describe('README mirrors', () => {
  it('still claims as many mirrors as it did when this was written', () => {
    expect(openers, 'a MIRRORED-IN region is opened and never closed').toBe(regions.length);
    expect(
      regions.map((r) => r.id).sort(),
      'a MIRRORED-IN region was removed or renamed — if that is deliberate, change EXPECTED and say why in the commit',
    ).toEqual(Object.keys(EXPECTED.mirrors).sort());
    expect(regions.length).toBe(EXPECTED.regions);
    for (const region of regions) {
      expect(region.blocks.length, `the region ${region.id} holds no shell block`).toBeGreaterThan(0);
      expect(region.targets.length, `${region.id} lost a mirror from its list`).toBe(EXPECTED.mirrors[region.id as keyof typeof EXPECTED.mirrors]);
    }
  });

  for (const region of regions) {
    for (const [n, target] of region.targets.entries()) {
      const { file, checkoutPresent } = locate(target);
      const name = `${region.id} → mirror ${n + 1} (${target})`;

      if (file === null && !checkoutPresent) {
        // Not `it.skip`: a skip in a summary line reads as a pass. This states the reason.
        it.todo(`${name} — checkout not present, byte-identity NOT verified in this run`);
        continue;
      }

      it(`${name} — carries exactly the source's blocks, in order`, () => {
        expect(file, `${target} is named by README.md but is not there — fix the path, or drop the mirror on purpose`).not.toBeNull();
        const text = readFileSync(file as string, 'utf8');
        const claimed = [...text.matchAll(mirrorRegion(region.id))].flatMap((m) => shellBlocks(m[1]));
        expect(claimed.length, `${target} has no MIRRORED-FROM ${region.id} region — the mirror stopped declaring itself`).toBeGreaterThan(0);
        // Equality, not inclusion: this is what catches a block the mirror grew on its own.
        expect(
          claimed,
          `${target} does not carry exactly the blocks README.md marks as mirrored.\nThe README is the source: change it there, then copy across.`,
        ).toEqual(region.blocks);
      });
    }
  }
});
