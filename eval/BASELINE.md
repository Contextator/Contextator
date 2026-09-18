# Baseline — the default configuration, before Phase 1

The last recorded run of `npm run eval`. [ROADMAP.md](../../.ssot/ROADMAP.md) Item 3 carries the same
table and is the authority; this file is the product repository's copy, so a checkout of it is
self-sufficient.

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
npm run eval
```

Two runs are comparable only if `EMBEDDING_MODEL`, `EMBEDDING_DTYPE`, `CHUNK_MAX_TOKENS` and
`CHUNK_OVERLAP_TOKENS` match the table at the top. The report prints all four so this can be checked
rather than assumed.
