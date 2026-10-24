import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { chunks, floorSuggestions, projects, type FloorSuggestionRow } from '../db/schema.js';
import { KeyedMutex, Semaphore } from './locks.js';
import { ConflictError, NotFoundError } from './projects.js';
import { belowRelevanceFloor } from './relevance.js';
import { type SearchDeps, searchProject } from './search.js';
import type { SearchHit } from './vector-store.js';

/**
 * Where a project's relevance floor should sit, measured rather than guessed
 * ([ADR-0042](../../.ssot/ADR.md#adr-0042), [ADR-0083](../../.ssot/ADR.md#adr-0083)).
 *
 * The arithmetic used to live only in `scripts/floor-calibration.ts`, where it was run by hand against
 * four reference corpora. It is here now so that the script and the product share one implementation
 * of "the highest floor that still answers every question the corpus answers", and so that an operator
 * can ask for that number for their own project — in particular right after a model change, when the
 * old floor means nothing (a cosine similarity is a number about one encoder, ADR-0037).
 *
 * **A suggestion is advice, and mostly an upper bound.** A probe is a fragment of the text it should find, so
 * it usually scores higher than a question a person writes about the same passage; measured against the floor
 * fitted from labelled questions, the product path came out within 0.013 of it on either side on the two prose
 * reference corpora and 0.03 to 0.045 above it on the two XQuAD ones, and two runs over one project can differ by
 * 0.018 because each samples other chunks (`scripts/floor-calibration.ts` prints the table). Check it with the
 * preview in both directions before applying it. Nothing here writes `projects.score_floor` except
 * {@link applyFloorSuggestion}, which only a manager's request reaches and which refuses a suggestion
 * measured against a different encoder or generation than the project now has.
 */

/** The grid the fit walks, in thousandths: below 0.6 no usable encoder separates anything, above 0.99 nothing is answered. */
export const FLOOR_GRID_MIN_MILLI = 600;
export const FLOOR_GRID_MAX_MILLI = 990;

/** Probes fewer than this say too little about a corpus to put a refusal rule on it. */
export const MIN_CALIBRATION_PROBES = 20;
/** The most probes one suggestion asks; each is an embedding and a search. */
export const MAX_CALIBRATION_PROBES = 100;

/** The page a probe is searched with — the page `scripts/eval.ts` and the calibration harnesses score, so their figures describe the same hits. */
export const CALIBRATION_SEARCH_LIMIT = 10;
/** Words kept from the end of the sampled sentence: enough to name a topic, too few to repeat the passage. */
export const PROBE_WORDS = 8;
/** A sentence shorter than this carries no topic of its own (a caption, a list stub). */
export const MIN_PROBE_SENTENCE_WORDS = 6;
/**
 * The same two limits for sentences with Han or Kana characters (Chinese, Japanese), where a sentence can be
 * one whitespace-separated "word" and counting words would reject it: weight stands in, a character
 * weighing 1 and a word of another script 2 (see `sentenceUnits`).
 */
export const PROBE_CHARS = 16;
export const MIN_PROBE_SENTENCE_CHARS = 12;
/** Chunks read to find {@link MAX_CALIBRATION_PROBES} usable probes; tables and code leave some without a sentence. */
const PROBE_CANDIDATE_CHUNKS = MAX_CALIBRATION_PROBES * 3;
/** Suggestions kept per project; the oldest are dropped when a new one is written. */
export const MAX_KEPT_SUGGESTIONS = 10;

/** One answerable question and what the search returned for it, with the floor off. */
export interface CalibrationSample {
  query: string;
  hits: readonly SearchHit[];
}

/** How many of these samples a floor would refuse — decided by {@link belowRelevanceFloor}, escape hatch included. */
export function refusedCount(samples: readonly CalibrationSample[], floor: number): number {
  return samples.filter((s) => belowRelevanceFloor(s.query, s.hits, floor)).length;
}

