import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseArgs } from '../scripts/eval.js';

/**
 * `npm run eval`'s command line. The default invocation has to stay exactly the repository's own set —
 * `eval/BASELINE.md` and the CI gate are numbers about it — and the new flags have to be unable to
 * half-apply: a corpus without its questions, or a project with a directory beside it, is refused.
 */

const CWD = '/work/docs';

describe('eval command line', () => {
  it('defaults to the repository corpus, golden file and negative file', () => {
    const o = parseArgs([], CWD);
    expect(o.corpusDir.endsWith(path.join('eval', 'corpus'))).toBe(true);
    expect(o.goldenPath.endsWith(path.join('eval', 'golden.jsonl'))).toBe(true);
    expect(o.negativePath?.endsWith(path.join('eval', 'negative.jsonl'))).toBe(true);
    expect(o.project).toBeNull();
    expect(o.customSet).toBe(false);
  });

  it('naming the default paths explicitly selects the same files as naming nothing', () => {
    const none = parseArgs([], CWD);
    const named = parseArgs(['--corpus', none.corpusDir, '--golden', none.goldenPath], CWD);
    expect(named.corpusDir).toBe(none.corpusDir);
    expect(named.goldenPath).toBe(none.goldenPath);
    // It is the same run, so it keeps the refusal set and the report title too.
    expect(named.negativePath).toBe(none.negativePath);
    expect(named.customSet).toBe(false);
    expect(parseArgs(['--corpus', none.corpusDir], CWD).customSet).toBe(false);
  });

  it('takes a value as "--flag value" or "--flag=value" and resolves it against the working directory', () => {
    const spaced = parseArgs(['--corpus', 'pages', '--golden', 'q.jsonl'], CWD);
    const equals = parseArgs(['--corpus=pages', '--golden=q.jsonl'], CWD);
    expect(spaced).toEqual(equals);
    expect(spaced.corpusDir).toBe('/work/docs/pages');
    expect(spaced.goldenPath).toBe('/work/docs/q.jsonl');
    expect(spaced.customSet).toBe(true);
  });

  it('drops the repository negative set for a corpus of its own, and takes one when it is named', () => {
    expect(parseArgs(['--corpus', 'pages', '--golden', 'q.jsonl'], CWD).negativePath).toBeNull();
    expect(parseArgs(['--golden', 'q.jsonl'], CWD).negativePath).toBeNull();
    expect(parseArgs(['--corpus', 'pages', '--golden', 'q.jsonl', '--negative', 'n.jsonl'], CWD).negativePath).toBe('/work/docs/n.jsonl');
  });

  it('reads --project, which takes no negative file unless one is named', () => {
    const o = parseArgs(['--project', 'handbook'], CWD);
    expect(o.project).toBe('handbook');
    expect(o.negativePath).toBeNull();
    expect(o.customSet).toBe(true);
    expect(parseArgs(['--project=handbook', '--negative', 'n.jsonl'], CWD).negativePath).toBe('/work/docs/n.jsonl');
  });

  it('refuses --project beside --corpus or --golden', () => {
    expect(() => parseArgs(['--project', 'p', '--corpus', 'pages'], CWD)).toThrow(/cannot be combined/);
    expect(() => parseArgs(['--golden', 'q.jsonl', '--project', 'p'], CWD)).toThrow(/cannot be combined/);
  });

  it('refuses a value flag with no value rather than swallowing the next flag', () => {
    expect(() => parseArgs(['--corpus'], CWD)).toThrow(/takes a value/);
    expect(() => parseArgs(['--corpus', '--json'], CWD)).toThrow(/takes a value/);
    expect(() => parseArgs(['--golden='], CWD)).toThrow(/takes a value/);
  });

  it('keeps the output and gate flags as they were', () => {
    const o = parseArgs(['--json=out.json', '--markdown', '--min-recall5=0.8'], CWD);
    expect(o.outputs).toEqual([
      { format: 'json', file: 'out.json' },
      { format: 'markdown', file: null },
    ]);
    expect(o.floors.recall5).toBe(0.8);
    expect(() => parseArgs(['--min-recall5=80'], CWD)).toThrow(/between 0 and 1/);
    expect(() => parseArgs(['--nope'], CWD)).toThrow(/Unknown option/);
  });
});
