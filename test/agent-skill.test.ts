import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { MCP_PROMPT_NAMES } from '../src/mcp/prompts.js';
import { MCP_TOOL_NAMES } from '../src/mcp/tool-names.js';

/**
 * `skills/contextator/SKILL.md` is an Agent Skill (agentskills.io/specification, checked 2026-10-26;
 * the skill has no ADR of its own, ADR-0104 covers the MCP prompts it also names). The reference validator `skills-ref`
 * is third-party code and is not run here; this file asserts the same constraints on the file in the repository, and that the tool names the skill
 * teaches are the tool names the server has. A tool added to `MCP_TOOL_NAMES` without a mention in the skill, or
 * a name in the skill that no tool has, fails the "tool names" tests below.
 */

const SKILL_URL = new URL('../skills/contextator/SKILL.md', import.meta.url);
const TOOLS_SOURCE_URL = new URL('../src/mcp/tools.ts', import.meta.url);

const ALLOWED_FRONTMATTER_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Words that look like a tool name (`snake_case`: lowercase, digits, at least one underscore) but are not one: the
 * arguments of the tools, the MCP prompts the skill also names (`MCP_PROMPT_NAMES`) and two fields of their answers.
 * The arguments are read off `tools.ts` (every key of a `const xInput = { ... }` block), so a renamed argument cannot
 * leave this list stale. The two answer fields (`next_cursor` of `list_topics`, `history_starts_at` of `whats_new`)
 * are not arguments and are named here.
 *
 * The scan is by word, not by backtick span, over the whole file: `description` (the text a client reads to decide
 * whether to load the skill), `compatibility`, the prose and fenced example blocks. A call written as
 * `search_docs(query: "x")`, a name with a digit, or a name in plain prose is therefore seen as well.
 */
const ANSWER_FIELDS = ['next_cursor', 'history_starts_at'];

const TOOL_LIKE_WORD = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** One place for the rule: true when a tool-shaped word is something other than a tool. */
function isKnownNonTool(word: string, argumentNames: ReadonlySet<string>): boolean {
  return argumentNames.has(word) || ANSWER_FIELDS.includes(word) || MCP_PROMPT_NAMES.includes(word);
}

/** Every argument name the tools accept, from the `*Input` blocks of `src/mcp/tools.ts`. */
function argumentNamesFromToolsSource(source: string): Set<string> {
  const names = new Set<string>();
  const blocks = source.matchAll(/^const \w+Input = \{\n([\s\S]*?)^\};/gm);
  for (const block of blocks) {
    for (const key of (block[1] ?? '').matchAll(/^ {2}([a-z_]+):/gm)) names.add(key[1] as string);
  }
  return names;
}

/** Splits `---\n<yaml>\n---\n<body>`; null when the file does not open with a closed frontmatter block. */
function splitFrontmatter(content: string): { data: unknown; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return null;
  return { data: parseYaml(match[1] as string), body: match[2] as string };
}

/** Tool-shaped words in `text`, wherever they stand. */
function toolLikeWords(text: string): string[] {
  return text.match(TOOL_LIKE_WORD) ?? [];
}

/** Every way `content` (the text of a SKILL.md inside a directory called `directoryName`) departs from the spec or the code. */
function validateSkill(content: string, directoryName: string, argumentNames: ReadonlySet<string>, toolNames: readonly string[]): string[] {
  const problems: string[] = [];

  const split = splitFrontmatter(content);
  if (!split) return ['the file does not open with a closed `---` frontmatter block'];
  const { data, body } = split;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return ['the frontmatter is not a mapping'];
  const front = data as Record<string, unknown>;

  const name = front.name;
  if (typeof name !== 'string') problems.push('name is missing or not a string');
  else {
    if (name.length < 1 || name.length > 64) problems.push(`name is ${name.length} characters, not 1-64`);
    if (!NAME_PATTERN.test(name))
      problems.push(`name "${name}" is not lowercase letters, digits and single hyphens (no leading, trailing or double hyphen)`);
    if (name !== directoryName) problems.push(`name "${name}" differs from its directory "${directoryName}"`);
  }

  const description = front.description;
  if (typeof description !== 'string') problems.push('description is missing or not a string');
  else if (description.length < 1 || description.length > 1024) problems.push(`description is ${description.length} characters, not 1-1024`);

  for (const key of Object.keys(front)) {
    if (!ALLOWED_FRONTMATTER_KEYS.includes(key)) problems.push(`unknown frontmatter key "${key}"`);
  }
  if ('license' in front && typeof front.license !== 'string') problems.push('license is not a string');
  if ('allowed-tools' in front && typeof front['allowed-tools'] !== 'string') problems.push('allowed-tools is not a string');
  if ('compatibility' in front) {
    const compatibility = front.compatibility;
    if (typeof compatibility !== 'string' || compatibility.length < 1 || compatibility.length > 500) {
      problems.push('compatibility is not a string of 1-500 characters');
    }
  }
  if ('metadata' in front) {
    const metadata = front.metadata;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) problems.push('metadata is not a mapping');
    else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== 'string') problems.push(`metadata.${key} is not a string`);
      }
    }
  }

  const lines = content.replace(/\n+$/, '').split('\n').length;
  if (lines >= 500) problems.push(`the file is ${lines} lines, not under 500`);

  // Tool names: a tool-shaped word is a tool unless it is a known argument, prompt or answer field. The frontmatter
  // text a client reads (description, compatibility) is held to the same rule as the body.
  const frontText = [front.description, front.compatibility].filter((value): value is string => typeof value === 'string').join('\n');
  for (const word of new Set([...toolLikeWords(frontText), ...toolLikeWords(body)])) {
    if (!toolNames.includes(word) && !isKnownNonTool(word, argumentNames)) {
      problems.push(`\`${word}\` is neither a tool in MCP_TOOL_NAMES nor a known argument, prompt or answer field`);
    }
  }
  const mentioned = toolLikeWords(body);
  for (const tool of toolNames) {
    if (!mentioned.includes(tool)) problems.push(`tool \`${tool}\` is never mentioned in the body`);
  }

  return problems;
}

