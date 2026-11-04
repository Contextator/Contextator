// The legacy HTTP+SSE transport's announced end date, as the dashboard shows it (ADR-0096, ADR-0139).
//
// src/mcp/router.ts owns these values (`LEGACY_SSE_DEPRECATED_AT`, `LEGACY_SSE_SUNSET_AT`,
// `LEGACY_SSE_DOCS_URL`) and sends them as the `Deprecation`, `Sunset` and `Link` headers. The browser cannot
// import from src/, so the panel carries the same values here, and test/legacy-sse-sunset.test.ts fails if the
// two copies differ. Change both together.

// Not shown by the panel; kept so the parity test covers the whole pair the router announces.
export const LEGACY_SSE_DEPRECATED_AT = '2026-10-02T00:00:00Z';
export const LEGACY_SSE_SUNSET_AT = '2027-10-02T00:00:00Z';
export const LEGACY_SSE_DOCS_URL = 'https://github.com/Contextator/Contextator/blob/main/docs/compatibility.md#legacy-httpsse';

/** The sunset day as plain text, in UTC so every operator reads the same day the header carries: "2 October 2027". */
export function legacySseSunsetLabel() {
  return new Date(LEGACY_SSE_SUNSET_AT).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
