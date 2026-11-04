import { describe, expect, it } from 'vitest';

import { LEGACY_SSE_DEPRECATED_AT, LEGACY_SSE_DOCS_URL, LEGACY_SSE_SUNSET_AT, legacySseHeaders } from '../src/mcp/router.js';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import * as panel from '../public/legacy-sse.js';

/**
 * The announced end of the legacy HTTP+SSE transport (ADR-0096, ADR-0139). The router sends the dates as
 * `Deprecation`, `Sunset` and `Link`; the dashboard prints the same sunset day. The browser cannot import
 * from src/, so `public/legacy-sse.js` holds a copy, and this file is what keeps the two from drifting.
 */
describe('legacy SSE sunset', () => {
  it('builds the three headers as RFC 9745 / RFC 8594 values', () => {
    const headers = legacySseHeaders();
    expect(headers.deprecation).toBe('@1790899200');
    expect(headers.sunset).toBe('Sat, 02 Oct 2027 00:00:00 GMT');
    expect(headers.link).toBe(`<${LEGACY_SSE_DOCS_URL}>; rel="deprecation", <${LEGACY_SSE_DOCS_URL}>; rel="sunset"`);
  });

  it('announces the deprecation before the sunset', () => {
    expect(Date.parse(LEGACY_SSE_DEPRECATED_AT)).toBeLessThan(Date.parse(LEGACY_SSE_SUNSET_AT));
  });

  it('points the docs link at the public compatibility page, section legacy-httpsse', () => {
    expect(LEGACY_SSE_DOCS_URL).toBe('https://github.com/Contextator/Contextator/blob/main/docs/compatibility.md#legacy-httpsse');
  });

  it('is the same in the dashboard module as in the router', () => {
    expect(panel.LEGACY_SSE_DEPRECATED_AT).toBe(LEGACY_SSE_DEPRECATED_AT);
    expect(panel.LEGACY_SSE_SUNSET_AT).toBe(LEGACY_SSE_SUNSET_AT);
    expect(panel.LEGACY_SSE_DOCS_URL).toBe(LEGACY_SSE_DOCS_URL);
  });

  it('prints the sunset day in UTC for the dashboard', () => {
    expect(panel.legacySseSunsetLabel()).toBe('2 October 2027');
  });
});
