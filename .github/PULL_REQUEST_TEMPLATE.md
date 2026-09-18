<!--
Thanks for the change. CONTRIBUTING.md has the long version of everything below.
Delete any line that does not apply — a short, honest description beats a filled-in form.
-->

## What this changes, and why

<!-- What was wrong or missing, what this does about it, and what you considered and rejected.
     The rejected alternatives are the part that is expensive to rediscover. -->

## Specification

<!-- One of these:
     - Implements FR-… / ADR-…
     - Changes observable behaviour and has no FR/ADR yet — described above so a maintainer can record
       one before this merges. (The specification repository is not public; see CONTRIBUTING.md.)
     - No observable behaviour changes (refactor, test, docs, dependency bump).            -->

## Checks

Run locally, all green:

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:integration` <!-- needs a container runtime; say so if you could not run it -->
- [ ] `npm run db:check` — only if `src/db/schema.ts` or `drizzle/` changed

## Does this change a documented claim?

<!-- The README, .env.example, the configuration table, the API table and SECURITY.md go stale silently.
     Name anything this change makes false, and fix it in this pull request — or say "no" and mean it. -->

## Licence grant

<!-- First contribution? CONTRIBUTING.md explains why this is asked and CLA.md is the text.
     A maintainer will ask here before merging. -->
