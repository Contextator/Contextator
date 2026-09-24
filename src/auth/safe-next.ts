/**
 * The one place `next` — a redirect destination named on a query string, in the OIDC flow cookie, or
 * anywhere else a caller points at "where to go afterwards" — is checked against pointing somewhere
 * other than this instance ([MAJOR-2], tur 2 review of [ADR-0077](../../.ssot/ADR.md#adr-0077)).
 *
 * Three copies of this check used to live separately (`src/admin/auth-routes.ts`,
 * `src/admin/auth-pages.ts`, `public/auth-page.js`), and all three stopped at the same test: reject a
 * value starting with `//` or `/\`. That misses a control character anywhere else in the string. A
 * WHATWG URL parser — which is what the browser itself uses to resolve a `Location` header or an
 * anchor's `href` — strips ASCII tab, CR and LF from the input *before* it looks at slashes, so
 * `/\t/evil.example` reads as a same-origin path to the old check but resolves to `//evil.example`,
 * a scheme-relative link to another origin, the moment a browser parses it.
 *
 * This version rejects control characters and backslashes outright, then confirms the result by
 * actually parsing it against a fixed same-origin base — so anything that would resolve off that base
 * is caught by how a browser would read it, not by a hand-written list of dangerous prefixes.
 *
 * **What it returns is encoded** ([T2-MINOR-1], Faz 15b): the check runs on the decoded value, but the
 * value handed back goes through `encodeURI`, so it is plain ASCII and can be written straight into a
 * `Location` header — a decoded `next` holding anything outside Latin-1 used to make Node refuse the
 * header and the redirect answer `500`. `encodeURI` leaves `/ ? # & =` alone and escapes `%`, so the
 * result is also a fixed point: `safeNext(safeNext(x)) === safeNext(x)`. That matters because the OIDC
 * flow runs `next` through here twice — once when the flow starts and once more in the callback, on
 * the value the flow cookie carried — and returning the decoded value let the second pass decode a
 * second time (`/docs/100%25` became `/docs/100%`, which then failed to decode at all).
 */
const CONTROL_OR_BACKSLASH_RE = /[\u0000-\u001f\u007f\\]/;

/** An origin nothing real ever is, used only so `new URL(value, BASE).origin` has something to differ from. */
const SAFE_NEXT_BASE = 'http://safe-next.invalid';

/** A path on this server, or `/` when `raw` is missing, malformed, or would leave it. */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/';
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  if (!value.startsWith('/') || value.startsWith('//') || CONTROL_OR_BACKSLASH_RE.test(value)) return '/';
  try {
    if (new URL(value, SAFE_NEXT_BASE).origin !== SAFE_NEXT_BASE) return '/';
    // Throws `URIError` on a lone surrogate — a string no browser could have sent as a real path.
    return encodeURI(value);
  } catch {
    return '/';
  }
}
