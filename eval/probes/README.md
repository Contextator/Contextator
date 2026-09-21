# Probes — questions that are deliberately *not* in the gate

A probe set is a batch of questions asked to answer one question about the corpus, recorded so the
answer can be checked rather than believed. **Nothing here is read by `npm run eval`.** The harness
reads `eval/golden.jsonl` and `eval/negative.jsonl` and nothing else, so a file in this directory
changes no number in `BASELINE.md` and no floor in [ADR-0044](../../.ssot/ADR.md#adr-0044).

That separation is the point. Adding questions to `golden.jsonl` moves every denominator in
`BASELINE.md` and makes the run before the change incomparable with the run after it (ADR-0034), so a
batch written to *investigate* the corpus must not land there — but it must not evaporate into prose
either, because then the finding it produced cannot be rechecked by anyone.

To run one, append it for a single run and put `golden.jsonl` back afterwards:

```bash
cp eval/golden.jsonl /tmp/golden.keep
cat eval/probes/<file>.jsonl >> eval/golden.jsonl
npm run eval
cp /tmp/golden.keep eval/golden.jsonl
```

Rows are the shape `eval/README.md` documents for the golden set, and every id is prefixed `probe-`
so a report that mixes the two is readable at a glance.

## `turkish-ceiling-2026-09-21.jsonl` — can this corpus measure a Turkish retrieval change?

46 Turkish questions, each asking about a word the page that answers it carries in another inflection:
full sentences, short keyword fragments of the kind an agent sends, and questions seeded with
vocabulary from a competing Turkish page so the dense half has somewhere wrong to go.

Written for [ADR-0064](../../.ssot/ADR.md#adr-0064), which needed to know whether Turkish `recall@5`
*could* move on this corpus before concluding anything from the fact that it did not. **Answer: no.**
All 46 are inside the top five before that change and 44 of them are first, so file-level Turkish
retrieval here is saturated and eleven Turkish documents cannot price a change to the lexical half.
The numbers, both directions, are in `BASELINE.md` under *The lexical half, spoken per chunk*.
