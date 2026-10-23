/**
 * A narrow XML scanner for the OOXML parts the converters read ([ADR-0115](../../../.ssot/ADR.md#adr-0115)).
 *
 * **It reads text nodes and element boundaries and nothing else, and that is why it is not a parser.**
 * A slide's `<a:t>` and a sheet's `<c><v>` are all this product wants out of the XML. A general parser
 * would add a dependency for that and, worse, a DTD processor: this scanner never expands an entity it
 * does not know (so a "billion laughs" document is just text), skips `<!DOCTYPE …>` whole, and holds
 * no tree — memory is the input string plus the callbacks' own state.
 *
 * Element and attribute names are handed over with their namespace prefix stripped (`a:t` → `t`),
 * because producers choose the prefix and the converters care about the local name; an attribute is
 * additionally kept under its full name, which {@link relationshipId} uses for `r:id`.
 */

export interface XmlHandlers {
  open?(name: string, attrs: Record<string, string>): void;
  close?(name: string): void;
  text?(value: string): void;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** `&amp;`, `&#10;`, `&#x1F600;`; an entity this table does not know stays as written. */
export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Strips the namespace prefix: `a:t` → `t`. */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * The relationship id an element points at (`r:id`, whatever prefix the producer bound to the
 * relationships namespace), or `undefined`.
 */
export function relationshipId(attrs: Record<string, string>): string | undefined {
  if (attrs['r:id'] !== undefined) return attrs['r:id'];
  const key = Object.keys(attrs).find((k) => k.endsWith(':id'));
  return key === undefined ? undefined : attrs[key];
}

/** Characters that end an attribute name (and that never start one). */
const NAME_BREAK = /[\s=/>"']/;

/**
 * `name="value"` pairs, read in one pass.
 *
 * A scanner and not a regular expression: `([^\s=/>"']+)\s*=` retried from every character of a long
 * token that has no `=` after it, which is quadratic, and the token is the input's to make as long as
 * it likes. Here every character is looked at a bounded number of times.
 */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const length = source.length;
  const skipSpace = (from: number): number => {
    let at = from;
    while (at < length && /\s/.test(source[at])) at++;
    return at;
  };
  let i = 0;
  while (i < length) {
    if (NAME_BREAK.test(source[i])) {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < length && !NAME_BREAK.test(source[i])) i++;
    const name = source.slice(nameStart, i);
    let at = skipSpace(i);
    if (source[at] !== '=') continue;
    at = skipSpace(at + 1);
    const quote = source[at];
    if (quote !== '"' && quote !== "'") continue;
    const close = source.indexOf(quote, at + 1);
    if (close === -1) continue;
    i = close + 1;
    const value = decodeEntities(source.slice(at + 1, close));
    attrs[name] = value;
    // Reachable by local name as well, unless an unprefixed attribute of that name was already seen.
    const local = localName(name);
    if (local !== name && !(local in attrs)) attrs[local] = value;
  }
  return attrs;
}

/** Walks `xml`, calling the handlers in document order. A self-closing element opens and closes. */
export function scanXml(xml: string, handlers: XmlHandlers): void {
  const length = xml.length;
  let i = 0;
  while (i < length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      if (handlers.text && i < length) handlers.text(decodeEntities(xml.slice(i)));
      return;
    }
    if (lt > i && handlers.text) handlers.text(decodeEntities(xml.slice(i, lt)));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? length : end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const stop = end === -1 ? length : end;
      if (handlers.text) handlers.text(xml.slice(lt + 9, stop));
      i = end === -1 ? length : end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end === -1 ? length : end + 2;
    } else if (xml.startsWith('<!', lt)) {
      // A DOCTYPE, possibly with an internal subset in brackets. Skipped, never interpreted.
      let depth = 0;
      let j = lt + 2;
      for (; j < length; j++) {
        const ch = xml[j];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt + 2);
      const stop = end === -1 ? length : end;
      handlers.close?.(localName(xml.slice(lt + 2, stop).trim()));
      i = stop + 1;
    } else {
      // A start tag. Find its closing `>` while respecting quoted attribute values.
      let j = lt + 1;
      let quote = '';
      for (; j < length; j++) {
        const ch = xml[j];
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
      }
      let inner = xml.slice(lt + 1, j);
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1);
      const space = inner.search(/\s/);
      const rawName = space === -1 ? inner : inner.slice(0, space);
      const name = localName(rawName);
      handlers.open?.(name, space === -1 ? {} : parseAttributes(inner.slice(space)));
      if (selfClosing) handlers.close?.(name);
      i = j + 1;
    }
  }
}

export interface Relationship {
  id: string;
  type: string;
  /** Resolved against the part that owns the relationships, as a zip entry name. */
  target: string;
  external: boolean;
}

/**
 * Resolves a relationship `Target` to a zip entry name. A leading `/` is relative to the package root;
 * anything else is relative to the directory of the part that owns the relationships.
 */
export function resolveTarget(ownerPart: string, target: string): string {
  const segments: string[] = target.startsWith('/') ? [] : ownerPart.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

/** `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`. */
export function relsPathFor(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** The relationships of one `.rels` part, targets resolved against `ownerPart`. */
export function parseRelationships(xml: string, ownerPart: string): Relationship[] {
  const rels: Relationship[] = [];
  scanXml(xml, {
    open(name, attrs) {
      if (name !== 'Relationship' || attrs.Id === undefined || attrs.Target === undefined) return;
      const external = attrs.TargetMode === 'External';
      rels.push({ id: attrs.Id, type: attrs.Type ?? '', target: external ? attrs.Target : resolveTarget(ownerPart, attrs.Target), external });
    },
  });
  return rels;
}

/** `dc:title` of `docProps/core.xml`, or `''`. */
export function documentTitle(xml: string | null): string {
  if (xml === null) return '';
  let title = '';
  let inTitle = false;
  scanXml(xml, {
    open(name) {
      if (name === 'title') inTitle = true;
    },
    close(name) {
      if (name === 'title') inTitle = false;
    },
    text(value) {
      if (inTitle) title += value;
    },
  });
  return title.trim();
}
