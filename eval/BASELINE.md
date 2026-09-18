# Baseline — the default configuration, before Phase 1

The Phase 0 baseline, recorded before anything in Phase 1 touched retrieval.
[ROADMAP.md](../../.ssot/ROADMAP.md) Item 3 carries the same table and is the authority; this file is the
product repository's copy, so a checkout of it is self-sufficient. What Item 1's first change did to
these numbers is the second half of this file.

It is recorded including how bad it is. A baseline chosen for how it reads is not a baseline.

| | |
|---|---|
| Commit | `2be2c74` (branch `eval/golden-set`) |
| Date | 2026-09-18 |
| Provider | `local:Xenova/paraphrase-multilingual-MiniLM-L12-v2:fp32` |
| Dimensions | 384 |
| `CHUNK_MAX_TOKENS` | 400 |
| `CHUNK_OVERLAP_TOKENS` | 50 |
| Corpus | 26 documents, 174 chunks |
| Questions | 48 (22 `en`, 26 `tr`; 7 cross-lingual) |
| Search limit | 10, so `MRR` is `MRR@10` |

## The numbers

| group | n | recall@1 | recall@5 | MRR | mean score | heading@1 | heading@5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| **overall** | 48 | **41.7 %** | **70.8 %** | **0.534** | **0.483** | 22.9 % | 45.8 % |
| lang `en` | 22 | 36.4 % | 63.6 % | 0.479 | 0.471 | 18.2 % | 40.9 % |
| lang `tr` | 26 | 46.2 % | 76.9 % | 0.580 | 0.493 | 26.9 % | 50.0 % |

In counts rather than percentages: 20 questions of 48 are answered at rank 1, 34 are answered within
the top 5, and **7 are not in the top 10 at all**. Of the 48 chunks that should have been returned, the
right chunk of the right file — not merely the right file — is at rank 1 eleven times.

## The breakdown that says what to do next

| tag | n | recall@1 | recall@5 | MRR | mean score |
|---|--:|--:|--:|--:|--:|
| `cross-lingual` | 7 | 28.6 % | **42.9 %** | 0.354 | 0.494 |
| `config` | 3 | 0.0 % | **0.0 %** | 0.042 | 0.437 |
| `api` | 2 | 0.0 % | 50.0 % | 0.150 | 0.442 |
| `concepts` | 6 | 16.7 % | 66.7 % | 0.375 | 0.420 |
| `identifier` | 14 | 28.6 % | 78.6 % | 0.446 | 0.443 |
| `install` | 8 | 50.0 % | 62.5 % | 0.561 | 0.464 |
| `troubleshooting` | 7 | 28.6 % | 85.7 % | 0.532 | 0.418 |
| `signing` | 3 | 100.0 % | 100.0 % | 1.000 | 0.685 |
| `scheduler` | 3 | 100.0 % | 100.0 % | 1.000 | 0.631 |

The full per-tag table is what `npm run eval` prints; the rows above are the ones that carry a
conclusion.

**Cross-lingual retrieval is the worst thing here, and it is the capability the README advertises
first.** Three of the seven cross-lingual questions do not return the right file in ten results. All
three are Turkish questions whose answer is an English page; the reverse direction — English question,
Turkish page — answers two of three at rank 1. The multilingual model is not symmetric on this corpus,
and nothing in the product currently notices.

**Reference tables are not retrievable.** Every `config` question fails: an operator asking which
environment variable sets the attempt timeout gets prose about the retry schedule instead of the table
that contains `HALYARD_DISPATCH_TIMEOUT`. This is the dense-retrieval failure mode that Phase 1's
hybrid search exists for, and it is the sharpest evidence in the run that it is needed.

**The mean similarity of a correct hit is 0.483, and the top wrong answers score 0.46 to 0.55.** There
is no threshold that separates a right answer from a wrong one. An agent cannot tell that it has been
given nothing useful, and neither can a score bar in the dashboard.

**Heading-level precision is roughly half of file-level.** `recall@5` is 70.8 % and `heading@5` is
45.8 %: a third of the time the right document is found through the wrong chunk of it. That gap is what
a chunk budget the model cannot actually read looks like, and it is the number to watch through Item 1.

## How long a run takes

Measured on an Apple silicon laptop with Docker Desktop, against a pgvector image that was already
pulled:

| | |
|---|---|
| Cold — empty `.cache/models` | **49 s**, of which 44 s is downloading the 465 MB fp32 model |
| Warm — model cached | **5 s** total: 0.4 s model load, 3.1 s to index 174 chunks, 0.2 s for 48 searches |

A CI runner adds the pgvector image pull to the cold figure. The numbers themselves are identical cold
and warm, which is what a deterministic run should look like and is worth re-checking when it stops
being true.

## Reproducing it

```bash
CHUNK_MAX_TOKENS=400 CHUNK_OVERLAP_TOKENS=50 npm run eval
```

