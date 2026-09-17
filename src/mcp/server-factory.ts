import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ProjectRow } from '../db/schema.js';
import { registerTools } from './tools.js';

function buildInstructions(project: ProjectRow): string {
  return [
    `Documentation server for the "${project.name}" project (${project.documentCount} documents, ${project.chunkCount} indexed chunks).`,
    'Use search_docs for semantic search: it returns ranked excerpts with file paths and heading breadcrumbs.',
    'Use list_topics to browse the documentation tree, and read_document to read a full file by the path shown in search results.',
    'Answers should cite the file path of the documentation they are based on.',
  ].join(' ');
}

/** One McpServer per client session, bound to exactly one project. */
export function createProjectMcpServer(ctx: AppContext, project: ProjectRow): McpServer {
  const server = new McpServer(
    { name: `contextator-${project.name}`, version: ctx.version },
    { instructions: buildInstructions(project) },
  );
  registerTools(server, ctx, project);
  return server;
}