const skillPath = fileURLToPath(SKILL_URL);
const skill = readFileSync(SKILL_URL, 'utf8');
const argumentNames = argumentNamesFromToolsSource(readFileSync(TOOLS_SOURCE_URL, 'utf8'));
const directoryName = basename(dirname(skillPath));

const check = (content: string) => validateSkill(content, directoryName, argumentNames, MCP_TOOL_NAMES);

describe('skills/contextator/SKILL.md', () => {
  describe('frontmatter (agentskills.io specification)', () => {
    it('opens with a closed frontmatter block that parses as a mapping', () => {
      const split = splitFrontmatter(skill);
      expect(split).not.toBeNull();
      expect(typeof split?.data).toBe('object');
    });

    it('has a name of 1-64 characters, valid hyphenation, equal to its directory', () => {
      const front = splitFrontmatter(skill)?.data as Record<string, unknown>;
      expect(typeof front.name).toBe('string');
      const name = front.name as string;
      expect(name.length).toBeGreaterThanOrEqual(1);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name).toMatch(NAME_PATTERN);
      expect(name).toBe(directoryName);
    });

    it('has a description of 1-1024 characters', () => {
      const front = splitFrontmatter(skill)?.data as Record<string, unknown>;
      expect(typeof front.description).toBe('string');
      expect((front.description as string).length).toBeGreaterThanOrEqual(1);
      expect((front.description as string).length).toBeLessThanOrEqual(1024);
    });

    it('uses only the keys the specification defines, with the right shapes', () => {
      expect(check(skill).filter((problem) => /frontmatter key|compatibility|metadata|license|allowed-tools/.test(problem))).toEqual([]);
    });

    it('is under 500 lines', () => {
      expect(skill.replace(/\n+$/, '').split('\n').length).toBeLessThan(500);
    });
  });

  describe('tool names', () => {
    it('reads the tool names and the argument names it checks against from the code, not from a copy', () => {
      expect(MCP_TOOL_NAMES.length).toBeGreaterThan(0);
      // `path_prefix` and `max_tokens` are the underscored arguments today; if the source stops yielding them, the
      // block regex above has stopped matching and the check below would flag every argument as an unknown tool.
      expect([...argumentNames]).toEqual(expect.arrayContaining(['query', 'path_prefix', 'max_tokens', 'since', 'note']));
    });

    it('names no tool that MCP_TOOL_NAMES does not have, in the description, compatibility or body (a tool-shaped word is a tool unless it is an argument, a prompt or an answer field)', () => {
      const split = splitFrontmatter(skill);
      const front = split?.data as Record<string, unknown>;
      const text = [front.description, front.compatibility, split?.body].filter((value) => typeof value === 'string').join('\n');
      const unknown = [...new Set(toolLikeWords(text))].filter((word) => !MCP_TOOL_NAMES.includes(word) && !isKnownNonTool(word, argumentNames));
      expect(unknown).toEqual([]);
    });

    it('mentions every tool in MCP_TOOL_NAMES, so a tool added in code without updating the skill breaks this test', () => {
      const mentioned = toolLikeWords(splitFrontmatter(skill)?.body ?? '');
      const missing = MCP_TOOL_NAMES.filter((tool) => !mentioned.includes(tool));
      expect(missing).toEqual([]);
    });
  });

  it('passes the whole check', () => {
    expect(check(skill)).toEqual([]);
  });
});

