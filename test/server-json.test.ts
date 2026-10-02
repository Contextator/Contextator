import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * `server.json` describes this server for the MCP Registry and is not read by anything at run time,
 * so nothing else notices when a release raises `package.json` and leaves it behind, or when the MCP
 * route it points at moves.
 */

const ROOT = new URL('../', import.meta.url);

const readJson = async (path: string) => JSON.parse(await readFile(new URL(path, ROOT), 'utf8'));

describe('server.json', () => {
  it('carries the same version as package.json', async () => {
    const [server, pkg] = await Promise.all([readJson('server.json'), readJson('package.json')]);
    expect(server.version).toBe(pkg.version);
  });

  it('points its only remote at the Streamable HTTP route', async () => {
    const server = await readJson('server.json');
    expect(server.remotes).toHaveLength(1);
    expect(server.remotes[0].type).toBe('streamable-http');
    expect(server.remotes[0].url).toMatch(/\/mcp\/\{project\}$/);
  });
});