/**
 * The highest floor on a 0.001 grid that refuses at most `floor(n * allowedShare)` of the answerable
 * questions — "the floor this corpus would have asked for". `0` when even the bottom of the grid
 * refuses more than that allows.
 *
 * Refusals only ever grow with the floor, which is what lets the walk stop at the first floor that
 * refuses too many instead of scanning to the top.
 */
export function fitFloor(answerable: readonly CalibrationSample[], allowedShare = 0): number {
  const allowed = Math.floor(answerable.length * allowedShare);
  let best = 0;
  for (let milli = FLOOR_GRID_MIN_MILLI; milli <= FLOOR_GRID_MAX_MILLI; milli++) {
    const floor = milli / 1000;
    if (refusedCount(answerable, floor) <= allowed) best = floor;
    else break;
  }
  return best;
}

/** The distribution of the rank-1 cosine similarities, which is the number the floor reads. */
export interface TopScoreSummary {
  min: number;
  p05: number;
  median: number;
  max: number;
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** `null` when no sample returned a hit — then there is no distribution to describe. */
export function summariseTopScores(samples: readonly CalibrationSample[]): TopScoreSummary | null {
  const tops = samples
    .map((s) => s.hits[0]?.score)
    .filter((score): score is number => score !== undefined)
    .sort((a, b) => a - b);
  if (tops.length === 0) return null;
  return { min: tops[0], p05: quantile(tops, 0.05), median: quantile(tops, 0.5), max: tops[tops.length - 1] };
}

/** What a suggestion was reached from — stored beside it so a reader can judge it. */
export interface FloorSuggestionBasis {
  /** `sentences`: a few words of running prose taken from a section, asked as a question that section certainly answers. */
  method: 'sentences';
  probes: number;
  /** The share of answerable questions the suggested floor may refuse. `0` is "none of them". */
  allowedShare: number;
  topScores: TopScoreSummary | null;
  /** How many of the probes the project's floor at the time would have refused. */
  refusedAtPrevious: number | null;
}

export interface FloorSuggestionView {
  id: string;
  createdAt: string;
  trigger: 'model_change' | 'operator';
  embeddingModel: string;
  liveGeneration: number;
  suggestedFloor: number;
  previousFloor: number | null;
  basis: FloorSuggestionBasis;
  appliedAt: string | null;
}

function toView(row: FloorSuggestionRow): FloorSuggestionView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    trigger: row.trigger as FloorSuggestionView['trigger'],
    embeddingModel: row.embeddingModel,
    liveGeneration: row.liveGeneration,
    suggestedFloor: row.suggestedFloor,
    previousFloor: row.previousFloor,
    basis: row.basis as FloorSuggestionBasis,
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
  };
}

/**
 * Scripts whose words are not separated by spaces; Hangul is written with spaces and is counted in words. `ー`
 * (the long-vowel mark) belongs to Katakana words but has the Common script, so it is listed on its own.
 */
const UNSPACED_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u;

/**
 * The units a sentence with such text is measured in: each Han/Kana character, and each run of anything else
 * (a command, a product name, a number) as one unit that is never split. The East Asian punctuation that
 * stands between them is not a unit.
 */
const SENTENCE_UNIT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー、，；：（）「」『』【】《》〈〉・。！？]+/gu;

interface SentenceUnit {
  /** Where the unit starts in the sentence. */
  index: number;
  /** A Han/Kana character weighs 1, a whole word of another script 2: two characters to a word, as the limits assume. */
  weight: number;
}

/**
 * A sentence with any Han or Kana character is measured by unit weight instead of by whitespace-separated words:
 * technical text in these languages is full of Latin names glued to the characters around them
 * ("npm run migrateを実行して"), so the share of characters cannot decide which way to count, and a sentence
 * of three whitespace-separated "words" is not short. Hangul and the Latin script have spaces and keep the word count.
 * Other scripts written without spaces (Thai, Lao, Khmer, Burmese) are not recognised: such a sentence is one
 * "word" and is dropped, so a project written in them gets `insufficient_data`.
 */
