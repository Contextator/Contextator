import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { MCP_PROMPT_NAMES, PROMPT_ARGUMENT_MAX_LENGTH, registerPrompts } from '../src/mcp/prompts.js';

/**
 * The prompts' shape, without a transport: what is registered, which argument each takes, and the text
 * a `prompts/get` answers with. Both eras are served from the same registrations; that a real client of
 * either SDK generation lists and fetches them is `test/integration/mcp-headers-metrics.itest.ts`.
 */

interface Registered {
  config: { title?: string; description?: string; argsSchema: z.ZodType };
  callback: (args: Record<string, string>) => { messages: Array<{ role: string; content: { type: string; text: string } }> };
}

function collect(projectName: string): Map<string, Registered> {
  const registered = new Map<string, Registered>();
  const server = {
    registerPrompt: (name: string, config: Registered['config'], callback: Registered['callback']) => {
      registered.set(name, { config, callback });
    },
  };
  registerPrompts(server as unknown as McpServer, { name: projectName });
  return registered;
}

describe('registerPrompts', () => {
  const prompts = collect('handbook');

  it('registers exactly the advertised prompts, in order', () => {
    expect([...prompts.keys()]).toEqual([...MCP_PROMPT_NAMES]);
    for (const { config } of prompts.values()) {
      expect(config.title).toBeTruthy();
      expect(config.description).toContain('"handbook"');
    }
  });

  it('answer_from_docs puts the question last and names the tools to use', () => {
    const { messages } = (prompts.get('answer_from_docs') as Registered).callback({ question: 'How do I install it?' });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    const text = messages[0].content.text;
    expect(text).toContain('"handbook"');
    expect(text).toContain('search_docs');
    expect(text).toContain('read_document');
    expect(text.split('\n').at(-1)).toBe('Question: How do I install it?');
  });

  it('explore_topic puts the topic last and names the tools to use', () => {
    const { messages } = (prompts.get('explore_topic') as Registered).callback({ topic: 'installation' });
    const text = messages[0].content.text;
    expect(text).toContain('list_topics');
    expect(text).toContain('search_docs');
    expect(text.split('\n').at(-1)).toBe('Topic: installation');
  });

  it('requires its one argument, non-empty and bounded', () => {
    const question = (prompts.get('answer_from_docs') as Registered).config.argsSchema;
    expect(question.safeParse({}).success).toBe(false);
    expect(question.safeParse({ question: '' }).success).toBe(false);
    expect(question.safeParse({ question: 'x'.repeat(PROMPT_ARGUMENT_MAX_LENGTH + 1) }).success).toBe(false);
    expect(question.safeParse({ question: 'x'.repeat(PROMPT_ARGUMENT_MAX_LENGTH) }).success).toBe(true);

    const topic = (prompts.get('explore_topic') as Registered).config.argsSchema;
    expect(topic.safeParse({}).success).toBe(false);
    expect(topic.safeParse({ topic: 'installation' }).success).toBe(true);
  });
});
