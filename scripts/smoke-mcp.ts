/**
 * End-to-end smoke test against a running Contextator server.
 *
 *   npm run smoke -- [url] [query] [--sse]
 *
 * Defaults: url = http://localhost:3444/mcp/${SMOKE_PROJECT ?? 'demo'}, query = "how do I install".
 *
 * Connects with Streamable HTTP first and falls back to legacy SSE (the MCP spec's client algorithm);
 * `--sse` forces the legacy path so both server transports can be exercised.
 *
 * It drives every argument of every tool, including the ones ADR-0043 added: a sectional read whose
 * heading is taken out of the search result printed above it, a token budget small enough to cut, and a
 * one-document page of list_topics so the cursor is exercised on any corpus at all.
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

// `callTool` is typed as a union of the modern result and the legacy `{ toolResult }` shape. The index
// signature keeps this from being a weak type, so the legacy arm is accepted rather than rejected for
// having no property in common; a result without `content` simply reads as empty.
const firstText = (result: { content?: unknown; [key: string]: unknown }): string => {
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

const hit = /^### 1\. (\S+)(?: — (.+?))? \(score/m.exec(firstText(search));
const firstFile = hit?.[1];
const firstHeading = hit?.[2];
if (firstFile) {
  const doc = await client.callTool({ name: 'read_document', arguments: { path: firstFile } });
  console.log(`\n--- read_document("${firstFile}") ${doc.isError ? '[ERROR]' : ''} ---`);
  console.log(firstText(doc).slice(0, 400));

  // The two arguments ADR-0043 added, driven with a breadcrumb taken straight out of the search result
  // above — which is the whole claim: what one tool prints, the next one accepts.
  if (firstHeading) {
    const section = await client.callTool({ name: 'read_document', arguments: { path: firstFile, heading: firstHeading } });
    console.log(`\n--- read_document("${firstFile}", heading: "${firstHeading}") ${section.isError ? '[ERROR]' : ''} ---`);
    console.log(firstText(section).slice(0, 600));
  }
  const budgeted = await client.callTool({ name: 'read_document', arguments: { path: firstFile, max_tokens: 200 } });
  console.log(`\n--- read_document("${firstFile}", max_tokens: 200) ${budgeted.isError ? '[ERROR]' : ''} ---`);
  console.log(firstText(budgeted).slice(-300));
}

// One document per page, so the cursor is exercised on any corpus at all rather than only on a large one.
const page = await client.callTool({ name: 'list_topics', arguments: { limit: 1 } });
const cursor = /next_cursor: (\S+)/.exec(firstText(page))?.[1];
console.log(`\n--- list_topics(limit: 1) ${page.isError ? '[ERROR]' : ''} ---`);
console.log(firstText(page));
if (cursor) {
  const second = await client.callTool({ name: 'list_topics', arguments: { limit: 1, cursor } });
  console.log(`\n--- list_topics(limit: 1, cursor) ${second.isError ? '[ERROR]' : ''} ---`);
  console.log(firstText(second));
}

if (kind === 'streamable') await (transport as StreamableHTTPClientTransport).terminateSession();
await client.close();
process.exit(search.isError ? 1 : 0);