function sentenceUnits(sentence: string): SentenceUnit[] | null {
  if (!UNSPACED_CHAR.test(sentence)) return null;
  return Array.from(sentence.matchAll(SENTENCE_UNIT), (match) => ({ index: match.index, weight: UNSPACED_CHAR.test(match[0]) ? 1 : 2 }));
}

function hasTopicOfItsOwn(sentence: string): boolean {
  const units = sentenceUnits(sentence);
  if (units) return units.reduce((total, unit) => total + unit.weight, 0) >= MIN_PROBE_SENTENCE_CHARS;
  return sentence.split(/\s+/).length >= MIN_PROBE_SENTENCE_WORDS;
}

/** The tail of a sentence measured in units: whole units from the end until they weigh {@link PROBE_CHARS}, so a word is never cut. */
function tailByWeight(sentence: string, units: readonly SentenceUnit[]): string {
  let weight = 0;
  let start = units.length;
  while (start > 0 && weight < PROBE_CHARS) {
    start--;
    weight += units[start].weight;
  }
  return sentence.slice(units[start].index).trim();
}

/**
 * The prose of a chunk as sentences: code fences, tables, headings, quotes and list markers are dropped,
 * links keep their text. Only sentences with a topic of their own stay ({@link MIN_PROBE_SENTENCE_WORDS}
 * words, or {@link MIN_PROBE_SENTENCE_CHARS} units of weight where the sentence has Han or Kana characters). A sentence ends at
 * `.`, `!` or `?` before whitespace, and at `。`, `！` or `？` wherever they stand: that text has no space to
 * look for.
 */
