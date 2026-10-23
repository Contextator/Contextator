import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCT_FACTS_PATH, buildProductFacts, defaultBindAddress } from '../scripts/build-product-facts.js';
import { DEFAULT_MCP_AUTH } from '../src/db/schema.js';

/**
 * `public/product-facts.json` is a second copy of facts that live in `src/` — the source types, the
 * extensions, the auth modes, the score floor, the tool parameters — written down so the marketing
 * site in the other repository can check its prose against them. A second copy drifts, which is the
 * whole reason that file exists, so the copy is generated and this is the gate on the generation:
 * the committed bytes have to be the bytes the generator produces from today's code. It is
 * `test/dockerhub-description.test.ts` for a file whose reader is another repository.
 *
 * Red here means `npm run build:facts` was not run after a change to something the site quotes.
 */
describe('public/product-facts.json', () => {
  it('is what the generator produces from the current code', () => {
    // Compared as values and not as bytes, because the bytes belong to the formatter: the generator
    // hands the file to Biome on the way out and `biome check .` is what guards its layout. Every
    // fact the site can quote is in this object, so an added, removed or changed one fails here.
    const committed: unknown = JSON.parse(readFileSync(PRODUCT_FACTS_PATH, 'utf8'));
    expect(committed, 'stale: run `npm run build:facts` and commit the result').toEqual(buildProductFacts());
  });

  it('states nothing it cannot read out of the code', () => {
    // The generator has no literals of its own to check, so this checks the next best thing: that the
    // honest escape hatch stays honest. A claim listed in `notMachineReadable` must not also appear
    // as a fact — that would let the site verify a number nothing here actually knows.
    const facts = buildProductFacts();
    for (const claim of Object.keys(facts.notMachineReadable)) {
      expect(facts, `${claim} is both unverifiable and reported as a fact`).not.toHaveProperty(claim);
      expect(facts.notMachineReadable[claim].length, `${claim} needs a reason a reader can act on`).toBeGreaterThan(40);
    }
  });

  it('describes every tool the MCP server registers', () => {
    // The tool list is collected by running the registration, not by reading the file as text, so an
    // empty list would mean the collection silently stopped working rather than that the product has
    // no tools. Same for a tool with no parameters at all.
    const { tools } = buildProductFacts();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.title, `${tool.name} has no title`).not.toBe('');
      expect(tool.parameters.length, `${tool.name} has no parameters`).toBeGreaterThan(0);
    }
  });
});

/**
 * ADR-0114: the default MCP auth and the default bind address are facts, and the bind address is read
 * out of the compose files with a YAML parser. The tests below are the proof that the reading refuses
 * to guess — a changed expression or a disagreement between the files stops the build.
 */
describe('default auth and bind address facts', () => {
  const compose = (ports: string) => `services:\n  contextator:\n    image: contextator/contextator\n    ports:\n      # a comment mentioning \${CONTEXTATOR_BIND:-10.0.0.1}:3444:3444\n      - ${ports}\n`;
  const published = (address: string) => `"\${CONTEXTATOR_BIND:-${address}}:\${PORT:-3444}:3444"`;

  it('reports the schema default for the MCP auth mode and loopback for the bind address', () => {
    const facts = buildProductFacts();
    expect(facts.defaultMcpAuth).toBe(DEFAULT_MCP_AUTH);
    expect(facts.defaultMcpAuth).toBe('token');
    expect(facts.mcpAuthModes).toContain(facts.defaultMcpAuth);
    expect(facts.defaultBindAddress).toBe('127.0.0.1');
  });

  it('reads the address from the ports entry and not from a comment', () => {
    const files = { 'docker-compose.yml': compose(published('127.0.0.1')), 'docker-compose.slim.yml': compose(published('127.0.0.1')) };
    expect(defaultBindAddress(files)).toBe('127.0.0.1');
  });

  it('fails when the two compose files publish on different addresses', () => {
    const files = { 'docker-compose.yml': compose(published('127.0.0.1')), 'docker-compose.slim.yml': compose(published('0.0.0.0')) };
    expect(() => defaultBindAddress(files)).toThrow(/different addresses/);
  });

  it('fails when the expression leaves the ${CONTEXTATOR_BIND:-...} shape', () => {
    const files = { 'docker-compose.yml': compose('"127.0.0.1:3444:3444"'), 'docker-compose.slim.yml': compose(published('127.0.0.1')) };
    expect(() => defaultBindAddress(files)).toThrow(/not \$\{CONTEXTATOR_BIND:-<address>\}/);
    const renamed = { 'docker-compose.yml': compose(published('127.0.0.1')), 'docker-compose.slim.yml': compose('"${BIND:-127.0.0.1}:3444:3444"') };
    expect(() => defaultBindAddress(renamed)).toThrow(/not \$\{CONTEXTATOR_BIND:-<address>\}/);
  });

  it('fails when a compose file stops publishing the port at all', () => {
    const files = { 'docker-compose.yml': compose(published('127.0.0.1')), 'docker-compose.slim.yml': 'services:\n  contextator:\n    image: x\n' };
    expect(() => defaultBindAddress(files)).toThrow(/docker-compose\.slim\.yml no longer publishes/);
  });

  it('brings a third compose variant that publishes the port into the check', () => {
    const files = {
      'docker-compose.yml': compose(published('127.0.0.1')),
      'docker-compose.slim.yml': compose(published('127.0.0.1')),
      'docker-compose.extra.yml': compose(published('0.0.0.0')),
    };
    expect(() => defaultBindAddress(files)).toThrow(/different addresses/);
  });

  it('does not mistake another service port for the application port', () => {
    const files = {
      'docker-compose.yml': compose(published('127.0.0.1')),
      'docker-compose.slim.yml': compose(published('127.0.0.1')),
      'docker-compose.dev.yml': compose('"${POSTGRES_HOST_PORT:-5432}:5432"'),
    };
    expect(defaultBindAddress(files)).toBe('127.0.0.1');
  });
});
