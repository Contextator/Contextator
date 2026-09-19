import { appendFileSync, readFileSync } from 'node:fs';

import { createProductRepo, createSignatureStore } from './github.js';
import { DEFAULT_CONFIG, runGate, type GateOutcome } from './run.js';

/**
 * What `.github/workflows/cla.yml` actually runs ([ADR-0061](../../../.ssot/ADR.md#adr-0061)).
 *
 * It is a separate file from `run.ts` for one reason: `run.ts` is unit-tested end to end, and a module
 * that reads the environment and calls `process.exit` at import time cannot be. Everything here is
 * environment, construction and the exit code; there is no decision in it.
 *
 * The event arrives as the JSON file Actions writes to `GITHUB_EVENT_PATH`, never as an interpolated
 * `${{ }}` expression. A pull request title, a branch name and a comment body are all text a stranger
 * chooses, and the only safe thing to do with such text is to read it out of a file as data.
 */

/** Where the record lives, and why it is not in this repository: see `CONTRIBUTING.md`. */
const SIGNATURES_OWNER = 'Contextator';
const SIGNATURES_REPO = 'cla-signatures';
const SIGNATURES_PATH = 'signatures/v1/cla.json';
/**
 * Unprotected by necessity — the gate commits straight to it — which is the second reason the record
 * is not kept here: `main` in this repository requires a check a bot commit could not satisfy.
 */
const SIGNATURES_BRANCH = 'main';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

function report(outcome: GateOutcome): void {
  for (const line of outcome.lines) process.stdout.write(`${line}\n`);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === '') return;
  const heading = outcome.passed ? '## Licence grant: signed' : '## Licence grant: not signed';
  appendFileSync(summaryPath, `${heading}\n\n${outcome.lines.map((line) => `- ${line}\n`).join('')}\n`);
}

const [owner, repo] = required('GITHUB_REPOSITORY').split('/');
if (owner === undefined || repo === undefined) throw new Error('GITHUB_REPOSITORY is not "owner/repo"');

const githubToken = required('GITHUB_TOKEN');
const signaturesToken = required('CLA_SIGNATURES_TOKEN');
const eventName = required('GITHUB_EVENT_NAME');
const event: unknown = JSON.parse(readFileSync(required('GITHUB_EVENT_PATH'), 'utf8'));

let outcome: GateOutcome;
try {
  outcome = await runGate({
    eventName,
    event,
    product: createProductRepo(githubToken, owner, repo),
    store: createSignatureStore(signaturesToken, SIGNATURES_OWNER, SIGNATURES_REPO, SIGNATURES_PATH, SIGNATURES_BRANCH),
    config: DEFAULT_CONFIG,
    log: (line) => process.stdout.write(`${line}\n`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
} catch (err) {
  // Every failure here is a red check, and deliberately so. This gate protects a position that cannot
  // be recovered once it is lost — a contribution merged without a grant permanently removes the
  // ability to licence that code commercially — so "the API was unreachable" and "nobody signed" get
  // the same answer. A gate that opens when it is broken is not a gate.
  process.stderr.write(`\nThe licence gate could not reach a verdict: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

report(outcome);
process.exit(outcome.passed ? 0 : 1);