function proseSentences(content: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === '' || /^[|#>]/.test(line)) continue;
    lines.push(
      line
        .replace(/^([-*+]|\d+[.)])\s+/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`]/g, '')
        .trim(),
    );
  }
  return lines
    .join(' ')
    .split(/(?<=[.!?])\s+|(?<=[。！？])\s*/u)
    .map((sentence) => sentence.trim())
    .filter(hasTopicOfItsOwn);
}

/**
 * One probe from one chunk: the last {@link PROBE_WORDS} words of the chunk's middle sentence (the last
 * {@link PROBE_CHARS} units of weight where the sentence has Han or Kana characters), or `null` when the chunk has no
 * prose (a table, a code listing).
 *
 * The probe must not carry the chunk's breadcrumb. A chunk is embedded as "breadcrumb, blank line,
 * content", so a query built from the breadcrumb asks for the chunk's own prefix and scores far above
 * what a real question does — measured on the reference corpora, the headings version fitted 0.845
 * against 0.804 fitted from labelled questions. A fragment of the body has no such prefix to match.
 */
export function probeFromChunk(content: string): string | null {
  const sentences = proseSentences(content);
  if (sentences.length === 0) return null;
  const middle = sentences[Math.floor((sentences.length - 1) / 2)];
  const units = sentenceUnits(middle);
  if (units) return tailByWeight(middle, units);
  return middle.split(/\s+/).slice(-PROBE_WORDS).join(' ');
}

/**
 * The probes to ask: one fragment of prose per chunk of the live generation, over chunks taken in an
 * order fixed by their id's hash so that two runs over the same index ask the same probes. A passage
 * is the one thing its own fragment is certain to find, which makes it a usable stand-in for an
 * answerable question when nobody has labelled any. Duplicates are asked once.
 */
export async function calibrationQueries(db: Db, projectId: string, generation: number, limit = MAX_CALIBRATION_PROBES): Promise<string[]> {
  const rows = await db
    .select({ content: chunks.content })
    .from(chunks)
    .where(and(eq(chunks.projectId, projectId), eq(chunks.indexGeneration, generation)))
    .orderBy(sql`md5(${chunks.id}::text)`)
    .limit(Math.max(limit, PROBE_CANDIDATE_CHUNKS));
  const probes = new Set<string>();
  for (const row of rows) {
    const probe = probeFromChunk(row.content);
    if (probe !== null) probes.add(probe);
    if (probes.size >= limit) break;
  }
  return [...probes];
}

export type FloorSuggestionOutcome =
  | { status: 'created'; suggestion: FloorSuggestionView }
  | { status: 'project_gone' }
  /** Too few passages to measure from — the project is empty, or holds little but tables and code. */
  | { status: 'insufficient_data'; probes: number; required: number }
  /** Even the bottom of the grid would refuse an answerable question: no floor is suggested, because `0` is not advice. */
  | { status: 'no_fit'; probes: number }
  /** The project's chunks and this server's encoder are not in one space; the next run re-embeds them. */
  | { status: 'model_mismatch'; indexedWith: string; serverUses: string }
  | { status: 'not_indexed' }
  /** A measurement of this project is already running, or the server is already running its share of them. */
  | { status: 'busy'; reason: 'project' | 'server' };

/** How many projects may be measured at once: each probe is an embedding and a search, a hundred of them per run. */
export const MAX_CONCURRENT_MEASUREMENTS = 2;

/** One measurement per project (also a queue for the ones that wait), and a few across the server. */
const projectLocks = new KeyedMutex();
const serverSlots = new Semaphore(MAX_CONCURRENT_MEASUREMENTS);

/**
 * Measures the project with the floor off and stores the floor that would have answered every probe.
 *
 * A run is a hundred sequential searches, so an operator's request is refused (`busy`) rather than queued
 * when the project is already being measured or the server is already measuring its share: a repeated click
 * must not stack runs up behind the search path. The `model_change` trigger is the server's own, with nobody
 * to retry, and it fires once per project when its re-index ends; it waits its turn instead (the project's
 * lock, then a server slot) and so never returns `busy`. Otherwise a small project finishing behind two large
 * ones would be left with no suggestion at all.
 *
 * `deps.scoreFloor`, the query log and the metrics are deliberately left unset by the caller's
 * {@link SearchDeps}: the probes are the product asking itself, not an agent asking a question.
 */
export async function generateFloorSuggestion(
  deps: Pick<SearchDeps, 'db' | 'embeddings' | 'scan' | 'selection' | 'rerank'>,
  projectId: string,
  trigger: 'model_change' | 'operator',
): Promise<FloorSuggestionOutcome> {
  if (trigger === 'model_change') {
    return projectLocks.runExclusive(projectId, async () => {
      await serverSlots.acquire();
      try {
        return await measureProject(deps, projectId, trigger);
      } finally {
        serverSlots.release();
      }
    });
  }
  // Checked and entered with no `await` between, so two requests cannot both pass the check.
  if (projectLocks.isLocked(projectId)) return { status: 'busy', reason: 'project' };
  if (!serverSlots.tryAcquire()) return { status: 'busy', reason: 'server' };
  try {
    return await projectLocks.runExclusive(projectId, () => measureProject(deps, projectId, trigger));
  } finally {
    serverSlots.release();
  }
}

async function measureProject(
  deps: Pick<SearchDeps, 'db' | 'embeddings' | 'scan' | 'selection' | 'rerank'>,
  projectId: string,
  trigger: 'model_change' | 'operator',
): Promise<FloorSuggestionOutcome> {
  const { db, embeddings } = deps;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return { status: 'project_gone' };
  if (project.embeddingModel === null || project.chunkCount === 0) return { status: 'not_indexed' };
  if (project.embeddingModel !== embeddings.id) {
    return { status: 'model_mismatch', indexedWith: project.embeddingModel, serverUses: embeddings.id };
  }

  const queries = await calibrationQueries(db, projectId, project.liveGeneration);
  if (queries.length < MIN_CALIBRATION_PROBES) return { status: 'insufficient_data', probes: queries.length, required: MIN_CALIBRATION_PROBES };

  const samples: CalibrationSample[] = [];
  for (const query of queries) {
    const outcome = await searchProject(
      { ...deps, scoreFloor: undefined, queryLog: undefined, metrics: undefined },
      { projectId, query, limit: CALIBRATION_SEARCH_LIMIT },
    );
    if (outcome.status === 'project_gone') return { status: 'project_gone' };
    if (outcome.status === 'model_mismatch') return { status: 'model_mismatch', indexedWith: outcome.indexedWith, serverUses: outcome.serverUses };
    if (outcome.status !== 'ok') return { status: 'not_indexed' };
    samples.push({ query, hits: outcome.hits });
  }

  const allowedShare = 0;
  const suggestedFloor = fitFloor(samples, allowedShare);
  if (suggestedFloor === 0) return { status: 'no_fit', probes: samples.length };

  const basis: FloorSuggestionBasis = {
    method: 'sentences',
    probes: samples.length,
    allowedShare,
    topScores: summariseTopScores(samples),
    refusedAtPrevious: project.scoreFloor === null || project.scoreFloor <= 0 ? null : refusedCount(samples, project.scoreFloor),
  };

  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(floorSuggestions)
      .values({
        projectId,
        trigger,
        embeddingModel: project.embeddingModel as string,
        liveGeneration: project.liveGeneration,
        suggestedFloor,
        previousFloor: project.scoreFloor,
        basis,
      })
      .returning();
    // Keep the newest few: a suggestion older than the last model change is stale anyway, and the table
    // is advice, not history.
    await tx.execute(sql`
      delete from floor_suggestions
      where project_id = ${projectId}
        and id not in (
          select id from floor_suggestions where project_id = ${projectId} order by created_at desc, id desc limit ${MAX_KEPT_SUGGESTIONS}
        )
    `);
    return created;
  });
  return { status: 'created', suggestion: toView(row) };
}

/** The project's suggestions, newest first. */
export async function listFloorSuggestions(db: Db, projectId: string, limit = MAX_KEPT_SUGGESTIONS): Promise<FloorSuggestionView[]> {
  const rows = await db
    .select()
    .from(floorSuggestions)
    .where(eq(floorSuggestions.projectId, projectId))
    .orderBy(desc(floorSuggestions.createdAt), desc(floorSuggestions.id))
    .limit(limit);
  return rows.map(toView);
}

/**
 * Adopts a suggestion as the project's own floor — the only path that does.
 *
 * Refused (`ConflictError`) when the suggestion was already applied, or when the project has been
 * re-indexed with another encoder or generation since it was measured: that number describes an index
 * that is no longer served. The row is locked for the check so two managers cannot both apply it.
 */
export async function applyFloorSuggestion(
  db: Db,
  projectId: string,
  suggestionId: string,
): Promise<{ suggestion: FloorSuggestionView; scoreFloor: number }> {
  return db.transaction(async (tx) => {
    const [suggestion] = await tx
      .select()
      .from(floorSuggestions)
      .where(and(eq(floorSuggestions.id, suggestionId), eq(floorSuggestions.projectId, projectId)))
      .limit(1)
      .for('update');
    if (!suggestion) throw new NotFoundError('Floor suggestion not found');
    if (suggestion.appliedAt !== null) throw new ConflictError('This suggestion has already been applied');
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1).for('update');
    if (!project) throw new NotFoundError('Project not found');
    if (project.embeddingModel !== suggestion.embeddingModel || project.liveGeneration !== suggestion.liveGeneration) {
      throw new ConflictError('This suggestion was measured against an earlier index of this project; generate a new one');
    }
    await tx.update(projects).set({ scoreFloor: suggestion.suggestedFloor }).where(eq(projects.id, projectId));
    const [applied] = await tx
      .update(floorSuggestions)
      .set({ appliedAt: new Date() })
      .where(and(eq(floorSuggestions.id, suggestionId), isNull(floorSuggestions.appliedAt)))
      .returning();
    return { suggestion: toView(applied), scoreFloor: suggestion.suggestedFloor };
  });
}