The two settings have to be stated now, because they are no longer the defaults. Two runs are comparable
only if `EMBEDDING_MODEL`, `EMBEDDING_DTYPE`, `CHUNK_MAX_TOKENS` and `CHUNK_OVERLAP_TOKENS` match the
table at the top. The report prints all four so this can be checked rather than assumed.

---

# What Item 1's first change did to it

`npm run eval` with no arguments now measures the configuration below, which is the shipped default.
Nothing about the corpus, the questions or the search path changed; the chunker counts tokens with the
model's own tokenizer instead of characters ÷ 4, spends the budget on the string that is actually
embedded, and the budget itself was swept ([ADR-0036](../../.ssot/ADR.md#adr-0036)).

| | |
|---|---|
| Date | 2026-09-18 |
| Provider | `local:Xenova/paraphrase-multilingual-MiniLM-L12-v2:fp32` (unchanged) |
| `CHUNK_MAX_TOKENS` | 400 → **112** |
| `CHUNK_OVERLAP_TOKENS` | 50 → **28** |
| Corpus | 26 documents, 177 → **452** chunks |
| Chunks longer than the model's 128-token window | 119 of 177 (67 %) → **0 of 452** |

The 177 is the old budget re-measured on this branch, not the 174 in the table above. Two changes move
it by three chunks without moving a single metric: the budget is now charged for the heading breadcrumb,
and the overlap carried into a chunk is dropped when the next block would not fit behind it. Both are
worth knowing about when comparing the two tables.

| group | n | recall@1 | recall@5 | MRR | mean score | heading@1 | heading@5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| **overall** | 48 | **60.4 %** | **79.2 %** | **0.683** | **0.610** | 54.2 % | 75.0 % |
| lang `en` | 22 | 59.1 % | 72.7 % | 0.640 | 0.600 | 45.5 % | 68.2 % |
| lang `tr` | 26 | 61.5 % | 84.6 % | 0.719 | 0.617 | 61.5 % | 80.8 % |

## The sweep it came out of

Each row is a full `npm run eval`, same corpus, same questions, same model. The chunk count is in the
table on purpose: a smaller budget means more chunks and therefore more shots at the target, and that
effect should be visible rather than hidden inside a percentage.

| `CHUNK_MAX_TOKENS` | overlap | chunks | recall@1 | recall@5 | MRR | mean score | heading@1 | heading@5 |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 400 | 50 | 177 | 41.7 % | 70.8 % | 0.534 | 0.483 | 22.9 % | 45.8 % |
| 256 | 32 | 209 | 52.1 % | 75.0 % | 0.636 | 0.512 | 37.5 % | 60.4 % |
| 112 | 0 | 449 | 58.3 % | 79.2 % | 0.674 | 0.604 | 52.1 % | 72.9 % |
| 112 | 14 | 450 | 58.3 % | 79.2 % | 0.672 | 0.608 | 52.1 % | 72.9 % |
| **112** | **28** | **452** | **60.4 %** | **79.2 %** | **0.683** | **0.610** | **54.2 %** | **75.0 %** |
| 112 | 50 | 454 | 60.4 % | 79.2 % | 0.683 | 0.608 | 54.2 % | 72.9 % |
| 96 | 0 | 542 | 62.5 % | 79.2 % | 0.691 | 0.613 | 54.2 % | 68.8 % |
| 96 | 12 | 542 | 62.5 % | 79.2 % | 0.691 | 0.615 | 54.2 % | 68.8 % |
| 96 | 24 | 543 | 64.6 % | 77.1 % | 0.700 | 0.615 | 56.2 % | 68.8 % |
| 96 | 50 | 543 | 62.5 % | 79.2 % | 0.690 | 0.613 | 54.2 % | 68.8 % |

**400 reproduces the baseline to the digit.** That is the control: the counting change on its own moves
nothing, so everything else in the table is the budget rather than the mechanism.

**112 and 96 tie on `recall@5`, and 96's extra 90 chunks buy nothing at five.** They buy two to four
percentage points of `recall@1`, which is two questions of forty-eight, and they cost 20 % more rows to
store, embed and search. 112 has the better `heading@5` — the number that says the right *chunk* was
found and not merely the right file — and it is exactly `128 − CHUNK_BUDGET_RESERVE_TOKENS`, so the
shipped default is what the product's own budget check suggests and a default install no longer warns
about itself.

**The overlap barely matters at this budget, and the table says so.** 112 with no overlap produces 449
chunks and 112 with an overlap of 50 produces 454: once the budget is near the size of a paragraph, the
tail of the previous chunk rarely fits behind the next block and is dropped. 28 was chosen because what
has to survive a boundary is a sentence, and a sentence does not get shorter because the budget did — a
proportional 14 would not carry one Turkish sentence. It measured at least as well as 0, 14 and 50 on
every metric.

A movement of one or two points on forty-eight questions is noise; `README.md` in this directory says
so and it applies to this table too. What is not noise is the 400 → 112 column: `recall@5` +8.4 points,
`heading@5` +29.2.
