/**
 * Turning stored chunks back into something a person could have written, and cutting it to a budget
 * measured in tokens ([ADR-0043](../../.ssot/ADR.md#adr-0043)).
 *
 * Pure, synchronous, and deliberately outside `mcp/tools.ts`: the two hard parts of a sectional read
 * are the overlap between consecutive chunks and where a token budget actually falls, and neither of
 * them needs a database, a project or an MCP session to be wrong in an interesting way.
 */

/**
 * How many trailing lines of the text so far are considered when looking for the next chunk's seeded
 * overlap. `CHUNK_OVERLAP_TOKENS` is 24 by default, which is a handful of lines; sixty is generous
 * enough for an operator who raised it and small enough that the search stays trivial.
 */
const MAX_OVERLAP_LINES = 60;

/** Below this a truncation has nothing useful left to hand over, so the shrink loop stops guessing. */
const MIN_TRUNCATION_CHARS = 200;

/** Attempts the proportional guess is allowed before it gives up and takes what it has. */
const MAX_SHRINK_STEPS = 24;

export interface JoinedChunks {
  /** The chunks' text, in document order, with the chunker's own overlap removed where it is found. */
  text: string;
  /**
   * `offsets[i]` is where chunk `i` begins in `text`, and `offsets[n]` is `text.length`. It is what
   * makes "as many whole chunks as the budget allows" a cut an agent can continue from with `from:`,
   * rather than a cut in the middle of a sentence it has no way to ask for the rest of.
   */
  offsets: number[];
}

/**
 * The number of trailing lines of `previous` that `next` repeats, compared on trimmed lines.
 *
 * **This is the chunker's overlap, read back.** `chunkSection` seeds each chunk with `takeTail` of the
 * one before it — whole lines, up to `CHUNK_OVERLAP_TOKENS`, never across a fence marker — so the
 * duplication that concatenation reintroduces is a whole number of lines and nothing else. Matching on
 * lines is therefore exact for the overlap that exists, and conservative everywhere else: text that
 * merely resembles the previous chunk does not line up line for line, and when nothing lines up
 * nothing is removed.
 *
 * The largest match wins, and a match of nothing but blank lines does not count — a document with two
 * blank lines between every block would otherwise "overlap" everywhere.
 */
export function overlappingLines(previous: string[], next: string[]): number {
  const limit = Math.min(previous.length, next.length, MAX_OVERLAP_LINES);
  for (let k = limit; k > 0; k--) {
    const tail = previous.slice(previous.length - k);
    const head = next.slice(0, k);
    if (!tail.some((line) => line.trim() !== '')) continue;
    if (tail.every((line, i) => line.trim() === head[i].trim())) return k;
  }
  return 0;
}

/**
 * Concatenates a document's chunks with the overlap between them removed.
 *
 * Joining chunks is how a sectional read is served, and the chunker overlaps them on purpose: a
 * sentence cut by a boundary has to appear on both sides of it or retrieval loses it. That is right
 * for two chunks read separately and wrong for two chunks read in sequence, where it is simply the
 * same two sentences twice — and at `CHUNK_MAX_TOKENS = 96` a page is many more chunks than it was
 * when 512 was the budget, so the duplication is no longer a curiosity.
 *
 * Chunks are separated by a blank line, which is what the chunker joined its own blocks with.
 */
export function joinChunks(contents: string[]): JoinedChunks {
  const parts: string[] = [];
  const offsets: number[] = [];
  let length = 0;
  let tail: string[] = [];

  for (const content of contents) {
    const lines = content.split('\n');
    const repeated = tail.length === 0 ? 0 : overlappingLines(tail, lines);
    const fresh = lines.slice(repeated).join('\n').replace(/^\n+/, '');
    offsets.push(length);
    if (fresh === '') {
      tail = lines;
      continue;
    }
    const separator = parts.length === 0 ? '' : '\n\n';
    parts.push(separator + fresh);
    length += separator.length + fresh.length;
    // The *previous chunk's own* lines, and not the tail of everything written so far: `takeTail`
    // seeds a chunk from the one immediately before it, so that is the only place the duplication can
    // have come from — and comparing against the whole accumulated text would make this quadratic to
    // find nothing extra.
    tail = lines;
  }

  offsets.push(length);
  return { text: parts.join(''), offsets };
}

export interface Truncated {
  text: string;
  /** Tokens in `text`, counted by the provider's own tokenizer — not an estimate of them. */
  tokens: number;
  truncated: boolean;
}

/**
 * Cuts `text` to `maxTokens`, at a line boundary where one is available.
 *
 * The first guess comes from this text's own characters-per-token ratio and is then shrunk until the
 * counter agrees, which is `hardCut`'s method in `services/chunker.ts` and is here for its reason: a
 * constant ratio is the thing [ADR-0036](../../.ssot/ADR.md#adr-0036) exists to stop trusting, and a
 * budget an agent was told is in tokens has to be in tokens.
 */
export function truncateToTokens(text: string, maxTokens: number, count: (text: string) => number): Truncated {
  const tokens = count(text);
  if (tokens <= maxTokens) return { text, tokens, truncated: false };

  let chars = Math.max(MIN_TRUNCATION_CHARS, Math.floor((text.length * maxTokens) / tokens));
  for (let step = 0; step < MAX_SHRINK_STEPS; step++) {
    const cut = lineCut(text, chars);
    const candidate = text.slice(0, cut);
    const candidateTokens = count(candidate);
    if (candidateTokens <= maxTokens) return { text: candidate, tokens: candidateTokens, truncated: true };
    if (chars <= MIN_TRUNCATION_CHARS) break;
    chars = Math.max(MIN_TRUNCATION_CHARS, Math.floor(chars * 0.8));
  }
  // Nothing smaller is worth another call to the tokenizer. The prefix may be a few tokens over the
  // budget; answering with it is better than answering with nothing, and it is bounded by a constant.
  const last = text.slice(0, lineCut(text, MIN_TRUNCATION_CHARS));
  return { text: last, tokens: count(last), truncated: true };
}

/** The last line boundary at or before `chars`, or `chars` itself when the prefix holds no newline. */
function lineCut(text: string, chars: number): number {
  if (chars >= text.length) return text.length;
  const newline = text.lastIndexOf('\n', chars);
  return newline > chars / 2 ? newline : chars;
}

/**
 * How many whole chunks of a joined document fit in `maxTokens`, by binary search over the offsets
 * `joinChunks` recorded.
 *
 * Binary search and not a loop: `countTokens` is a forward pass through a real tokenizer, and a
 * forty-chunk document would otherwise be forty of them. Returns `0` when not even the first chunk
 * fits, which is the caller's signal to cut inside one and say so.
 */
export function chunksWithinBudget(joined: JoinedChunks, maxTokens: number, count: (text: string) => number): number {
  const total = joined.offsets.length - 1;
  if (total === 0) return 0;
  if (count(joined.text) <= maxTokens) return total;

  let low = 0;
  let high = total - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (count(joined.text.slice(0, joined.offsets[mid])) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return low;
}
