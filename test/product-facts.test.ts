import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCT_FACTS_PATH, buildProductFacts } from '../scripts/build-product-facts.js';

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
