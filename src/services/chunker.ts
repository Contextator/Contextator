/**
 * Markdown-aware chunker.
 *
 * Strategy: split the document into sections at headings (#–####) while tracking a
 * breadcrumb ("Guide > Install > Docker"). Sections that exceed the token budget are
 * packed from paragraph and fenced-code blocks with a small overlap between chunks.
 * Fenced code is never split mid-block unless a single block is itself too large.
 *
 * Tokens are approximated as chars / 4 to avoid a tokenizer dependency.
 */

export interface Chunk {
  index: number;
  headingPath: string;
  content: string;
  tokenCount: number;
}

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
}

export interface ChunkResult {
  title: string;
  chunks: Chunk[];
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Text handed to the embedding model: breadcrumb first so it always fits the model window. */
export const embeddingText = (chunk: Pick<Chunk, 'headingPath' | 'content'>): string =>
  chunk.headingPath ? `${chunk.headingPath}\n\n${chunk.content}` : chunk.content;

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const MIN_CHUNK_CHARS = 20;

interface FenceState {
  char: string;
  len: number;
}

/** Returns the fence state after `line`. Closing fences must use the same char, be at least as long, and carry no info string. */
function fenceTransition(line: string, fence: FenceState | null): FenceState | null {
  const m = FENCE_RE.exec(line);
  if (!m) return fence;
  const marker = m[1];
  const char = marker[0];
  const len = marker.length;
  if (!fence) {
    if (char === '`' && m[2].includes('`')) return fence; // not a valid backtick fence opener
    return { char, len };
  }
  if (char === fence.char && len >= fence.len && m[2].trim() === '') return null;
  return fence;
}

function cleanHeading(text: string): string {
  return text
    .replace(/\s*\{#[^}]*\}\s*$/, '')
    .replace(/`/g, '')
    .trim();
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, '').length;
}

export function parseFrontmatter(src: string): { data: Record<string, string>; body: string } {
  const lines = src.split('\n');
  if (lines[0]?.trim() !== '---') return { data: {}, body: src };
  const end = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line));
  if (end === -1) return { data: {}, body: src };
  const data: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m) data[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { data, body: lines.slice(end + 1).join('\n') };
}

/** Removes MDX import/export statements, JSX comments and standalone component tags outside code fences. */
export function stripMdx(body: string): string {
  const out: string[] = [];
  const lines = body.split('\n');
  let fence: FenceState | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = fenceTransition(line, fence);
    if (fence || next) {
      out.push(line);
      fence = next;
      continue;
    }
    if (/^\s*import\s/.test(line)) {
      const singleLine = /\sfrom\s+['"]/.test(line) || /^\s*import\s+['"]/.test(line);
      if (!singleLine) {
        while (i + 1 < lines.length && !/from\s+['"][^'"]+['"]/.test(lines[i])) i++;
      }
      continue;
    }
    if (/^\s*export\s/.test(line)) {
      if (/[{([=]\s*$/.test(line)) {
        while (i + 1 < lines.length && !/^[}\])]/.test(lines[i + 1]) && lines[i + 1].trim() !== '') i++;
        if (i + 1 < lines.length && /^[}\])]/.test(lines[i + 1])) i++;
      }
      continue;
    }
    if (/^\s*\{\/\*.*\*\/\}\s*$/.test(line)) continue;
    if (/^\s*<\/?[A-Z][A-Za-z0-9.]*(\s[^>]*)?\/?>\s*$/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function findFirstH1(body: string): string | undefined {
  let fence: FenceState | null = null;
  for (const line of body.split('\n')) {
    const next = fenceTransition(line, fence);
    if (fence || next) {
      fence = next;
      continue;
    }
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return cleanHeading(m[1]);
  }
  return undefined;
}

export function extractTitle(front: Record<string, string>, body: string, relativePath: string): string {
  if (front.title) return front.title;
  const h1 = findFirstH1(body);
  if (h1) return h1;
  const base = relativePath.split('/').pop() ?? relativePath;
  const stem = base.replace(/\.(md|mdx|txt)$/i, '');
  const words = stem.split(/[-_\s]+/).filter(Boolean);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : stem;
}

interface Section {
  headingPath: string;
  lines: string[];
}

function splitSections(body: string, title: string): Section[] {
  const stack: string[] = findFirstH1(body) ? [] : [title];
  const sections: Section[] = [];
  let current: Section = { headingPath: title, lines: [] };
  let fence: FenceState | null = null;

  for (const line of body.split('\n')) {
    const next = fenceTransition(line, fence);
    if (fence || next) {
      current.lines.push(line);
      fence = next;
      continue;
    }
    const m = HEADING_RE.exec(line);
    if (m) {
      sections.push(current);
      const level = m[1].length;
      stack.length = level - 1;
      stack[level - 1] = cleanHeading(m[2]);
      current = { headingPath: stack.filter(Boolean).join(' > '), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);
  return sections.filter((s) => s.lines.join('\n').trim().length > 0);
}

interface Block {
  kind: 'code' | 'text';
  text: string;
}

function splitBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let code: string[] | null = null;
  let fence: FenceState | null = null;
  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'text', text: para.join('\n') });
      para = [];
    }
  };
  for (const line of lines) {
    const next = fenceTransition(line, fence);
    if (!fence && next) {
      flushPara();
      code = [line];
      fence = next;
      continue;
    }
    if (fence && !next) {
      code!.push(line);
      blocks.push({ kind: 'code', text: code!.join('\n') });
      code = null;
      fence = null;
      continue;
    }
    if (fence) {
      code!.push(line);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      continue;
    }
    para.push(line);
  }
  if (code) blocks.push({ kind: 'code', text: code.join('\n') });
  flushPara();
  return blocks;
}

function hardCut(text: string, maxTokens: number): string[] {
  const maxChars = Math.max(maxTokens * 4, 16);
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars / 2) cut = maxChars;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function packUnits(units: string[], maxTokens: number, separator: string): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const unit of units) {
    const t = estimateTokens(unit + separator);
    if (current.length && tokens + t > maxTokens) {
      pieces.push(current.join(separator));
      current = [];
      tokens = 0;
    }
    current.push(unit);
    tokens += t;
  }
  if (current.length) pieces.push(current.join(separator));
  return pieces;
}

function splitTextBlock(text: string, maxTokens: number): string[] {
  const units: string[] = [];
  for (const line of text.split('\n')) {
    if (estimateTokens(line) <= maxTokens) {
      units.push(line);
      continue;
    }
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (estimateTokens(sentence) <= maxTokens) units.push(sentence);
      else units.push(...hardCut(sentence, maxTokens));
    }
  }
  return packUnits(units, maxTokens, '\n');
}

/** Splits an oversized fenced block on line boundaries; every piece is re-wrapped in the same fence. */
function splitCodeBlock(text: string, maxTokens: number): string[] {
  const lines = text.split('\n');
  const open = lines[0];
  const marker = FENCE_RE.exec(open)?.[1] ?? '```';
  const last = lines[lines.length - 1];
  const isClosed = lines.length > 1 && FENCE_RE.test(last) && fenceTransition(last, { char: marker[0], len: marker.length }) === null;
  const close = isClosed ? last : marker;
  const body = isClosed ? lines.slice(1, -1) : lines.slice(1);
  const budget = Math.max(maxTokens - estimateTokens(`${open}\n${close}\n`), 20);

  const units: string[] = [];
  for (const line of body) {
    if (estimateTokens(line) <= budget) units.push(line);
    else units.push(...hardCut(line, budget));
  }
  return packUnits(units, budget, '\n').map((piece) => `${open}\n${piece}\n${close}`);
}

/** Trailing whole lines of `content` worth up to `overlapTokens`; stops at fence markers so code is never duplicated. */
function takeTail(content: string, overlapTokens: number): string {
  const lines = content.split('\n');
  const tail: string[] = [];
  let tokens = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FENCE_RE.test(lines[i])) break;
    const t = estimateTokens(lines[i] + '\n');
    if (tokens + t > overlapTokens) break;
    tail.unshift(lines[i]);
    tokens += t;
  }
  return tail.join('\n').trim();
}

function chunkSection(section: Section, opts: ChunkOptions): string[] {
  const whole = section.lines.join('\n').trim();
  if (estimateTokens(whole) <= opts.maxTokens) return [whole];

  const out: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  let seededTokens = 0;
  let lastWasCode = false;

  const flush = () => {
    if (current.length && tokens > seededTokens) {
      const content = current.join('\n\n').trim();
      out.push(content);
      const tail = lastWasCode || opts.overlapTokens === 0 ? '' : takeTail(content, opts.overlapTokens);
      current = tail ? [tail] : [];
      tokens = tail ? estimateTokens(tail) : 0;
      seededTokens = tokens;
    } else {
      current = [];
      tokens = 0;
      seededTokens = 0;
    }
  };

  for (const block of splitBlocks(section.lines)) {
    const blockTokens = estimateTokens(block.text);
    if (blockTokens > opts.maxTokens) {
      if (current.length && tokens > seededTokens) out.push(current.join('\n\n').trim());
      current = [];
      tokens = 0;
      seededTokens = 0;
      out.push(...(block.kind === 'code' ? splitCodeBlock(block.text, opts.maxTokens) : splitTextBlock(block.text, opts.maxTokens)));
      lastWasCode = block.kind === 'code';
      continue;
    }
    if (current.length && tokens + blockTokens > opts.maxTokens) flush();
    current.push(block.text);
    tokens += blockTokens + 1;
    lastWasCode = block.kind === 'code';
  }
  if (current.length && tokens > seededTokens) out.push(current.join('\n\n').trim());
  return out.filter((c) => c.length > 0);
}

export function chunkMarkdown(src: string, relativePath: string, opts: ChunkOptions): ChunkResult {
  const normalized = src.replace(/\r\n?/g, '\n');
  const { data, body: rawBody } = parseFrontmatter(normalized);
  const body = /\.mdx$/i.test(relativePath) ? stripMdx(rawBody) : rawBody;
  const title = extractTitle(data, body, relativePath);

  const draft: Array<{ headingPath: string; content: string }> = [];
  for (const section of splitSections(body, title)) {
    for (const content of chunkSection(section, opts)) draft.push({ headingPath: section.headingPath, content });
  }

  // Merge chunks that are too small to be meaningful on their own.
  const merged: Array<{ headingPath: string; content: string }> = [];
  for (const chunk of draft) {
    const prev = merged[merged.length - 1];
    if (prev && nonWhitespaceLength(chunk.content) < MIN_CHUNK_CHARS) {
      prev.content += `\n\n${chunk.content}`;
      continue;
    }
    if (prev && nonWhitespaceLength(prev.content) < MIN_CHUNK_CHARS) {
      // A heading-only stub absorbs the next chunk; the breadcrumb follows the bulk of the content.
      merged[merged.length - 1] = { headingPath: chunk.headingPath, content: `${prev.content}\n\n${chunk.content}` };
      continue;
    }
    merged.push({ ...chunk });
  }

  return {
    title,
    chunks: merged.map((c, index) => ({ index, headingPath: c.headingPath, content: c.content, tokenCount: estimateTokens(c.content) })),
  };
}
