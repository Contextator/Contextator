/**
 * End-to-end smoke test against a running Contextator server.
 *
 *   npm run smoke -- [url] [query] [--sse]
 *
 * Defaults: url = http://localhost:3444/mcp/${SMOKE_PROJECT ?? 'demo'}, query = "how do I install".
 * Connects with Streamable HTTP first and falls back to legacy SSE (the MCP spec's client algorithm);
 * `--sse` forces the legacy path so both server transports can be exercised.
 */
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const forceSse = process.argv.includes('--sse');
const url = new URL(positional[0] ?? `http://localhost:3444/mcp/${process.env.SMOKE_PROJECT ?? 'demo'}`);
const query = positional[1] ?? 'how do I install';

type TextContent = { type: string; text?: string };

async function connect() {
  if (!forceSse) {
    const client = new Client({ name: 'contextator-smoke', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(url);
    try {
      await client.connect(transport);
      return { client, transport, kind: 'streamable' as const };
    } catch (err) {
      console.warn(`Streamable HTTP failed (${(err as Error).message}); falling back to legacy SSE`);
    }
  }
  const client = new Client({ name: 'contextator-smoke', version: '0.1.0' });
  const transport = new SSEClientTransport(url);
  await client.connect(transport);
  return { client, transport, kind: 'sse' as const };
}

const firstText = (result: { content?: unknown }): string => {
  const content = (result.content as TextContent[] | undefined) ?? [];
  return content.find((c) => c.type === 'text')?.text ?? '';
};

const { client, transport, kind } = await connect();
console.log(`connected to ${url} via ${kind}`);
console.log(`server instructions: ${client.getInstructions() ?? '(none)'}`);

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);

const topics = await client.callTool({ name: 'list_topics', arguments: {} });
console.log('\n--- list_topics ---');
console.log(firstText(topics).split('\n').slice(0, 25).join('\n'));

const search = await client.callTool({ name: 'search_docs', arguments: { query, limit: 3 } });
console.log(`\n--- search_docs("${query}") ${search.isError ? '[ERROR]' : ''} ---`);
console.log(firstText(search).slice(0, 1500));

const firstFile = /^### 1\. (\S+)/m.exec(firstText(search))?.[1];
if (firstFile) {
  const doc = await client.callTool({ name: 'read_document', arguments: { path: firstFile } });
  console.log(`\n--- read_document("${firstFile}") ${doc.isError ? '[ERROR]' : ''} ---`);
  console.log(firstText(doc).slice(0, 400));
}

if (kind === 'streamable') await (transport as StreamableHTTPClientTransport).terminateSession();
await client.close();
process.exit(search.isError ? 1 : 0);
