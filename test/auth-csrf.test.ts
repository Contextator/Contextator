import { describe, expect, it } from 'vitest';
import { SAFE_METHODS, isSameSiteRequest } from '../src/auth/csrf.js';
import { isOriginAllowed } from '../src/services/origin.js';

const HOST = 'docs.example.com';

describe('isSameSiteRequest', () => {
  it('trusts Sec-Fetch-Site when the browser sends it', () => {
    expect(isSameSiteRequest({ 'sec-fetch-site': 'same-origin' }, HOST, [])).toBe(true);
    // `none` is the user typing the URL or a bookmark: not a cross-site request.
    expect(isSameSiteRequest({ 'sec-fetch-site': 'none' }, HOST, [])).toBe(true);
    expect(isSameSiteRequest({ 'sec-fetch-site': 'cross-site' }, HOST, [])).toBe(false);
    // A sibling subdomain is same-site but not same-origin; that is exactly the gap Lax leaves.
    expect(isSameSiteRequest({ 'sec-fetch-site': 'same-site' }, HOST, [])).toBe(false);
  });

  it('prefers Sec-Fetch-Site over a matching Origin', () => {
    expect(isSameSiteRequest({ 'sec-fetch-site': 'cross-site', origin: `https://${HOST}` }, HOST, [])).toBe(false);
  });

  it('falls back to Origin, then Referer', () => {
    expect(isSameSiteRequest({ origin: `https://${HOST}` }, HOST, [])).toBe(true);
    expect(isSameSiteRequest({ origin: 'https://evil.example' }, HOST, [])).toBe(false);
    expect(isSameSiteRequest({ referer: `https://${HOST}/about` }, HOST, [])).toBe(true);
    expect(isSameSiteRequest({ referer: 'https://evil.example/page' }, HOST, [])).toBe(false);
  });

  it('honours the configured extra origins', () => {
    expect(isSameSiteRequest({ origin: 'https://ops.example' }, HOST, ['https://ops.example'])).toBe(true);
  });

  it('refuses a cookie-carrying request that names no source at all', () => {
    expect(isSameSiteRequest({}, HOST, [])).toBe(false);
  });

  it('reads a header that arrived more than once', () => {
    expect(isSameSiteRequest({ 'sec-fetch-site': ['same-origin', 'cross-site'] }, HOST, [])).toBe(true);
  });

  it('counts only the methods that cannot change anything as safe', () => {
    expect([...SAFE_METHODS].sort()).toEqual(['GET', 'HEAD', 'OPTIONS']);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(SAFE_METHODS.has(method)).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  it('keeps the MCP router’s rules: listed, loopback, or the request host', () => {
    expect(isOriginAllowed('http://localhost:3000', 'docs.example.com', [])).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5173', 'docs.example.com', [])).toBe(true);
    expect(isOriginAllowed('https://docs.example.com', 'docs.example.com', [])).toBe(true);
    expect(isOriginAllowed('https://other.example', 'docs.example.com', [])).toBe(false);
    expect(isOriginAllowed('https://other.example', 'docs.example.com', ['https://other.example'])).toBe(true);
    expect(isOriginAllowed('not a url', 'docs.example.com', [])).toBe(false);
  });
});
