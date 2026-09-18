# The golden set

This directory is an instrument. `npm run eval` indexes `corpus/`, asks every question in
`golden.jsonl` through the product's own search path, and prints `recall@1`, `recall@5`, `MRR` and the
mean similarity of the correct hit — overall, by language and by tag — plus the worst misses and what
came back instead.

It exists because Phase 1 of the roadmap rewrites retrieval — the chunk budget, the embedding model,
query and passage prefixes, hybrid search, filters — and every one of those changes would otherwise be
judged by reading five search results and squinting. The decision and the alternatives are
[ADR-0034](../../.ssot/ADR.md#adr-0034); the requirements are FR-190 to FR-195 and NFR-17 in
[PRD.md](../../.ssot/PRD.md).

```bash
npm run eval                      # a fresh database in a container, dropped at the end
npm run eval -- --markdown        # the same report as Markdown tables
npm run eval -- --json > run.json # the same numbers for a machine
EVAL_DATABASE_URL=postgres://… npm run eval   # use a server you already have
```

The Phase 0 baseline, and what the first Phase 1 change did to it, are in [BASELINE.md](BASELINE.md).

## The one rule that makes this worth anything

**Write each question from the corpus, before running any search, and keep the ones that fail.**

This is the whole discipline, and it is the easiest thing in the world to quietly abandon, because the
alternative is so much more pleasant. Open the corpus, find a passage, ask the question that passage
answers, write down the file. Do not run the search first. Do not delete a question because the current
retriever cannot answer it, and do not reword one until it starts working.

A golden set assembled by keeping the questions the current retriever already answers is not a
measurement. It is a mirror. It will report a high `recall@5` today and it will report roughly the same
high `recall@5` after Phase 1, whatever Phase 1 actually did — which means it will make a change that
helped and a change that did nothing look identical, and it will do so with a number that everybody
trusts because it came out of a script.

The failures are the point. A question the retriever gets wrong today is the only kind of question that
can show you that something got better tomorrow. At the time this set was written, a large fraction of
it failed. That was recorded rather than fixed.

## What a good question looks like

- **It is a question, not a keyword.** "Docker olmadan nasıl kurulur?" — not "docker kurulum". The thing
  being measured is what an agent and an operator actually type.
- **Exactly one file answers it.** If two pages in the corpus both answer it, the question measures
  nothing, and neither answer can be scored. This is the most common defect in a question, and the
  reason the corpus splits topics across languages rather than translating the same page twice.
- **It does not quote the passage.** A query assembled from the sentence you are aiming at measures
  string overlap. Ask it the way somebody who has not read the page would ask it.
- **Its phrasing is plausible.** Half-remembered identifiers, a symptom instead of a cause, a question
  with a typo in it — those are real queries. The set should not be uniformly well-formed.
- **It is hard when it should be.** Identifier-heavy questions (`HLY-4015`, `HALYARD_QUEUE_POLL_INTERVAL`,
  `X-Halyard-Signature`) are hard for a dense retriever on purpose: Phase 1's hybrid search exists for
  them, and they have to be in the set before that work starts or its effect cannot be seen.

## Adding a question

Append one line to `golden.jsonl`:

```json
{"id":"tr-install-02","lang":"tr","query":"Docker olmadan nasıl kurulur?","expectFile":"tr/kurulum/tek-sunucu.md","expectHeading":"Docker olmadan","tags":["install"]}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique, stable, `^[a-z0-9][a-z0-9-]*$`. It appears in the miss list and in diffs; do not renumber. |
| `lang` | yes | `en` or `tr` — the language of **the question**, not of the answer. This is what the per-language breakdown groups by, so a Turkish question about an English page is `tr`. |
| `query` | yes | What somebody types. |
| `expectFile` | yes | The corpus path that answers it, relative to `corpus/`, exactly as written on disk. |
| `expectHeading` | no | The heading breadcrumb of the chunk that answers it, matched as a **suffix**: `Docker olmadan` matches `Tek sunucuya kurulum > Docker olmadan`. Scored separately and gates nothing. |
| `tags` | no | Free-form. Every tag gets its own row in the report, which is how "identifier queries are the weak spot" becomes visible rather than suspected. |
| `note` | no | Why this question is here, when that is not obvious. Ignored by the scorer. |

The file is line-oriented so that changing three questions of forty-eight produces a diff of three lines.
It is validated with zod on load: a malformed line, a duplicate id or an `expectFile` that is not in the
corpus **fails the run**. A question set that silently shrinks is a number that silently improves.

## The corpus

`corpus/en/**` and `corpus/tr/**` — documentation for a fictional event-relay product called Halyard,
written for this purpose and shaped like real documentation: installation, configuration, an HTTP and a
CLI reference, an error-code table, conceptual pages, troubleshooting, backup, observability, a
changelog.

Three properties are deliberate and should survive any edit, because they are the shapes Phase 1 is
going to fix:

1. **Identifier-dense passages.** Environment variable names, header names, error strings, flags,
   version numbers. A dense retriever is poor at these and hybrid search is the answer; the corpus has to
   contain them now so that the before and after are comparable.
2. **Sections long enough to be split.** With the shipped `CHUNK_MAX_TOKENS=112`, counted with the
   model's own tokenizer, a section of more than roughly 400 characters becomes more than one chunk.
   Several are many times longer than that, so the effect of a change to the chunk budget is visible
   rather than theoretical — the same corpus produces 177 chunks at a 400-token budget and 452 at 112.
3. **Turkish that is genuinely agglutinative.** The Turkish pages were written in Turkish, not translated
   from the English ones. This matters because the entire premise of Phase 1's first item is that an
   XLM-R tokenizer splits Turkish morphology into far more pieces per character than English, so one
   `CHUNK_MAX_TOKENS` means two different chunk sizes in two languages. Translated Turkish — English
   sentence structure with Turkish words in it — does not exhibit that, and a corpus made of it would
   quietly hide the defect it is supposed to expose.

   Measuring it found the bias and found it running the other way: 3.6 characters per token in Turkish
   against 3.4 in English, because the identifier-dense English reference pages fragment harder than
   Turkish morphology does. The property the corpus was given is what made that answerable at all.

The two languages cover **different pages**, not the same pages twice. That is what a half-translated
documentation set actually looks like, and it is what makes a cross-lingual question scoreable: there is
one correct file, not two. Roughly one question in seven is cross-lingual.

`docs/demo/` is deliberately not used. Five files, marketing-shaped, no reference material, and edited
whenever the demo needs to look better — which would move `recall@5` for reasons that have nothing to do
with retrieval.

## Changing the corpus

Changing a page can invalidate a question that depends on it, and nothing will tell you except the
`expectHeading` quietly starting to miss. So:

- Rename a heading → update every question whose `expectHeading` names it.
- Move or rename a file → update every `expectFile`. The run fails loudly if you forget, which is the
  intended outcome.
- Add a page → add at least one question for it. A page nothing asks about is corpus that only makes
  every other question harder.
- Never edit a page to make a failing question pass. That is the mirror again, wearing a different hat.

## What the numbers mean, and what they do not

They are comparable **only to themselves**: this corpus, these questions, this configuration. `recall@5`
here is not `recall@5` anywhere else, and quoting it outside this repository would be a claim the harness
cannot support. What it supports is "this configuration, against the previous one, on the same
questions".

Forty-eight questions over twenty-six pages is also a small set, and a small set overfits. A movement of
one or two points is noise. The real fix is not more invented questions — it is feeding the set from
queries people actually asked, which is what the query log of Phase 2 is for.

Two runs are comparable only if `EMBEDDING_MODEL`, `EMBEDDING_DTYPE`, `CHUNK_MAX_TOKENS` and
`CHUNK_OVERLAP_TOKENS` were the same. The report prints all four, and the run's `provider.id` with them.
