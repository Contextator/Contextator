import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { detectEra } from '../src/mcp/era.js';

/**
 * [ADR-0098](../.ssot/ADR.md#adr-0098): one URL, two eras, and the body's `_meta` envelope is what
 * tells them apart. These are the classifications the router branches on, asserted through the same
 * SDK predicate the modern handler runs — so a disagreement between the two would show up here first.
 */

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'era-test', version: '0.0.0' },
};

function request(method: string, body: unknown, headers: Record<string, string> = {}) {
  const raw = new IncomingMessage(new Socket());
  raw.method = method;
  raw.url = '/mcp/handbook';
  raw.headers = {
    host: '127.0.0.1',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...headers,
  };
  return { raw, body };
}

describe('detectEra', () => {
  it('reads the initialize handshake as legacy', async () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    };
    expect(await detectEra(request('POST', body))).toBe('legacy');
  });

  it('reads a request on an existing session as legacy', async () => {
    const body = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    expect(await detectEra(request('POST', body, { 'mcp-session-id': 'abc' }))).toBe('legacy');
  });

  it('reads a POST without the envelope as legacy', async () => {
    const body = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_docs', arguments: { query: 'x' } } };
    expect(await detectEra(request('POST', body))).toBe('legacy');
  });

  it('reads a POST carrying the envelope as modern', async () => {
    const body = { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: ENVELOPE } };
    expect(await detectEra(request('POST', body))).toBe('modern');
  });

  it('reads server/discover with the envelope as modern', async () => {
    const body = { jsonrpc: '2.0', id: 5, method: 'server/discover', params: { _meta: ENVELOPE } };
    expect(await detectEra(request('POST', body))).toBe('modern');
  });

  it('reads the envelope as modern even beside an Mcp-Session-Id header', async () => {
    const body = { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { _meta: ENVELOPE } };
    expect(await detectEra(request('POST', body, { 'mcp-session-id': 'abc' }))).toBe('modern');
  });
});
