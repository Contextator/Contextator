/**
 * The boundary between this server's own words and the text of an indexed document.
 *
 * **It does not stop prompt injection and is not offered as doing so.**
 * [SECURITY.md](../../.ssot/SECURITY.md) T10 stands exactly as written: a corpus that tells an agent to
 * do something is a corpus that tells an agent to do something, and nothing in this file changes what a
 * document says or what an agent does with it. What was missing beside that declaration was the cheap
 * half — a mark an agent can *see*. Until [ADR-0066](../../.ssot/ADR.md#adr-0066) a `search_docs`
 * excerpt arrived under a `###` heading and a `read_document` body after a `---`, and both of those are
 * lines a document writes for itself, so the quotation and the server's own prose were the same kind of
 * text. They are now fenced, and `instructions` says in one sentence what the fence means.
 *
 * **Why angle brackets and not a code fence.** `read_document` returns Markdown
 * ([ADR-0043](../../.ssot/ADR.md#adr-0043)) and documentation routinely contains ``` fences, `---`
 * rules and `#` headings; a wrapper spelled in any of those is a wrapper the corpus already writes by
 * accident. `<<<BEGIN DOCUMENT TEXT>>>` is not valid HTML — a tag name cannot begin with `<` — so
 * CommonMark renders it as the literal characters wherever it lands, inside a code block as readily as
 * outside one, and there is no renderer that swallows it.
 *
 * **The escaping rule, which is the half that makes the fence mean anything.** A document may contain
 * the marker, and a fence the quoted text can close is not a fence. Nothing is escaped, substituted,
 * stripped or re-encoded: what comes back is byte-for-byte what was indexed, because ADR-0043's promise
 * is that `read_document` returns the text `search_docs` quoted. **The fence moves instead** — one
 * angle bracket wider at each end until neither marker occurs in the text it wraps, which is the rule
 * CommonMark already uses for a code fence that has to contain a code fence. Three each side is the
 * floor; an agent matches the closing marker to the opening one it just read rather than to a constant.
 */

const BEGIN_WORD = 'BEGIN DOCUMENT TEXT';
const END_WORD = 'END DOCUMENT TEXT';

/** Three, so that the common case is a constant an agent sees on every call and can learn. */
const MIN_ANGLES = 3;

export interface DocumentFence {
  readonly begin: string;
  readonly end: string;
  /** Angle brackets each side: `MIN_ANGLES`, unless a document pushed the fence outwards. */
  readonly angles: number;
}

const marker = (word: string, angles: number): string => `${'<'.repeat(angles)}${word}${'>'.repeat(angles)}`;

/**
 * The widest fence this text can already close, or `-1` when it names neither marker at all.
 *
 * Computed rather than searched for. `'<'.repeat(n) + word + '>'.repeat(n)` occurs in a text exactly
 * when some occurrence of `word` has at least `n` angle brackets on both sides of it, so one pass over
 * the occurrences answers every `n` at once — where a loop that tried each width in turn would be
 * quadratic on a document made of angle brackets, which is a document an attacker can upload.
 */
function widestFenceClosedBy(text: string, word: string): number {
  let widest = -1;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    let before = 0;
    while (at - before > 0 && text[at - before - 1] === '<') before++;
    let after = 0;
    const tail = at + word.length;
    while (tail + after < text.length && text[tail + after] === '>') after++;
    const closable = Math.min(before, after);
    if (closable > widest) widest = closable;
  }
  return widest;
}

/**
 * The narrowest fence none of these texts can close. Pass every text that will be wrapped in one tool
 * result, not one at a time: a `search_docs` answer carrying excerpts of several documents fences them
 * all alike, because an agent reading three widths in one result has been given a puzzle rather than a
 * boundary.
 */
export function documentFence(...texts: string[]): DocumentFence {
  let angles = MIN_ANGLES;
  for (const text of texts) {
    angles = Math.max(angles, widestFenceClosedBy(text, BEGIN_WORD) + 1, widestFenceClosedBy(text, END_WORD) + 1);
  }
  return { begin: marker(BEGIN_WORD, angles), end: marker(END_WORD, angles), angles };
}

/** The text, unchanged, on its own lines between the two markers. */
export const wrapDocumentText = (fence: DocumentFence, text: string): string => `${fence.begin}\n${text}\n${fence.end}`;

/**
 * The markers as an agent sees them when no document has pushed them out — what `instructions` quotes,
 * and the only spelling that is a constant rather than a thing to match.
 */
export const DEFAULT_DOCUMENT_FENCE: DocumentFence = documentFence();
