import { createHash } from 'node:crypto';
import type { QuestionPath, RepeatedQuestion } from './query-summary.js';

/**
 * What an operator's agents asked, in the evaluation harness's own JSONL shape
 * ([ADR-0050](../../.ssot/ADR.md#adr-0050)).
 *
 * **This is the honest half of an item that promised something undeliverable.**
 * [ROADMAP.md](../../.ssot/ROADMAP.md) Item 6 said the frequent real questions would be fed back into
 * `eval/golden.jsonl` and the harness would stop being synthetic. It cannot be: `eval/corpus/` is a
 * fictional product, and an operator's questions are about *their* corpus, naming answers that live in
 * documents this repository will never hold. What ships instead is the export — the operator builds a
 * golden set for their own corpus, out of what their own agents actually asked.
 *
 * ### The shape, and the cost that was chosen
 *
 * `scripts/eval-scoring.ts` validates a golden row with a **`z.strictObject`**: `id`, `lang`, `query`
 * and `expectFile` are required, `expectHeading`, `tags` and `note` optional, and any key the schema
 * does not name is rejected. An exported question has **no `expectFile`** — which document *should*
 * have answered it is a human judgement and the one thing the log cannot know — and no `lang`, because
 * nothing in this product detects the language of a query and a guessed one would quietly land the
 * question in the wrong half of the per-language split.
 *
 * So the file this emits is **the harness's shape with two holes in it, and it fails validation until
 * a person has filled them**. That is deliberate, and it is the cheaper of the two costs:
 *
 * - The failure is loud, positional and complete. `parseGoldenSet` throws on the first bad line with
 *   `golden.jsonl:<n>: …`, `npm run eval` exits **1** — "this run measured nothing", which is a
 *   different code from the **2** a missed floor exits with — and the operator fixes that line and
 *   runs again. A question set that silently shrinks is the one failure mode the harness refuses to
 *   have; a file that refuses to load until it is complete is that discipline pointed at the export.
 * - The alternative — a distinct "candidate" shape carrying the returned documents as structured
 *   fields — buys a file that parses as *something*, at the price of a shape that is not the
 *   harness's and a conversion step between the two. It also cannot be smuggled into the golden shape,
 *   because `strictObject` rejects the extra key.
 *
 * **What the candidate shape was for is kept, inside `note`.** The schema's own optional free-text
 * field, which the scorer ignores, carries how often the question was asked, how badly it was
 * answered, and the documents the search *did* return — so the person filling in `expectFile` is
 * choosing from what the corpus already offered rather than re-running the search by hand. `note` is
 * prose and not structure, and that is exactly the trade `strictObject` forces.
 */

/** `tags` and `expectHeading` are left to the operator too; only these three are ever emitted. */
export interface ExportedQuestion {
  id: string;
  query: string;
  note: string;
}

/**
 * A stable id for a question, derived from its normalised text.
 *
 * Stable matters: golden ids "are never renumbered" because they appear in the miss list and in
 * diffs, so exporting the same question next month has to produce the same id or a growing set
 * acquires duplicates of its own questions under new names. Twelve hex characters after `q-`, which
 * satisfies the harness's `^[a-z0-9][a-z0-9-]*$`.
 */
export function questionId(queryNorm: string, taken: ReadonlySet<string> = new Set()): string {
  const digest = createHash('sha256').update(queryNorm).digest('hex');
  for (let length = 12; length <= digest.length; length += 4) {
    const candidate = `q-${digest.slice(0, length)}`;
    if (!taken.has(candidate)) return candidate;
  }
  /* c8 ignore next -- two identical sha256 digests; unreachable short of a break in the hash */
  return `q-${digest}`;
}

const score = (value: number | null): string => (value === null ? 'nothing came back' : value.toFixed(3));

const day = (iso: string): string => iso.slice(0, 10);

function paths(list: readonly QuestionPath[]): string {
  if (list.length === 0) return 'It returned nothing at all.';
  const parts = list.map((p) => `${p.relativePath}${p.headingPath ? ` > ${p.headingPath}` : ''} (${p.bestScore.toFixed(3)}, ${p.returned}x)`);
  return `It returned: ${parts.join('; ')}.`;
}

/**
 * The `note` of one exported row: what the log knows, and what the person has to decide.
 *
 * The closing sentence is the instruction, on **every** row rather than in a header, because a JSONL
 * file cannot carry a comment — `parseGoldenSet` reads a `#` line as "not valid JSON" — and because
 * rows get reordered and deleted, so an instruction that lived on one of them would not survive.
 */
export function exportNote(question: RepeatedQuestion): string {
  const askers =
    question.askers > 0
      ? `by ${question.askers} token${question.askers === 1 ? '' : 's'}${question.unattributed > 0 ? ` and ${question.unattributed} unattributed` : ''}`
      : 'with no token attribution (an open project verifies none)';
  return (
    `Asked ${question.asked}x ${askers} on ${question.days} day${question.days === 1 ? '' : 's'}, ` +
    `${day(question.firstAskedAt)} to ${day(question.lastAskedAt)}. Best match ever: ${score(question.bestScore)}. ` +
    `${paths(question.paths)} ` +
    'TODO: set "expectFile" to the document that should have answered this, and "lang" to "en" or "tr" — or delete this line.'
  );
}

/**
 * Turns the ranked questions into exported rows, in the order the panel shows them.
 *
 * The order is the point: the export is the panel's ordering written to a file, so the questions a
 * golden set most wants are the ones at the top of it, and an operator who takes the first twenty
 * lines has taken the twenty the panel argued for.
 */
export function buildExport(questions: readonly RepeatedQuestion[]): ExportedQuestion[] {
  const taken = new Set<string>();
  return questions.map((question) => {
    const id = questionId(question.queryNorm, taken);
    taken.add(id);
    // The raw spelling somebody typed, not the normalised fold: a golden question is read by people.
    return { id, query: question.sample, note: exportNote(question) };
  });
}

/**
 * One JSON object per line, which is what the harness reads. The key order is the schema's own, so a
 * diff of two exports is a diff of the questions rather than of the serialiser.
 */
export function toJsonl(rows: readonly ExportedQuestion[]): string {
  return rows.map((row) => JSON.stringify({ id: row.id, query: row.query, note: row.note })).join('\n') + (rows.length > 0 ? '\n' : '');
}
