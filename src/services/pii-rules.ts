/**
 * The rules the PII scan applies to a stored document ([ADR-0130](../../.ssot/ADR.md#adr-0130), decision 1).
 *
 * **Pure: text in, matches out.** Nothing here touches a database, a key or a clock, which is what makes the
 * claim that matters testable as a unit test: a finding carries a position and a masked preview, and the value
 * itself leaves this file only as `normalized`, once, for the caller to key and drop.
 *
 * **Linear time, and tested to be.** A scan runs on every stored document in the event loop of the process that
 * serves searches, so no rule may backtrack on hostile input. Three habits keep that true: every quantifier has an
 * upper bound, every match starts behind a look-behind that stops a long run of the same characters from being
 * tried from each of its positions, and the validation (checksum, country length, mod-97) runs on the candidate and
 * not on the text. `test/pii-rules.test.ts` holds a megabyte of hostile text per rule to a time limit.
 *
 * The six rules are the product's own (user decision D19, no gitleaks). Raising {@link PII_RULESET_VERSION} when a
 * rule changes is what makes the scanner rescan documents it already scanned.
 */

export const PII_RULES = ['aws_access_key', 'github_token', 'private_key', 'jwt', 'tckn', 'iban'] as const;
export type PiiRule = (typeof PII_RULES)[number];

/** Raised whenever a rule, its validation or its masking changes in a way that alters what is found. */
export const PII_RULESET_VERSION = 1;

/**
 * Findings kept per document. A scan counts every finding and keeps the first of them in reading order, so a
 * document of ten thousand IBANs is a row of `document_scans` that says so (`finding_count`, `capped`) and a hundred
 * rows of `document_findings`, not ten thousand. The ceiling bounds storage and the response, not time: the scan
 * reads the whole text either way (a megabyte takes a few milliseconds; the eval corpus's 26 documents have no
 * finding at all), so a hundred is a limit for data dumps and not one a handwritten page comes near.
 */
export const MAX_FINDINGS_PER_DOCUMENT = 100;

/** What a rule found, before it has a line and a column. `normalized` is the value as keyed, and goes no further than the caller. */
export interface RuleMatch {
  rule: PiiRule;
  /** UTF-16 code unit offset into the scanned text, so `text.slice(start, start + length)` is the match. */
  start: number;
  length: number;
}

export interface Finding extends RuleMatch {
  /** 1-based. */
  line: number;
  /** 1-based, counted in code points and not in UTF-16 code units. */
  col: number;
  /** Shows at most four characters of the value beyond a fixed prefix (ADR-0130 decision 2). */
  preview: string;
  /** The value in the form it is keyed in: an IBAN without spaces, a citizen number as digits. Never stored. */
  normalized: string;
}

export interface ScanOutcome {
  /** At most `max` findings, in reading order. */
  findings: Finding[];
  /** Every finding there was, so a capped document still says how many. */
  total: number;
  capped: boolean;
}

// ---------------------------------------------------------------------------------------------
// Candidate patterns. Each is global; `matches` resets `lastIndex` before it runs one.
// ---------------------------------------------------------------------------------------------

const AWS_ACCESS_KEY = /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g;
const GITHUB_TOKEN = /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})(?![A-Za-z0-9])/g;
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-----/g;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,4096}\.eyJ[A-Za-z0-9_-]{4,4096}\.[A-Za-z0-9_-]{1,4096}(?![A-Za-z0-9_-])/g;
// Behind an alphanumeric the run is a hash, an identifier or part of a longer number, and about one in a hundred
// random eleven-digit runs passes the checksum.
const TCKN = /(?<![A-Za-z0-9])[1-9][0-9]{10}(?![A-Za-z0-9])/g;
const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![A-Za-z0-9])/g;

/** The private key's body is read only as far as is needed to tell two keys apart. */
const PRIVATE_KEY_BODY_WINDOW = 8192;
const PRIVATE_KEY_BODY_KEYED_CHARS = 4096;

/** Total IBAN length by country, from the registry. A country not listed here is not an IBAN country. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BI: 27,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DJ: 27,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FK: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HN: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MN: 20,
  MR: 27,
  MT: 31,
  MU: 30,
  NI: 28,
  NL: 18,
  NO: 15,
  OM: 23,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  RU: 33,
  SA: 24,
  SC: 31,
  SD: 18,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  SO: 23,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
  YE: 30,
};

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/** The Turkish citizen number's two check digits. The first digit is never 0 (the pattern already ensures it). */
export function isValidTckn(digits: string): boolean {
  if (!/^[1-9][0-9]{10}$/.test(digits)) return false;
  const d = Array.from(digits, Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  if (d[9] !== tenth) return false;
  return d.slice(0, 10).reduce((sum, digit) => sum + digit, 0) % 10 === d[10];
}

/** ISO 13616: move the first four characters to the end, read letters as 10..35, and the remainder mod 97 must be 1. */
export function isValidIbanChecksum(iban: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? code - 55 : code - 48;
    remainder = value > 9 ? (remainder * 100 + value) % 97 : (remainder * 10 + value) % 97;
  }
  return remainder === 1;
}

/** Whether a header segment decodes to a JSON object that names an `alg`, which is what makes `eyJ.eyJ.x` a JWT and not a coincidence. */
function hasJwtHeader(segment: string): boolean {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { alg?: unknown }).alg === 'string';
  } catch {
    return false;
  }
}

