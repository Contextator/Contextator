import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `README.md` is the source for two destructive procedures — the backup and restore of ADR-0072, and
 * the PostgreSQL major-version upgrade — and `wiki/Backup-and-Data.md` carries a mirror of both
 * ([ADR-0073](../.ssot/ADR.md) as amended by ADR-0074). The mirror exists because the wiki is the only
 * published documentation until the README's branch merges, and an operator whose cluster will not
 * start cannot be sent to a page they cannot reach.
 *
 * ADR-0074 promised the person editing the README a written list of what else to change, and a list is
 * itself a claim. This file measures it: every shell block the README marks as mirrored has to appear,
 * byte for byte, in the file the marker names.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE OTHER GATES IN THIS REPOSITORY, and it is worth being plain about:
 * the wiki is a **separate repository**, so this cannot be a gate that always runs. It runs for the
 * person who has both checkouts — which is exactly the person who can edit both — and it says, out
 * loud, when it did not. A check that silently passed because it found nothing to read would be worse
 * than no check, because the green would mean two different things.
 */

const REPO = path.join(__dirname, '..');
const readme = readFileSync(path.join(REPO, 'README.md'), 'utf8');

/**
 * The README brackets a mirrored region between `<!-- MIRRORED-IN: <path> -->` and `<!-- /MIRRORED-IN -->`.
 *
 * A bracket rather than a heading, because "everything until the next heading" is not what is
 * mirrored: the backup section's `psql` / `pg_dump` block is deliberately not, and the first version
 * of this file failed on it. Where a region begins and ends is the author's statement, made where the
 * editing happens, and this file only measures the statement.
 */
const REGION = /<!--\s*MIRRORED-IN:\s*(\S+)\s*-->([\s\S]*?)<!--\s*\/MIRRORED-IN\s*-->/g;

/**
 * Where the wiki checkout is, or `null`.
 *
 * The marker's path is relative to the repository root on an ordinary clone (`…/Contextator` and
 * `…/wiki` as siblings). A git worktree puts the repository somewhere else entirely — `…/.worktrees/x`
 * — and the sibling is then one level further up, so both are tried rather than one being declared the
 * right layout.
 */
function resolveMirror(relative: string): string | null {
	for (const base of [REPO, path.join(REPO, '..')]) {
		const candidate = path.resolve(base, relative);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Every ```bash … ``` block inside one bracketed region. */
const shellBlocks = (region: string): string[] => [...region.matchAll(/```bash\n[\s\S]*?\n```/g)].map((m) => m[0]);

const regions = [...readme.matchAll(REGION)].map((m) => ({ target: m[1], blocks: shellBlocks(m[2]), index: m.index ?? 0 }));

/** An opened region that is never closed matches nothing above, so it would vanish silently. */
const openers = (readme.match(/<!--\s*MIRRORED-IN:/g) ?? []).length;

describe('README mirrors', () => {
	it('marks the blocks it says are mirrored', () => {
		// The floor under everything below: a list that has emptied itself passes every other
		// assertion in this file, so the count is asserted before the contents are — and an unclosed
		// region is an emptied list that still looks like a marked one.
		expect(regions.length, 'no <!-- MIRRORED-IN: … --> … <!-- /MIRRORED-IN --> region in README.md').toBeGreaterThan(0);
		expect(openers, 'a MIRRORED-IN region is opened and never closed').toBe(regions.length);
		for (const region of regions) {
			expect(region.blocks.length, `the region for ${region.target} holds no shell block`).toBeGreaterThan(0);
		}
	});

	for (const region of regions) {
		const resolved = resolveMirror(region.target);
		const where = `${region.target} (README char ${region.index})`;

		if (resolved === null) {
			// Not `it.skip`: a skip in a summary line is easy to read as a pass. This states the reason.
			it.todo(`${where} — mirror checkout not present, byte-identity NOT verified in this run`);
			continue;
		}

		it(`${where} — every mirrored shell block appears byte for byte`, () => {
			const mirror = readFileSync(resolved, 'utf8');
			const blocks = region.blocks;
			expect(blocks.length).toBeGreaterThan(0);
			for (const block of blocks) {
				const digest = createHash('md5').update(block).digest('hex').slice(0, 8);
				const firstLine = block.split('\n')[1] ?? '';
				expect(
					mirror.includes(block),
					`README block ${digest} ("${firstLine.slice(0, 60)}…") is not in ${region.target}.\n` +
						'The README is the source: copy the block across, do not edit it there.',
				).toBe(true);
			}
		});
	}
});
