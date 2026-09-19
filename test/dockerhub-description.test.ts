import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `DOCKERHUB.md` is a second copy of part of the README, pushed to Docker Hub by
 * `.github/workflows/dockerhub-description.yml` on every change to it. A second copy drifts the way
 * `drizzle/*.sql` drifted from `src/db/schema.ts` before `npm run db:check` existed (ADR-0033) — the
 * three assertions below are that gate for this file.
 */
const dockerhubMd = readFileSync(path.join(__dirname, '..', 'DOCKERHUB.md'), 'utf8');
const dockerhubDescriptionWorkflow = readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'dockerhub-description.yml'), 'utf8');

describe('DOCKERHUB.md', () => {
  it("fits Docker Hub's full description limit", () => {
    // 25,000 characters is the documented ceiling. Going over it does not fail the push — Docker Hub
    // truncates silently — so this is the only place that limit is enforced at all.
    expect(dockerhubMd.length).toBeLessThan(25_000);
  });

  it('has no relative markdown link', () => {
    // Docker Hub renders this file on its own domain, with no knowledge of the repository's file
    // tree: a link written `](./README.md)` or `](../LICENSE)` resolves against docker.com and 404s.
    // Every link target must be an absolute URL or an in-page anchor.
    const relativeLink = /]\((?!https?:\/\/|#)[^)]*\)/;
    const match = dockerhubMd.match(relativeLink);
    expect(match, `found relative link: ${match?.[0]}`).toBeNull();
  });

  it('names the image it describes', () => {
    // If the Docker Hub repository is ever renamed, this file's `docker run`/`docker pull` examples
    // have to move with it — this assertion is the reminder.
    expect(dockerhubMd).toContain('contextator/contextator');
  });
});

describe('dockerhub-description.yml short-description', () => {
  it("fits Docker Hub's 100-character limit", () => {
    // Nothing on the Docker Hub side enforces this — a longer value is accepted and truncated
    // silently on the repository page, the same failure mode `DOCKERHUB.md`'s own length assertion
    // above exists to catch. This is that gate for the one-line `short-description` input, read out
    // of the workflow rather than duplicated into a second source of truth.
    const match = dockerhubDescriptionWorkflow.match(/short-description:\s*"([^"]*)"/);
    expect(match, 'short-description input not found in dockerhub-description.yml').not.toBeNull();
    const shortDescription = match?.[1] ?? '';
    expect(shortDescription.length, `"${shortDescription}" (${shortDescription.length} chars)`).toBeLessThanOrEqual(100);
  });
});