describe('the validator itself (negative controls, on strings, never on the file)', () => {
  it('fails when name is changed', () => {
    const mutated = skill.replace(/^name: contextator$/m, 'name: contextator-docs');
    expect(mutated).not.toBe(skill);
    expect(check(mutated).join('\n')).toMatch(/differs from its directory/);
  });

  it.each(['Contextator', '-contextator', 'contextator-', 'context--ator', 'context_ator'])('fails on the name "%s"', (name) => {
    const mutated = skill.replace(/^name: contextator$/m, `name: ${name}`);
    expect(check(mutated).join('\n')).toMatch(/is not lowercase letters/);
  });

  it('fails when a tool name is removed everywhere', () => {
    const mutated = skill.replaceAll('`report_gap`', '`report`');
    expect(mutated).not.toBe(skill);
    expect(check(mutated).join('\n')).toMatch(/tool `report_gap` is never mentioned/);
  });

  it('fails when a tool that does not exist is named', () => {
    const mutated = `${skill}\nUse \`delete_document\` to remove a page.\n`;
    expect(check(mutated).join('\n')).toMatch(/`delete_document` is neither a tool/);
  });

  it('fails when a tool is added to the code but not to the skill', () => {
    expect(validateSkill(skill, directoryName, argumentNames, [...MCP_TOOL_NAMES, 'new_tool']).join('\n')).toMatch(
      /tool `new_tool` is never mentioned/,
    );
  });

  it('fails when the description names a tool that does not exist', () => {
    const mutated = skill.replace(/^(description: .*)\bwhats_new\b/m, '$1changes_since');
    expect(mutated).not.toBe(skill);
    expect(check(mutated).join('\n')).toMatch(/`changes_since` is neither a tool/);
  });

  it('fails when compatibility names a tool that does not exist', () => {
    const mutated = skill.replace(/^(compatibility: .*)\breport_gap\b/m, '$1file_gap');
    expect(mutated).not.toBe(skill);
    expect(check(mutated).join('\n')).toMatch(/`file_gap` is neither a tool/);
  });

  it('sees a stale name inside a call, a fenced block, plain prose and with a digit', () => {
    expect(check(`${skill}\nTry \`serch_docs(query: "x")\`.\n`).join('\n')).toMatch(/`serch_docs` is neither a tool/);
    expect(check(`${skill}\n\`\`\`\ndelete_document(path)\n\`\`\`\n`).join('\n')).toMatch(/`delete_document` is neither a tool/);
    expect(check(`${skill}\nUse read_page to read.\n`).join('\n')).toMatch(/`read_page` is neither a tool/);
    expect(check(`${skill}\nUse \`search_docs_v2\` instead.\n`).join('\n')).toMatch(/`search_docs_v2` is neither a tool/);
  });

  it('accepts an argument and an answer field as backticked words', () => {
    expect(check(`${skill}\n\`path_prefix\`, \`next_cursor\`, \`history_starts_at\`\n`)).toEqual([]);
  });

  it('fails without a frontmatter block, or with one that never closes', () => {
    expect(check('# No frontmatter\n')).toHaveLength(1);
    expect(check('---\nname: contextator\n')).toHaveLength(1);
  });

  it('fails on an unknown frontmatter key', () => {
    expect(check(skill.replace('license:', 'licence:')).join('\n')).toMatch(/unknown frontmatter key "licence"/);
  });

  it('fails on a description that is empty or over 1024 characters', () => {
    const description = skill.match(/^description: .*$/m)?.[0] as string;
    expect(check(skill.replace(description, 'description: ""')).join('\n')).toMatch(/description is 0 characters/);
    expect(check(skill.replace(description, `description: ${'x'.repeat(1025)}`)).join('\n')).toMatch(/description is 1025 characters/);
  });

  it('fails on a compatibility over 500 characters and on non-string metadata', () => {
    const compatibility = skill.match(/^compatibility: .*$/m)?.[0] as string;
    expect(check(skill.replace(compatibility, `compatibility: ${'x'.repeat(501)}`)).join('\n')).toMatch(/compatibility is not a string of 1-500/);
    expect(check(skill.replace('  project: contextator', '  project: 3')).join('\n')).toMatch(/metadata.project is not a string/);
  });

  it('fails on 500 lines or more', () => {
    expect(check(`${skill}${'filler\n'.repeat(500)}`).join('\n')).toMatch(/not under 500/);
  });
});
