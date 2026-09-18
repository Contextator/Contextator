# Baseline — the default configuration, before Phase 1

The Phase 0 baseline, recorded before anything in Phase 1 touched retrieval.
[ROADMAP.md](../../.ssot/ROADMAP.md) Item 3 carries the same table and is the authority; this file is the
product repository's copy, so a checkout of it is self-sufficient. What Item 1 has done to these numbers
since is the rest of this file, one section per change: the tokenizer and the chunk budget first, then
the retrieval model.

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

---

# What the model swap did to it

`npm run eval` with no arguments now measures `Xenova/multilingual-e5-small` at
`CHUNK_MAX_TOKENS=96` / `CHUNK_OVERLAP_TOKENS=24`, which is the shipped default
([ADR-0037](../../.ssot/ADR.md#adr-0037), superseding [ADR-0007](../../.ssot/ADR.md#adr-0007)). The
corpus, the questions and the search path are the ones above; the model and the budget are not.

The comparison is against the best the old model could do — 112/28 — and **not** against its broken
400/50 default. Both columns were re-measured on this branch.

| | `MiniLM` at 112/28 | `e5-small` at 96/24 |
|---|--:|--:|
| Provider | `local:Xenova/paraphrase-multilingual-MiniLM-L12-v2:fp32` | `local:Xenova/multilingual-e5-small:fp32` |
| Window the model reads | 128 | 512 |
| Corpus | 26 documents, 452 chunks | 26 documents, **560 chunks** |
| recall@1 | 60.4 % | **77.1 %** |
| recall@5 | 79.2 % | **85.4 %** |
| MRR | 0.683 | **0.803** |
| heading@5 | 75.0 % | **81.2 %** |
| lang `en` | 59.1 / 72.7 | **72.7 / 86.4** |
| lang `tr` | 61.5 / 84.6 | **80.8** / 84.6 |
| `cross-lingual` (7 q) | **42.9 / 42.9** | 14.3 / 14.3 |
| mean similarity of a correct hit | 0.610 | 0.890 |

In counts: 37 of 48 questions are answered at rank 1 against 29, and 41 within the top 5 against 38.
Turkish `recall@5` is unchanged at 84.6 % and Turkish `recall@1` rises by five questions.

## The sweep it came out of

Each row is a full `npm run eval` on the same corpus and questions, with the same model, and the chunk
count is in the table for the same reason it was last time: a smaller budget means more chunks and
therefore more shots at the target, and that effect should be visible rather than hidden inside a
percentage. `tr recall@5` has its own column because it is the number the decision was gated on — the
old model's 84.6 % is the floor the new one was not allowed to fall below.

| `CHUNK_MAX_TOKENS` | overlap | chunks | recall@1 | recall@5 | MRR | mean score | heading@5 | `tr` recall@5 |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 496 | 124 | 175 | 72.9 % | 83.3 % | 0.774 | 0.876 | 81.2 % | 80.8 % |
| 384 | 96 | 177 | 72.9 % | 83.3 % | 0.774 | 0.876 | 81.2 % | 80.8 % |
| 256 | 64 | 211 | 75.0 % | 83.3 % | 0.791 | 0.880 | 81.2 % | 80.8 % |
| 192 | 48 | 258 | 77.1 % | 83.3 % | 0.803 | 0.882 | 83.3 % | 80.8 % |
| 144 | 36 | 347 | 79.2 % | 85.4 % | 0.822 | 0.885 | 81.2 % | 80.8 % |
| 128 | 32 | 395 | 70.8 % | 85.4 % | 0.772 | 0.885 | 85.4 % | 80.8 % |
| 120 | 30 | 427 | 72.9 % | 85.4 % | 0.778 | 0.889 | 83.3 % | 80.8 % |
| 112 | 28 | 464 | 75.0 % | 83.3 % | 0.785 | 0.889 | 79.2 % | 80.8 % |
| 108 | 27 | 489 | 79.2 % | 85.4 % | 0.815 | 0.888 | 81.2 % | 84.6 % |
| 104 | 26 | 510 | 77.1 % | 85.4 % | 0.803 | 0.889 | 81.2 % | 84.6 % |
| **96** | **24** | **560** | **77.1 %** | **85.4 %** | **0.803** | **0.890** | **81.2 %** | **84.6 %** |
| 88 | 22 | 627 | 75.0 % | 85.4 % | 0.791 | 0.891 | 79.2 % | 84.6 % |
| 80 | 20 | 682 | 75.0 % | 83.3 % | 0.785 | 0.892 | 77.1 % | 84.6 % |
| 64 | 16 | 921 | 77.1 % | 83.3 % | 0.799 | 0.894 | 81.2 % | 84.6 % |

**Filling the window is the worst thing you can do with it.** 496 is what the budget check suggests
against a 512-token model, and it measures four points of `recall@5` and four of `recall@1` below 96.
A chunk is embedded as one mean-pooled vector, so a longer chunk is an average of more things and points
at nothing in particular; and 175 chunks over the corpus is a third of what 96 produces. The old model's
budget was set by what it could read. This one's is set by what measures best, and the two are nowhere
near each other.

**The plateau is broad and 96 is inside it, not on its edge.** 88, 96, 104 and 108 all measure 85.4 %
`recall@5` and 84.6 % on Turkish; 112 and above drop Turkish to 80.8 % because one question's answer
stops having a chunk of its own. A default sitting one step from that edge would be tuned to this
corpus rather than to the model, so the middle of the plateau was taken over the best single row in it
(108/27, which is better by one question on `recall@1` and cheaper by 71 chunks).

**The overlap does not matter at this budget either**, exactly as it did not at 112:

| `CHUNK_MAX_TOKENS` | overlap | chunks | recall@1 | recall@5 | MRR | mean score | heading@5 | `tr` recall@5 |
|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 96 | 0 | 559 | 77.1 % | 85.4 % | 0.803 | 0.890 | 81.2 % | 84.6 % |
| 96 | 12 | 559 | 77.1 % | 85.4 % | 0.803 | 0.890 | 81.2 % | 84.6 % |
| 96 | 24 | 560 | 77.1 % | 85.4 % | 0.803 | 0.890 | 81.2 % | 84.6 % |
| 96 | 48 | 560 | 77.1 % | 85.4 % | 0.803 | 0.890 | 81.2 % | 84.6 % |

24 is kept for the reason 28 was: a quarter of the budget is about one sentence, and a sentence does not
get shorter because the budget did.

## Two results that are worth more than the headline

**Cross-lingual retrieval collapsed, from 42.9 % to 14.3 %.** Six of the seven cross-lingual questions
now miss the top ten. The model prefers a passage in the language of the question: `HLY-4015 hatası ne
anlama geliyor?` returns Turkish troubleshooting pages about other error codes rather than the English
reference table that defines this one. This is the same-language bias of a retrieval-trained encoder, and
it is **flat across the entire sweep** — 14.3 % at every budget from 64 to 496. It is not a chunking
effect and no budget recovers it. The baseline at the top of this file already called cross-lingual
retrieval "the worst thing here"; it is now worse, against everything else being better, and it is the
one thing the swap costs.

**The `query: ` / `passage: ` prefixes recover none of it.** As a throwaway experiment — not shipped,
not implemented as an interface, and to be re-done properly in PR 1.4 — the two prefixes were prepended
by hand to both sides of the eval and the run repeated:

| | without prefixes | with prefixes, by hand |
|---|--:|--:|
| 96/24 recall@5 | 85.4 % | 85.4 % |
| 96/24 recall@1 | 77.1 % | 79.2 % |
| 96/24 `tr` recall@1 | 80.8 % | 84.6 % |
| 96/24 `cross-lingual` | 14.3 % | 14.3 % |
| 192/48 recall@5 | 83.3 % | 81.2 % |
| 496/124 recall@5 | 83.3 % | 81.2 % |

One question of `recall@1`, nothing at `recall@5`, nothing at all cross-lingually, and a loss at the
large budgets. The roadmap's expectation was that a model used without its prefixes "quietly
underperforms and the switch looks like a failure". On this corpus the switch does not look like a
failure and the prefixes are not what is holding cross-lingual retrieval back. PR 1.4 should still add
them — they are how the model was trained and they cost nothing — but it should not be surprised when
the number does not move, and it should not be sold on this evidence as the cross-lingual fix.

**Similarity scores are compressed and every threshold has to be re-learnt.** A correct hit averaged
0.610 with the old model and averages 0.890 with this one, but a *wrong* hit averaged 0.470 and now
averages 0.853. The gap between right and wrong shrank from 0.09 to 0.02 in absolute terms. Nothing in
the product reads a score for a decision today, which is why this is a note rather than a defect — but
the dashboard's score bar now shows every result as nearly full, and the score floor of Item 7 cannot
reuse any number anybody had in mind before this change.

## Reproducing it

```bash
npm run eval                                                                    # the shipped default
EMBEDDING_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2 \
  CHUNK_MAX_TOKENS=112 CHUNK_OVERLAP_TOKENS=28 npm run eval                     # the old model at its best
```

The second command needs the old model in `.cache/models` and will download it if it is not there.

---

# What the query/passage prefixes did to it

[ADR-0038](../../.ssot/ADR.md#adr-0038). The last of Item 1, and the only one of the four that did not
move `recall@5`. It shipped anyway, on the model card rather than on this table, and the table is here so
that a future reader can check that claim rather than take it.

| | |
|---|---|
| Commit | `3fb3c1e-dirty` (branch `asymmetric-embeddings`) |
| Date | 2026-09-18 |
| Provider | `local:Xenova/multilingual-e5-small:fp32:"query: "+"passage: "` |
| `CHUNK_MAX_TOKENS` | 96 |
| `CHUNK_OVERLAP_TOKENS` | 24 |
| Corpus | 26 documents, 577 chunks (560 without the prefixes) |

The previous section's figures were a throwaway experiment: the two strings prepended by hand, nothing
implemented, and — the part that mattered — nothing charged against the chunk budget. The real
implementation charges it, because `passage: ` is part of the string the model reads, so the corpus packs
into 577 chunks instead of 560 and every boundary in it moved. **The numbers did not.**

| | prefixes off | prefixes on | by hand, previous section |
|---|--:|--:|--:|
| chunks over the corpus | 560 | 577 | 560 |
| recall@1 | 77.1 % | **79.2 %** | 79.2 % |
| recall@5 | 85.4 % | 85.4 % | 85.4 % |
| MRR | 0.803 | **0.818** | – |
| heading@5 | 81.3 % | 81.3 % | – |
| lang `en` recall@1 / @5 | 72.7 / 86.4 | 72.7 / 86.4 | – |
| lang `tr` recall@1 / @5 | 80.8 / 84.6 | **84.6** / 84.6 | 84.6 / – |
| `cross-lingual` (7 questions) | 14.3 % | 14.3 % | 14.3 % |
| mean score of the correct hit | 0.890 | 0.884 | – |

In counts: 37 of 48 questions answered at rank 1 without the prefixes, 38 with. Two arrive — `security`
(0 % → 100 %) and `upgrade` (66.7 % → 100 %) — and one leaves, `getting-started` (100 % → 0 %, and it
stays inside the top five). The one that nets out is Turkish, which is why `tr recall@1` moves by a whole
question while English does not move at all.

**That a 3 % change in the chunking left every headline number where it was is worth more than the
numbers.** It says the effect is a property of the encoder rather than of where the packer happened to
cut, which is the one thing the hand-run experiment could not have told anybody.

**Cross-lingual is untouched for the third time.** 14.3 % without, 14.3 % with, 14.3 % at every budget
from 64 to 496 in the previous section. Nothing in Item 1 was ever going to move it; Item 2's hybrid
search is the remedy.

**Why this shipped on a flat `recall@5`.** Phase 1's rule is that a change which does not move `recall@5`
does not ship. `multilingual-e5-*` is documented by its authors as trained with `query: ` and `passage: `,
and running it without them is running it in a mode its authors say is wrong. Forty-eight questions over
twenty-six pages failing to resolve the difference is weak evidence against a model card, not strong
evidence for ignoring one — and the interface split is right regardless of which model is in place, since
a single `embed()` cannot express an asymmetric model at all. It is also cheap to undo: the two variables
below restore the behaviour *and* the previous provider id byte for byte.

## Reproducing it

```bash
npm run eval                                                                    # the shipped default
EMBEDDING_QUERY_PREFIX=none EMBEDDING_PASSAGE_PREFIX=none npm run eval          # the same model, no prefixes
```

The second is a configuration change and not a code change, which is the point of putting the prefixes
in the provider and the override in the environment.
