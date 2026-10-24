import { describe, expect, it } from 'vitest';
// @ts-expect-error - public/ is untyped ES modules the browser loads directly (ADR-0022); see audit-panel.test.ts.
import { modifiedDay, safeSourceUrl } from '../public/search.js';

/**
 * **A source address from the index is data, not a link we trust.** The hit's `sourceUrl` came from a
 * crawler or a sync, so the panel makes it clickable only when it is plain http(s): a `javascript:`
 * address in an `href` would run in the operator's session (ADR-0116).
 */
describe('the source line of a search hit', () => {
  it('links http and https addresses', () => {
    expect(safeSourceUrl('https://docs.example.com/guide#intro')).toBe('https://docs.example.com/guide#intro');
    expect(safeSourceUrl('http://wiki.internal/page')).toBe('http://wiki.internal/page');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'not a url', '', null, undefined, 42])(
    'refuses to link %s',
    (value) => {
      expect(safeSourceUrl(value)).toBeNull();
    },
  );

  it('shows the modified day in UTC, and nothing for a missing or broken timestamp', () => {
    expect(modifiedDay('2026-03-14T23:30:00.000Z')).toBe('2026-03-14');
    expect(modifiedDay(null)).toBeNull();
    expect(modifiedDay('yesterday')).toBeNull();
  });
});