/**
 * The part of an IBAN candidate that is the IBAN. The pattern may have taken a following word along ("... 8413 26
 * FROM"), so the answer is the prefix whose letters and digits come to the country's length, ending where a group
 * ends, and valid under mod-97. `null` when there is none.
 */
function ibanWithin(candidate: string): { length: number; normalized: string } | null {
  const country = candidate.slice(0, 2);
  const expected = IBAN_LENGTHS[country];
  if (expected === undefined) return null;
  let count = 0;
  let end = -1;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] === ' ') continue;
    count++;
    if (count === expected) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) return null;
  if (end < candidate.length && candidate[end] !== ' ') return null;
  const normalized = candidate.slice(0, end).replaceAll(' ', '');
  return isValidIbanChecksum(normalized) ? { length: end, normalized } : null;
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

function* matches(pattern: RegExp, text: string): Generator<RegExpExecArray> {
  pattern.lastIndex = 0;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    yield m;
    // A pattern that could match the empty string would spin here; none of these can, and this keeps it so.
    if (m[0].length === 0) pattern.lastIndex++;
  }
}

function* findMatches(text: string): Generator<RuleMatch> {
  for (const m of matches(AWS_ACCESS_KEY, text)) yield { rule: 'aws_access_key', start: m.index, length: m[0].length };
  for (const m of matches(GITHUB_TOKEN, text)) yield { rule: 'github_token', start: m.index, length: m[0].length };
  for (const m of matches(PRIVATE_KEY_HEADER, text)) yield { rule: 'private_key', start: m.index, length: m[0].length };
  for (const m of matches(JWT, text)) {
    const header = m[0].slice(0, m[0].indexOf('.'));
    if (hasJwtHeader(header)) yield { rule: 'jwt', start: m.index, length: m[0].length };
  }
  for (const m of matches(TCKN, text)) {
    if (isValidTckn(m[0])) yield { rule: 'tckn', start: m.index, length: m[0].length };
  }
  for (const m of matches(IBAN, text)) {
    const iban = ibanWithin(m[0]);
    if (iban) yield { rule: 'iban', start: m.index, length: iban.length };
  }
}

/** The same findings, in reading order and with none inside another (an IBAN's digits are not a citizen number). */
function resolve(found: RuleMatch[]): RuleMatch[] {
  found.sort((a, b) => a.start - b.start || b.length - a.length);
  const kept: RuleMatch[] = [];
  let reach = 0;
  for (const match of found) {
    if (match.start < reach) continue;
    kept.push(match);
    reach = match.start + match.length;
  }
  return kept;
}

// ---------------------------------------------------------------------------------------------
// Masking and normalisation. Both look at the one value that is about to be dropped.
// ---------------------------------------------------------------------------------------------

const tail = (value: string, n: number): string => value.slice(-n);

function describe(match: RuleMatch, text: string): { preview: string; normalized: string } {
  const value = text.slice(match.start, match.start + match.length);
  switch (match.rule) {
    case 'aws_access_key':
      // `AKIA` is the fixed prefix; four characters of the rest.
      return { preview: `${value.slice(0, 4)}…${tail(value, 4)}`, normalized: value };
    case 'github_token': {
      const prefix = value.slice(0, value.startsWith('github_pat_') ? 11 : 4);
      return { preview: `${prefix}…${tail(value, 4)}`, normalized: value };
    }
    case 'private_key': {
      // The header names no secret and is the preview. What is keyed is the start of the body, because every key of
      // one kind has the same header and a group of "the same value" built from it would group all of them.
      const after = text.slice(match.start + match.length, match.start + match.length + PRIVATE_KEY_BODY_WINDOW);
      const end = after.indexOf('-----END');
      const body = (end === -1 ? after : after.slice(0, end)).replace(/\s+/g, '').slice(0, PRIVATE_KEY_BODY_KEYED_CHARS);
      return { preview: value, normalized: body.length > 0 ? body : value };
    }
    case 'jwt':
      // `eyJ` is the fixed prefix; four characters of the rest, which are the header's own constant opening.
      return { preview: `${value.slice(0, 7)}…`, normalized: value };
    case 'tckn':
      return { preview: `${'*'.repeat(9)}${tail(value, 2)}`, normalized: value };
    case 'iban': {
      const normalized = value.replaceAll(' ', '');
      return { preview: `${normalized.slice(0, 2)}…${tail(normalized, 4)}`, normalized };
    }
  }
}

/**
 * Scans one document's text.
 *
 * Positions are computed in one forward pass over the text up to the last kept finding, so a document that is one
 * enormous line costs the same as one that is many short ones.
 */
export function scanText(text: string, max: number = MAX_FINDINGS_PER_DOCUMENT): ScanOutcome {
  const resolved = resolve([...findMatches(text)]);
  const kept = resolved.slice(0, max);

  const findings: Finding[] = [];
  let position = 0;
  let line = 1;
  let col = 1;
  for (const match of kept) {
    while (position < match.start) {
      const code = text.charCodeAt(position);
      if (code === 10) {
        line++;
        col = 1;
        position++;
      } else if (code >= 0xd800 && code <= 0xdbff && position + 1 < text.length) {
        // A surrogate pair is one code point.
        col++;
        position += 2;
      } else {
        col++;
        position++;
      }
    }
    findings.push({ ...match, line, col, ...describe(match, text) });
  }
  return { findings, total: resolved.length, capped: resolved.length > max };
}
