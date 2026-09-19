# The golden set

This directory is an instrument. `npm run eval` indexes `corpus/`, asks every question in
`golden.jsonl` through the product's own search path, and prints `recall@1`, `recall@5`, `MRR` and the
mean similarity of the correct hit — overall, by language and by tag — plus the worst misses and what
came back instead.

It then asks the questions in `negative.jsonl`, whose right answer is **nothing**, and prints three
refusal rates beside the retrieval numbers ([ADR-0045](../../.ssot/ADR.md#adr-0045)).

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

The Phase 0 baseline, and what each Phase 1 change did to it, are in [BASELINE.md](BASELINE.md).

## It is also a gate

Given a floor, the run fails instead of merely reporting ([ADR-0044](../../.ssot/ADR.md#adr-0044)):

```bash
npm run eval -- --min-recall5=0.675 --min-heading5=0.650   # what CI runs
```

Below either number the run exits `2` and prints both figures, the questions behind them and the
configuration they were measured at. A harness failure — a malformed question, a corpus file that
produced no chunks — is still exit `1`: "retrieval got worse" and "this run measured nothing" are
different news and should not share an exit code. With no floor the command is the report it always
was and exits `0` whatever it finds, which is what sweeping a setting on a laptop needs.

**Two floors, because they fail differently.** `recall@5` asks whether the right page came back;
`heading@5` asks whether the right *chunk* of it did. A chunk budget the model cannot read to the end
of keeps the first and loses the second — measured, not supposed: `CHUNK_MAX_TOKENS=496` measures
`recall@5` 85.9 %, over the floor of the day, and `heading@5` 78.1 %, four questions under it.
Cross-lingual retrieval is deliberately **not** gated: it is a known regression at 13.3 % over the thirty
questions that now measure it ([ROADMAP.md](../../.ssot/ROADMAP.md) Item 12), and a gate that is red
before anybody changes anything is a gate that gets switched off.

**Both floors were lowered once, and the reason was arithmetic.** Item 12's first stage added twenty
cross-lingual questions the retriever is known to fail, so the denominator went from sixty-four to
eighty-four and every figure computed over the whole set fell with it — 87.5 % → 69.0 % and 84.4 % →
66.7 %, with the older sixty-four scoring exactly what they scored, every question at the same rank with
the same score to six decimal places. [BASELINE.md](BASELINE.md) carries that control table. It is the
only kind of reason a floor may move down for, and the check on it is that the previous set's numbers
are reproduced in the same commit.

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
| `expectHeading` | no | The heading breadcrumb of the chunk that answers it, matched as a **suffix**: `Docker olmadan` matches `Tek sunucuya kurulum > Docker olmadan`. Scored apart from the file-level metrics, never folded into them — and since [ADR-0044](../../.ssot/ADR.md#adr-0044) it carries a floor of its own. Every question in the set has one. |
| `tags` | no | Free-form. Every tag gets its own row in the report, which is how "identifier queries are the weak spot" becomes visible rather than suspected. |
| `note` | no | Why this question is here, when that is not obvious. Ignored by the scorer. |

The file is line-oriented so that changing three questions of eighty-four produces a diff of three lines.
It is validated with zod on load: a malformed line, a duplicate id or an `expectFile` that is not in the
corpus **fails the run**. A question set that silently shrinks is a number that silently improves.

## The other rule: a question whose right answer is nothing

`negative.jsonl` holds questions the corpus **cannot** answer. They are as load-bearing as the golden
ones and they are written under a rule of their own, because the failure they have is a different
failure: a golden question that stops being answerable fails the run loudly, and a negative question
that stops being *un*answerable fails nothing at all.

**Write it from the corpus outward, before running any search, and say what the corpus would have to
contain.** Read a page, find the thing it plausibly ought to cover and does not, and ask about that. Do
not run the search first, and do not delete a question because the floor lets it through — a question
the floor answers today is the only kind that can show the floor got better tomorrow. That is the
golden set's rule again, and it is abandoned in the same pleasant way.

There are two kinds, and the difference between them is the whole substance of the set:

| `kind` | What it is | Example |
|---|---|---|
| `absent-feature` | Shaped **exactly** like this product, answer genuinely not in the corpus. The page it belongs on exists and scores well, which is what makes these the hard negatives — and the ones an operator actually cares about. | SAML beside the OIDC page; a Kafka sink; a Python SDK; GraphQL |
| `off-domain` | Not about this documentation at all. | sourdough, the offside rule, a React hook |

```json
{"id":"af-en-03","lang":"en","query":"Can I sign in to the browser console with SAML single sign-on?","kind":"absent-feature","note":"Authentication covers API keys, static keys and OIDC. SAML is the obvious fourth and is not there."}
{"id":"od-en-01","lang":"en","query":"How do I keep a sourdough starter alive if I only bake once a week?","kind":"off-domain"}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | As in `golden.jsonl`, and unique within this file. |
| `lang` | yes | The language of the question. |
| `query` | yes | What somebody types. |
| `kind` | yes | `absent-feature` or `off-domain`. Nothing else parses. |
| `note` | on `absent-feature` | **What the corpus would have to contain for this to stop being a negative.** Required there and optional on `off-domain`, because only the first makes a claim about the corpus — and a claim nobody wrote down is a claim nobody can re-check when a page is added. |

**This is a second file and a second schema on purpose.** The obvious alternative is an optional
`expectFile` on the golden row, and it is the wrong one: it would let a real question lose its answer to
a typo and be scored as a question that never had one — a hard failure turned into a shrug, which is
exactly what the rule above exists to prevent. Two files cannot make that mistake, because neither
schema can express the other's row.

## What the refusal rates say, and what they do not

Every run reports three figures at the shipped `SEARCH_SCORE_FLOOR`, and the search that produced them
ran with the floor **off**: it is computed afterwards from the scores by `belowRelevanceFloor`, the
product's own function and its escape hatch, so one indexing pass yields both the floor's cost and its
benefit in numbers that are comparable to each other and to the gated run.

- **false refusal** — how many *golden* questions the floor would refuse, and how many of those had the
  answer inside the top five. That is the floor's price.
- **absent-feature** — how often it fires over the hard negatives.
- **off-domain** — how often it fires over questions about something else entirely.

That is [ADR-0042](../../.ssot/ADR.md#adr-0042)'s three-band table, reproduced from the repository on
every run instead of quoted from a paragraph; today's figures are in [BASELINE.md](BASELINE.md).

**They are reported and they are not gated.** There is no evidence yet for what a defensible floor on a
refusal rate would be, and this repository's own lesson is that a gate without a measured floor under
it is theatre. Nor do the negative questions enter any retrieval denominator: `recall@5` and
`heading@5` are over `golden.jsonl` and nothing else, or ADR-0044's two floors would silently become
floors over a question set nobody argued them from. A unit test asserts exactly that.

**What this still cannot do.** It measures the floor against *this* corpus's negatives — two dozen
questions somebody sat down and invented. An operator's real unanswerable questions are about their own
corpus, and those come from the query log of [ROADMAP.md](../../.ssot/ROADMAP.md) Item 6, not from here.

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
2. **Sections long enough to be split.** With the shipped `CHUNK_MAX_TOKENS=96`, counted with the
   model's own tokenizer, a section of more than roughly 340 characters becomes more than one chunk.
   Several are many times longer than that, so the effect of a change to the chunk budget is visible
   rather than theoretical — the same corpus produces 175 chunks at a 496-token budget and 560 at 96.
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
one correct file, not two. Between a quarter and a third of the questions are cross-lingual, fifteen in
each direction, because a slice too small to move by less than fourteen points cannot measure a fix to
the one defect Phase 1 left behind ([ROADMAP.md](../../.ssot/ROADMAP.md) Item 12).

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
- Add a page → also re-read `negative.jsonl`. A page about SAML turns `af-en-03` into a golden question
  filed as a negative one, and **nothing will go red**: the run will simply report a lower refusal rate.
  Each `absent-feature` row's `note` says what would have to appear for that to happen, which is what
  makes this check possible at all.
- Never edit a page to make a failing question pass. That is the mirror again, wearing a different hat.

## What the numbers mean, and what they do not

They are comparable **only to themselves**: this corpus, these questions, this configuration. `recall@5`
here is not `recall@5` anywhere else, and quoting it outside this repository would be a claim the harness
cannot support. What it supports is "this configuration, against the previous one, on the same
questions".

Eighty-four questions over twenty-six pages is also a small set, and a small set overfits. Taking the
best cell of a parameter sweep on a set this size is the mirror again: a one-question difference is a
1.2-point difference, and `BASELINE.md` has a sweep in it — taken when one question was 1.6 points —
where the same value appears at two non-adjacent points and nowhere between them. A movement of
one or two points is noise. The general fix is not more invented questions — it is feeding the set from
queries people actually asked, which is what the query log of Phase 2 is for. One slice is the
exception, and it is the exception because nothing else could resolve it: the cross-lingual questions
were deliberately grown from seven to thirty so that a change to them is a measurement rather than a
rounding.

`EVAL_TEXT_SEARCH_CONFIG=english npm run eval` runs the lexical half of retrieval in another PostgreSQL
text search configuration — the corpus indexed with it and the questions parsed with it, because running
the two sides apart measures nothing at all. Default `simple`, which is what the product ships
([ADR-0041](../../.ssot/ADR.md#adr-0041)).

Two runs are comparable only if `EMBEDDING_MODEL`, `EMBEDDING_DTYPE`, `CHUNK_MAX_TOKENS`,
`CHUNK_OVERLAP_TOKENS` and the text search configuration were the same. The report prints all four, and the run's `provider.id` with them —
and since [ADR-0038](../../.ssot/ADR.md#adr-0038) that id also carries the query and passage prefixes, so
two runs that differ only in `EMBEDDING_QUERY_PREFIX` are visibly two runs and not one repeated.
