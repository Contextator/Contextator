import { describe, expect, it } from 'vitest';
import { exposureWarning, isLoopbackHost } from '../src/http.js';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]'])('treats %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '10.0.0.5', '192.168.1.2', 'example.com', '1127.0.0.1'])('treats %s as reachable from elsewhere', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('exposureWarning (ADR-0114)', () => {
  it('stays silent when no project is open, whatever the bind address is', () => {
    expect(exposureWarning('0.0.0.0', [])).toBeNull();
  });

  it('stays silent on a loopback bind even with an open project', () => {
    expect(exposureWarning('127.0.0.1', ['docs'])).toBeNull();
  });

  it('warns when a non-loopback bind meets an open project, and names it', () => {
    const message = exposureWarning('0.0.0.0', ['docs', 'wiki']);
    expect(message).toContain('0.0.0.0');
    expect(message).toContain('docs, wiki');
  });

  it('caps the list of names it prints', () => {
    const names = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const message = exposureWarning('0.0.0.0', names) ?? '';
    expect(message).toContain('p4');
    expect(message).not.toContain('p5,');
    expect(message).toContain('8 in total');
  });
});
