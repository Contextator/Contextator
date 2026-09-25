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

**Half of that was refuted on 2026-09-19, and the sentence above is left standing because it is what
this run recorded.** What held is the headline: cross-lingual was the worst thing here, and it got
worse rather than better through every change since. What did not hold is the **direction**. At three
failures the claim rested on which three failed; at fifteen questions in each direction both measure
`recall@5` **13.3 %**, and the gap in `recall@1` — 6.7 % against 13.3 % — is one question. The
measurement is under "What thirty questions say that seven could not" below, and this sentence earned
its keep by being testable: it is the reason the enlarged slice was written fifteen a side.
[ROADMAP.md](../../.ssot/ROADMAP.md)'s copy of the same finding carries the same correction in the same
place, and for the same reason — a refuted sentence that is deleted is a sentence nobody can check.

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

---

# What hybrid search did to it

[ADR-0041](../../.ssot/ADR.md#adr-0041), the last change of Item 2 and the largest of Phase 1. A
`tsvector` beside the vector, a GIN index beside the HNSW one, and reciprocal rank fusion over fifty
candidates from each side. `npm run eval` with no arguments now measures it.

**The golden set was extended first, and the baseline re-recorded on the extended set.** Sixteen
identifier-shaped questions — environment variable names, header values, error codes, build flags,
releases — written from the corpus before any search was run and kept whichever way they fell, by the
rule at the top of [README.md](README.md). Four of the sixteen miss the top five under dense-only.
Comparing hybrid on sixty-four questions against dense-only on forty-eight would have been a decision
wearing a measurement's clothes, so every figure below is against dense-only on the same sixty-four.

The forty-eight that were already here reproduce their published figures exactly — 79.2 % / 85.4 %,
`MRR` 0.818, `heading@5` 81.3 %, `cross-lingual` 14.3 % — which is the control: the sixteen are an
addition to the instrument and not a change to it.

| | |
|---|---|
| Date | 2026-09-18 |
| Provider | `local:Xenova/multilingual-e5-small:fp32:"query: "+"passage: "` (unchanged) |
| `CHUNK_MAX_TOKENS` / overlap | 96 / 24 (unchanged) |
| Corpus | 26 documents, 577 chunks (unchanged) |
| Questions | **64** (31 `en`, 33 `tr`; 10 cross-lingual; 30 identifier-shaped) |
| Text search configuration | `simple`, on both sides |

## The three numbers the change was gated on, separately

| group | dense-only `recall@1` / `@5` | hybrid `recall@1` / `@5` |
|---|--:|--:|
| **1 — the 30 `identifier` questions** | 76.7 / 76.7 | **70.0** / **83.3** |
|   …of which, the 16 written for this change | 75.0 / 75.0 | 75.0 / **87.5** |
| **2 — the 34 that are not identifier-shaped** | 79.4 / 88.2 | 79.4 / 88.2 |
| **3 — `cross-lingual`, the original 7** | 14.3 / 14.3 | 14.3 / **14.3** |
|   …all 10, including the 3 added here | 10.0 / 10.0 | 10.0 / **20.0** |
| overall (64) | 78.1 / 82.8 | **75.0** / **85.9** |
| the 48 that predate this change | 79.2 / 85.4 | **75.0** / 85.4 |
| `MRR` / `heading@5` | 0.803 / 79.7 | 0.799 / **82.8** |
| search time per question | 4.9 ms | 7.5 ms |

**Gate 1 is met at five and missed at one.** `recall@5` on identifier questions goes up 6.6 points, and
on the sixteen written blind for this change 12.5 points — three questions that dense-only could not
find at all. `recall@1` goes *down* 6.7. Both are the same mechanism rather than a gain and a separate
defect: under RRF a chunk found by one retriever alone scores exactly what the other retriever's first
place scores, so a dense rank-1 with no keyword support is displaced by anything ranked respectably on
both lists. It is the trade RRF makes, it is not tunable away without abandoning rank fusion, and it
matters most to a caller that reads only the first hit.

**Gate 2 is met exactly.** The thirty-four natural-language questions measure 79.4 % / 88.2 % before and
after — the same questions, at the same ranks, with `MRR` up 0.005. Whatever the keyword half costs, it
does not cost that.

**Gate 3 did not move, and it is the most useful result in the run.** Item 1's model swap took
cross-lingual `recall@5` from 42.9 % to 14.3 %, and this change leaves it at 14.3 %: not one of those
seven questions moved a place. The one cross-lingual question hybrid gains is a *new* one and an
identifier question — `HALYARD_PAYLOAD_MAX sınırını aşan bir gövde hangi kodla reddedilir?`, a Turkish
question about an English table, answered because the two share a string. So what the lexical half fixes
is cross-lingual *identifier* retrieval, and it does nothing at all for `Yedek alırken önce
veritabanını mı yoksa yük havuzunu mu almalıyım?`, which shares no string with the page that answers it.

Item 2 was the last place Phase 1 had to look for that regression. The remedy is elsewhere: a re-ranker
that reads both languages, or an encoder that is not same-language-biased.

## The measurement that changed the design

The first working implementation OR-ed the question's lexemes and ranked with `ts_rank_cd`, which is
what the plan said. It made retrieval **worse than dense-only**:

| | dense-only | OR, no term filter | shipped |
|---|--:|--:|--:|
| overall `recall@1` / `@5` | 78.1 / 82.8 | 64.1 / **79.7** | 75.0 / 85.9 |
| `identifier` | 76.7 / 76.7 | 50.0 / **70.0** | 70.0 / 83.3 |
| not identifier | 79.4 / 88.2 | 76.5 / 88.2 | 79.4 / 88.2 |
| `MRR` | 0.803 | 0.705 | 0.799 |

`ts_rank_cd` scores term frequency and proximity and has no notion of inverse document frequency, so
`What does HLY-4019 mean?` ranks a paragraph containing *what*, *does* and *mean* above the table
containing `HLY-4019` — three covered terms against two — and fusion then hands that paragraph a rank on
both lists. Twelve questions dense-only answered at rank 1 were pushed down or off the page.

Dropping query terms that appear in more than a twentieth of the project's chunks is what turns it
around. The threshold is the middle of a plateau and not a tuned value:

| term document-frequency ceiling | `recall@1` / `@5` | `identifier` | `cross-lingual` | `MRR` | `heading@5` |
|--:|--:|--:|--:|--:|--:|
| 0.015 | 78.1 / 85.9 | 70.0 / 83.3 | 20.0 | 0.813 | 79.7 |
| 0.02 | 78.1 / 85.9 | 70.0 / 83.3 | 20.0 | 0.813 | 79.7 |
| 0.025 | 78.1 / 85.9 | 70.0 / 83.3 | 20.0 | 0.815 | 82.8 |
| 0.03 | 76.6 / **87.5** | 70.0 / **86.7** | **30.0** | 0.813 | 84.4 |
| 0.035 | 75.0 / 85.9 | 70.0 / 83.3 | 20.0 | 0.801 | 81.3 |
| 0.04 | 76.6 / 85.9 | 73.3 / 83.3 | 20.0 | 0.803 | 84.4 |
| **0.05** | **75.0 / 85.9** | **70.0 / 83.3** | **20.0** | **0.799** | **82.8** |
| 0.06 | 75.0 / 85.9 | 70.0 / 83.3 | 20.0 | 0.798 | 82.8 |
| 0.08 | 75.0 / **87.5** | 70.0 / **86.7** | 20.0 | 0.799 | 84.4 |

87.5 % appears at 0.03 and at 0.08 and nowhere between them. One question, at two points that are not
adjacent, is noise and not a peak — and taking the best cell of an eight-point sweep on sixty-four
questions is the mirror this directory's README warns about. Every value in the range beats dense-only,
which is the result; 0.05 is the middle of it.

The candidate count per side is flat above twenty and 50 is kept for the reason it was chosen — it is
the pool a cross-encoder would later rerank:

| lexical candidates (at 0.05) | `recall@1` / `@5` |
|--:|--:|
| 10 | 73.4 / 85.9 |
| 20 | 73.4 / 85.9 |
| 30 | 75.0 / 85.9 |
| 50 | 75.0 / 85.9 |

## `simple` against stemming

Measured with the configuration applied to both sides at once — the corpus indexed with it and the
questions parsed with it, because running the two apart measures nothing.

| English questions (31) | `simple` | `english` |
|---|--:|--:|
| `recall@1` / `recall@5` | 74.2 / 83.9 | 74.2 / 83.9 |
| identifier-shaped (14) | 71.4 / 78.6 | **78.6** / 78.6 |
| natural-language (17) | **76.5** / 88.2 | 70.6 / 88.2 |
| overall `MRR` (64 questions) | **0.799** | 0.792 |

**The prediction was that `simple` would win on the identifier questions, and it does not.** Stemming
takes that subset by one question at rank 1 and gives one back on the natural-language half; at
`recall@5` the two are identical everywhere. `simple` ships on the reasons that need no measurement:
PostgreSQL has no Turkish configuration, a project here is routinely two languages at once, and an
unstemmed index returns an identifier as the string it is.

**Two of those three reasons were refuted on 2026-09-21, and the paragraph above is left standing
because it is what was written at the time.** PostgreSQL *does* have a Turkish configuration — it is
in `pg_ts_config` on `pgvector/pgvector:pg16`, the image this product ships, and `to_tsvector('turkish',
'anahtarı anahtarın anahtarlar anahtar')` is `'anahtar':1,2,3,4`. And a project being two languages at
once is no longer a reason for one configuration, because since
[ADR-0064](../../.ssot/ADR.md#adr-0064) the query side speaks every configuration the index holds. The
third reason is the one that survived and it is the one this table is about: `simple` stays the
default for a source whose language nobody has named. The measurement is at the bottom of this file.

```bash
npm run eval                                        # the shipped default
EVAL_TEXT_SEARCH_CONFIG=english npm run eval        # the same run, stemmed on both sides
```

## Two defects this found that were not about retrieval

**The eval was not reproducible, and nobody had noticed.** `ts_rank_cd` without normalisation returns
the same score for a great many chunks, and the tie-break was the chunk's uuid — so a fresh database
minted fresh identifiers and the *same* configuration measured `recall@1` anywhere across a nine-point
spread. Five runs of one configuration now agree to the digit. Any number in any earlier section of this
file that was produced by a lexical ranking is suspect; none were, because there was no lexical ranking.

**Two assertions in the integration suite had been failing about one run in three, on this branch and on
the one before it.** pgvector picks each element's HNSW level pseudo-randomly, so the graph differs
between runs and whether one query's hundred global candidates happen to contain ten of a project's
thousand rows differs with it. Seeding PostgreSQL's PRNG is not enough, measured. The two cases now ask
five directions and assert that approximate search without the iterative scan does not *reliably* answer
the project — which is what [ADR-0040](../../.ssot/ADR.md#adr-0040) actually claims.

## Reproducing it

```bash
npm run eval
```

The corpus, the model, the budget and the prefixes are all unchanged from the section above, so the only
difference between the two tables is the search.

---

# What result selection did to it

[ADR-0042](../../.ssot/ADR.md#adr-0042), [ROADMAP.md](../../.ssot/ROADMAP.md) Item 7a. Retrieval is
unchanged here — the same statement finds the same chunks in the same order. What changed is which of
them are handed over, so two of the four settings can move a number and the other two cannot.

| | `recall@1` | `recall@5` | `MRR` | mean score | `heading@5` |
|---|--:|--:|--:|--:|--:|
| **`SEARCH_MAX_PER_DOCUMENT=2`, `SEARCH_SCORE_FLOOR=0.82`** (shipped) | 75.0 % | **87.5 %** | **0.802** | 0.881 | **84.4 %** |
| cap off (`=20`), floor on | 75.0 % | 85.9 % | 0.799 | 0.881 | 82.8 % |
| cap on, floor off (`=0`) | 75.0 % | 87.5 % | 0.802 | 0.881 | 84.4 % |
| both off | 75.0 % | 85.9 % | 0.799 | 0.881 | 82.8 % |
| cap on, floor on, `SEARCH_NEIGHBOR_CONTEXT=0` | 75.0 % | 87.5 % | 0.802 | 0.881 | 84.4 % |

Four things to read out of that.

**The cap gains a question rather than costing one**, which is the opposite of what it was measured to
check. A cap can cost recall when the right answer really is the third chunk of one document; on this
corpus what it displaces is a near-duplicate of an excerpt already on the page, and the slot goes to a
document that was not represented at all. The identifier questions gain most: `recall@5` 83.3 % → 86.7 %.
A cap of 1 measures the same `recall@5` with a better `MRR` (0.810) and a cap of 3 measures exactly like
no cap — 2 is inside that plateau rather than at its edge.

**The floor costs nothing here because nothing reaches it.** Not one of the sixty-four questions has a
top hit below 0.82, so the two floor rows are identical to the digit. That is the floor's *price*
measured, and it is zero; its *benefit* is not measurable from this file, for the reason below.

**Neighbour context is invisible to every metric**, which is the claim it makes: a neighbour carries no
rank and no score, cannot displace a hit and is not counted by the cap. The row is here because "it
changes nothing" is worth one run to establish rather than to assert.

**`recall@1` does not move at all**, at any setting. Both features act below rank 1 by construction: the
cap cannot displace the first excerpt of a page, and the floor either refuses everything or nothing.

## The distributions the floor came out of

These are not in the table above and cannot be, because they need questions the corpus **cannot**
answer, and `golden.jsonl` has none by construction. Twenty-four were written for this — twelve with
nothing to do with the product, twelve shaped exactly like it whose answers are genuinely absent — and
at the time they were **not committed**: a question whose right answer is "nothing" had no `expectFile`,
and this harness was built around one.

The numbers below are that original set's, kept as recorded. They are no longer the last word: the
harness asks a committed negative set now ([ADR-0045](../../.ssot/ADR.md#adr-0045)), and the last
section of this file re-measures every figure below against it — including one that did not survive.

| the top hit of a question | n | min | p10 | median | max |
|---|--:|--:|--:|--:|--:|
| golden, all | 64 | **0.833** | 0.847 | 0.876 | 0.919 |
| golden, correct at rank 1 | 48 | 0.846 | 0.853 | 0.887 | 0.919 |
| shaped like the product, answer absent | 12 | 0.819 | 0.826 | 0.841 | 0.873 |
| nothing to do with the product | 12 | 0.778 | 0.779 | 0.789 | **0.829** |

The third band overlaps the first almost entirely. The fourth clears it by four thousandths. That is the
whole argument for a floor that only claims to catch an off-domain question, and against the 0.85 this
feature is usually written with — which would refuse eight golden questions, four of them with the
answer inside the top five.

## Reproducing it

```bash
npm run eval                                               # the shipped configuration
SEARCH_MAX_PER_DOCUMENT=20 npm run eval                    # without the cap
SEARCH_SCORE_FLOOR=0 npm run eval                          # without the floor
SEARCH_NEIGHBOR_CONTEXT=0 npm run eval                     # without the context
```

The corpus, the model, the budget, the prefixes and the search are all unchanged from the section above,
so the only difference between these runs is what is selected out of what the search found.

---

# The floor this is now a gate over

[ADR-0044](../../.ssot/ADR.md#adr-0044), [ROADMAP.md](../../.ssot/ROADMAP.md) Item 3's last bullet.
Nothing here changes retrieval. What changes is that a run can fail.

> **Both floors below have since moved, and the last section of this file is why.** ROADMAP.md Item 12
> grew the cross-lingual slice from ten questions to thirty, which took the set from sixty-four to
> eighty-four and every whole-set percentage down with it. The numbers in this section are still the
> right numbers *for sixty-four questions* and the sixty-four still measure them exactly; the numbers CI
> enforces are 67.5 % and 65.0 %. Everything this section argues about *why* two floors and *why* one
> question of tolerance is unchanged and is not restated there.

| | |
|---|---|
| Measured at | `7bc4f51`, the last commit of Phase 1's implementation |
| Date | 2026-09-18 |
| Provider | `local:Xenova/multilingual-e5-small:fp32:"query: "+"passage: "` |
| `CHUNK_MAX_TOKENS` / `CHUNK_OVERLAP_TOKENS` | 96 / 24 |
| Corpus | 26 documents, 577 chunks |
| Questions | 64 (31 `en`, 33 `tr`; 10 cross-lingual) |
| Search | `ef_search=100, iterative_scan=relaxed_order, max_scan_tuples=20000`, `to_tsvector('simple', …)`, `max_per_document=2, neighbor_context=1, score_floor=0.82` |

| metric | shipped | floor | slack |
|---|--:|--:|---|
| `recall@5` | **87.5 %** (56 of 64) | **85.5 %** | one question |
| `heading@5` | **84.4 %** (54 of 64) | **82.5 %** | one question |

```bash
npm run eval -- --min-recall5=0.855 --min-heading5=0.825
```

## The measurement has no variance, so the tolerance is not for noise

Six runs, each starting its own pgvector container and carving its own database out of it, at
`7bc4f51` with no arguments. Not merely the same headline: the same ten hits in the same order with the
same scores to six decimal places, for all sixty-four questions, in every run — `recall@1` 75.0 %,
`recall@5` 87.5 %, `MRR` 0.8017361111111112, `heading@5` 84.4 %, mean score 0.881141835322228, 577
chunks.

A seventh run, at the commit that turned the flag into a gate, measured the same figures again — which
is the claim this change has to be able to make about itself: it enforces a number, it does not move
one.

That is worth stating because it was not true three changes ago. Before the lexical tie-breaking was
fixed, `ts_rank_cd` returned the same score for a great many chunks and the order among them was decided
by a random uuid, so five runs of one configuration spread `recall@1` across nine points
([ADR-0041](../../.ssot/ADR.md#adr-0041)). A gate is worth exactly what the measurement's variance says
it is worth, and a gate built on that measurement would have been a coin toss with a percentage printed
on it.

So the tolerance below is **not** an error bar. It exists for the two things that move a number without
anybody intending to move retrieval: an edit to the corpus or the question set, and a dependency bump
that changes what the model computes.

## Why one question, and not two

Sixty-four questions means the metric is quantised: one question is 1.5625 points, and nothing smaller
can happen. A floor is therefore a choice of how many questions may regress, and the only sensible
choices are one and two — zero would fail on a corpus edit, and two is three points, which is most of
the distance Item 2 bought for the whole of hybrid search.

One question it is. `87.5 − 1.5625 = 85.9375`, rounded down to the nearest half point for a number a
human can hold: **85.5 %**. Two questions (84.375 %) fails, which is the point. The same rule gives
`84.375 − 1.5625 = 82.8125` → **82.5 %** for `heading@5`.

The plan for this change proposed a tolerance of 0.02, and 0.02 is what this works out to. It is worth
saying that the two arrived independently: the band that lets exactly one question through is
`(84.375 %, 85.9375 %]` and 85.5 % sits inside it with room on both sides, so the floor survives the
question set growing — at 70 questions one miss is 1.43 points and two are 2.9, and 85.5 % still
separates them.

## Why two numbers, and why not the other three

`recall@5` alone does not cover the largest thing this phase fixed. Measured, at the shipped
configuration except for the one setting named in each row:

| | `recall@1` | `recall@5` | `MRR` | `heading@5` | chunks |
|---|--:|--:|--:|--:|--:|
| **shipped — 96 / 24** | 75.0 % | **87.5 %** | 0.802 | **84.4 %** | 577 |
| `CHUNK_MAX_TOKENS=496` (what the window allows) | 71.9 % | 85.9 % | 0.776 | **78.1 %** | 176 |
| `CHUNK_MAX_TOKENS=400` (the pre-Phase-1 default) | 71.9 % | 85.9 % | 0.780 | **78.1 %** | 177 |
| `CHUNK_MAX_TOKENS=256` | 67.2 % | 84.4 % | 0.752 | 78.1 % | 212 |
| `SEARCH_MAX_PER_DOCUMENT=20` (cap off) | 75.0 % | 85.9 % | 0.799 | 82.8 % | 577 |

**The second row is the argument.** Raising the budget to what the model's window allows — the obvious
move, and the one the product's own chunk-budget check suggests — measures `recall@5` 85.9 %, which
clears a 85.5 % floor, and `heading@5` 78.1 %, which is four questions under it. The right document,
found through the wrong chunk of it: exactly the defect ROADMAP.md Item 1 existed to fix, and exactly
what a file-level gate cannot see. It is also not hypothetical — it is the previous default, one line of
a `.env` away. With both floors that run exits 2:

```
eval: the retrieval gate failed.
  recall@5    85.9% (55 of 64)  above the 85.5% floor
  heading@5   78.1% (50 of 64)  BELOW the 82.5% floor
```

The last row is the one that says the floors are not set too tight: turning off the per-document cap
costs one question on each metric and still passes, which is what "one question of slack" has to mean
to be worth having.

The other three numbers are reported and deliberately not gated.

- **`cross-lingual` is a known regression, not a guard.** 14.3 % on the original seven questions since
  the model swap, 20 % on the ten the set now has. A floor over it would be red on the commit that
  introduced it, before anybody changed anything, and a gate that is red by construction is a gate that
  gets switched off. It is [ROADMAP.md](../../.ssot/ROADMAP.md) Item 12 instead, with a number to beat.
- **`recall@1` was deliberately traded away inside this phase.** Hybrid search took it from 78.1 % to
  75.0 % to buy `recall@5` 82.8 % → 85.9 %, and that trade was argued and accepted
  ([ADR-0041](../../.ssot/ADR.md#adr-0041)). A floor on `recall@1` would have blocked a change this
  repository decided was right, which is the clearest possible evidence that it is the wrong number to
  gate on.
- **`MRR` and the mean score are diagnostics.** `MRR` is largely a restatement of the two floors over a
  window of ten, and the mean similarity of a correct hit is a property of the encoder — it jumped from
  0.483 to 0.881 with the model swap without retrieval improving by anything like that factor.

## Reproducing it

```bash
npm run eval -- --min-recall5=0.855 --min-heading5=0.825   # exits 0 at 87.5 / 84.4
npm run eval -- --min-recall5=0.90  --min-heading5=0.825   # exits 2, and says which number was short
CHUNK_MAX_TOKENS=496 CHUNK_OVERLAP_TOKENS=124 \
  npm run eval -- --min-recall5=0.855 --min-heading5=0.825 # exits 2 on heading@5 alone
```

A change that means to move a floor moves the two numbers in this table and the two in
`.github/workflows/ci.yml` in the same commit, and says why the new figure is the right one. That is the
only mechanism there is; nothing enforces it, which is why it is written here rather than assumed.

---

# The questions whose right answer is nothing

[ADR-0045](../../.ssot/ADR.md#adr-0045). Retrieval is unchanged here and so is the gate: the same
sixty-four questions measure 75.0 / 87.5 / 0.802 / 84.4 at every floor in this section, because a
negative question is in no denominator of any of them. What is new is that the table ADR-0042 argued
`SEARCH_SCORE_FLOOR=0.82` from is now produced by `npm run eval` rather than quoted from a paragraph.

| | |
|---|---|
| Measured at | `2490bf1`, with `eval/negative.jsonl` added |
| Date | 2026-09-18 |
| Negative questions | 24 — 12 `absent-feature`, 12 `off-domain`; 6 of each in each language |
| Everything else | exactly the run above: 26 documents, 577 chunks, `local:Xenova/multilingual-e5-small:fp32`, `CHUNK_MAX_TOKENS=96`, `max_per_document=2, neighbor_context=1` |

The search runs with the floor **off** and the floor is computed from the scores by
`belowRelevanceFloor`, so a sweep is seven runs of one measurement rather than seven measurements.

## The three bands, re-measured

At the shipped floor, and beside what ADR-0042 recorded from the set that was never committed:

| band at `SEARCH_SCORE_FLOOR=0.82` | measured here | ADR-0042 recorded |
|---|--:|--:|
| false refusal — golden questions refused | **0 / 64** | 0 / 64 |
| …of which the answer was inside the top five | **0** | 0 |
| `absent-feature` refused | **1 / 12** | 1 / 12 |
| `off-domain` refused | **10 / 12** | 10 / 12 |

Three figures, reconstructed from questions written independently, landing on the same three counts.
That is a better outcome than this reconstruction deserved, and the distributions underneath say why it
should not be read as a reproduction.

## The distributions, and the sentence that did not survive

| the top hit of a question | n | min | p10 | median | max |
|---|--:|--:|--:|--:|--:|
| golden, all | 64 | **0.833** | 0.846 | 0.876 | 0.919 |
| golden, correct at rank 1 | 48 | 0.846 | 0.853 | 0.887 | 0.919 |
| golden, wrong at rank 1 | 16 | 0.833 | — | 0.860 | 0.876 |
| `absent-feature` | 12 | 0.802 | 0.825 | 0.845 | 0.873 |
| `off-domain` | 12 | 0.794 | 0.802 | 0.808 | **0.839** |

The golden rows are the same rows as ADR-0042's, to the thousandth, which is the control this section
needs: the halves that should agree do agree, and the quantiles differ by a thousandth only because
these are nearest-rank and that entry's were interpolated.

**The `absent-feature` band still sits inside the golden one** — median 0.845 against a golden band that
starts at 0.833 — which is ADR-0042's central claim and the reason the floor promises only to catch an
off-domain question. That claim survives a second, independent set of questions.

**The sentence that did not survive is the other one.** ADR-0042 reads its off-domain ceiling of 0.829
against the golden floor of 0.833 as a separation "by four thousandths". This set's off-domain ceiling
is **0.839**, which is *above* the golden minimum: `od-en-01`, a question about feeding a sourdough
starter, scores higher against this corpus than six golden questions do. There is no threshold that
separates these two classes either. Four thousandths was a property of twelve particular questions, and
a margin that a differently-worded dozen erases was never a margin. The floor's value does not move —
0.82 is below both bands' overlap and refuses ten of twelve off-domain questions anyway — but the
argument for it is now "it catches most off-domain questions and costs nothing", not "it separates
them".

## The sweep

| floor | golden refused | …of which the answer was in the top five | `absent-feature` | `off-domain` |
|---|--:|--:|--:|--:|
| 0.80 | 0 / 64 | 0 | 0 / 12 | 1 / 12 |
| **0.82** (shipped) | **0 / 64** | **0** | **1 / 12** | **10 / 12** |
| 0.83 | 0 / 64 | 0 | 2 / 12 | 10 / 12 |
| 0.84 | 2 / 64 | 0 | 3 / 12 | 11 / 12 |
| 0.845 | 4 / 64 | 1 | 3 / 12 | 11 / 12 |
| 0.85 | 6 / 64 | 3 | 5 / 12 | 11 / 12 |
| 0.855 | 11 / 64 | 8 | 5 / 12 | 11 / 12 |

**The off-domain column is the reconstruction's weakest agreement.** ADR-0042 records 8 of 12 refused
at 0.80 and 12 of 12 from 0.83 upward; this set refuses 1 at 0.80 and never reaches 12. These questions
simply score higher — median 0.808 against 0.789 — and there is no way to tell from here whether the
original dozen were further out or whether a dozen is too few for either number to mean much. The
second explanation is the likelier one and it is also the one that generalises: this column is an
estimate with an error bar of several questions, and nothing should be gated on it.

**The golden column differs from ADR-0042's for a reason worth keeping.** That entry's sweep is a bare
threshold sweep over the top hit: 0, 0, 0, 2, 5, 8, 14 refused — and this run reproduces those counts
exactly when the escape hatch is ignored. The column above is smaller (0, 0, 0, 2, 4, 6, 11) because it
is the floor **as the product ships it**, and an identifier-shaped question whose lexical half matched
something skips the gate ([ADR-0042](../../.ssot/ADR.md#adr-0042), FR-271). At 0.855 the escape hatch
is worth three golden questions.

**And it protects the hard negatives just as effectively**, which is new and is not good news. Under
the same sweep, the questions whose top hit falls below the floor and are spared by the hatch anyway
are, for `absent-feature`: 1 of 3 at 0.83, 3 of 6 at 0.84, 6 of 11 at 0.85. A question shaped exactly
like the product is identifier-shaped and does match the lexical half — that is what makes it a hard
negative — so the hatch fires hardest on precisely the class the floor is already worst at. At the
shipped 0.82 this costs nothing at all: no golden and no negative question is spared by it there. It is
a reason not to raise the floor, and it belongs beside the reasons ADR-0042 already gives.

## Reproducing it

```bash
npm run eval                              # the three bands, at the shipped floor
SEARCH_SCORE_FLOOR=0.85 npm run eval      # one row of the sweep; the golden numbers do not move
```

The negative questions are in `negative.jsonl` and the rule for writing one is in
[README.md](README.md). They gate nothing, and a run that added one to `golden.jsonl` instead would
move `recall@5`, `heading@5` and both floors in `.github/workflows/ci.yml` — which is why they are two
files and why a unit test asserts the denominators do not move.

---

# The cross-lingual slice, enlarged — and the floors it moves

[ROADMAP.md](../../.ssot/ROADMAP.md) Item 12, stage 1. **Nothing here changes retrieval.** What changes
is the denominator: twenty cross-lingual questions are added to `golden.jsonl`, which takes the slice
from ten to thirty and the set from sixty-four to eighty-four, and every percentage in this file that is
computed over the whole set moves with it.

| | |
|---|---|
| Measured at | this commit, over the corpus and configuration of the run above, unchanged |
| Date | 2026-09-19 |
| Provider | `local:Xenova/multilingual-e5-small:fp32:"query: "+"passage: "` |
| `CHUNK_MAX_TOKENS` / `CHUNK_OVERLAP_TOKENS` | 96 / 24 |
| Corpus | 26 documents, 577 chunks — **not touched** |
| Questions | 84 (41 `en`, 43 `tr`); 30 cross-lingual, 15 in each direction |
| Search | `ef_search=100, iterative_scan=relaxed_order, max_scan_tuples=20000`, `to_tsvector('simple', …)`, `max_per_document=2, neighbor_context=1, score_floor=0.82` |

## The old sixty-four still score exactly what they scored

This is the control, and it is the first thing to check, because a question set that grows at the same
time as anything else measures neither.

| the 64 questions that predate this change | before | after |
|---|--:|--:|
| `recall@1` | 75.0 % (48) | 75.0 % (48) |
| `recall@5` | 87.5 % (56) | 87.5 % (56) |
| `MRR` | 0.8017361111111112 | 0.8017361111111112 |
| `heading@5` | 84.4 % (54) | 84.4 % (54) |

Not only the aggregates: **every one of the sixty-four keeps the same rank, the same heading rank and
the same ten hits with the same scores to six decimal places.** Twenty more questions are twenty more
queries against the same index; they cannot move each other, and they did not.

The enlarged set is deterministic on the same terms. Two runs, each starting its own pgvector container
and carving its own database out of it, produce identical hit lists for all eighty-four questions at
full precision — which is the property the whole argument for enlarging the slice rests on
([ADR-0044](../../.ssot/ADR.md#adr-0044)).

## What the whole set measures now

| group | n | recall@1 | recall@5 | MRR | heading@5 |
|---|--:|--:|--:|--:|--:|
| **overall** | 84 | 59.5 % | **69.0 %** (58) | 0.638 | **66.7 %** (56) |
| lang `en` | 41 | 58.5 % | 68.3 % | 0.632 | 63.4 % |
| lang `tr` | 43 | 60.5 % | 69.8 % | 0.643 | 69.8 % |
| the 64 that predate this change | 64 | 75.0 % | 87.5 % | 0.802 | 84.4 % |
| the 20 written for it | 20 | 10.0 % | 10.0 % | 0.113 | 10.0 % |

Eighteen points of `recall@5` and eighteen of `heading@5` are gone from the headline, and none of it is
a regression. It is twenty questions the retriever cannot answer, added on purpose, to a set of
sixty-four it mostly can.

## The floors, re-derived

Eighty-four questions quantise every metric at 1.1905 points. The rule is
[ADR-0044](../../.ssot/ADR.md#adr-0044)'s and it does not change — one question of tolerance, the figure
less one question, rounded down to the nearest half point:

| metric | measured | less one question | floor | previous floor |
|---|--:|--:|--:|--:|
| `recall@5` | 69.0 % (58 of 84) | 67.857 % | **67.5 %** | 85.5 % |
| `heading@5` | 66.7 % (56 of 84) | 65.476 % | **65.0 %** | 82.5 % |

```bash
npm run eval -- --min-recall5=0.675 --min-heading5=0.650   # what CI runs
```

**The floors fell eighteen points and retrieval did not move at all.** That is why ROADMAP.md Item 12
names this as the one Phase 2 change that legitimately moves them, and why the two numbers in
`.github/workflows/ci.yml` and the two in this table are in the same commit as the questions. A reader
who sees only the workflow diff should be able to arrive here and find the old sixty-four unchanged to
six decimal places; the control table above is what makes a moved floor auditable rather than merely
asserted.

## What thirty questions say that seven could not

| slice | n | recall@1 | recall@5 | heading@5 |
|---|--:|--:|--:|--:|
| `cross-lingual`, all | 30 | 10.0 % | **13.3 %** (4) | 13.3 % |
| `xl-tr-en` — Turkish question, English page | 15 | 6.7 % | **13.3 %** (2) | 13.3 % |
| `xl-en-tr` — English question, Turkish page | 15 | 13.3 % | **13.3 %** (2) | 13.3 % |
| `cross-lingual`, the original 7 | 7 | 14.3 % | 14.3 % (1) | 14.3 % |
| `cross-lingual`, the 20 added here | 20 | 10.0 % | 10.0 % (2) | 10.0 % |

Four findings, and two of them are about claims this repository has been carrying since Phase 1.

**The direction asymmetry is not real.** The Phase 0 baseline recorded that "all three of its total
failures are Turkish questions whose answer is an English page; the reverse direction answers two of
three at rank 1", and that asymmetry has been repeated since. At fifteen questions per direction the two
directions measure **13.3 % each**, and the gap in `recall@1` — 6.7 % against 13.3 % — is one question.
Three questions were never enough to see a direction; the asymmetry was a property of which three.

**Every miss returns a page in the language of the question.** Of the thirty cross-lingual questions,
**twenty-seven have a rank-1 hit in the question's own language**, and the three exceptions are exactly
the three that are answered correctly at rank 1. This is the sharpest statement of
[ADR-0037](../../.ssot/ADR.md#adr-0037)'s finding the harness has produced: the encoder is not failing to
understand the question, it is ranking the language of the question above the answer to it. It is a
property of the encoder and not of the chunking, and the enlarged slice confirms rather than weakens
that reading — the corpus and the chunk budget did not change here, and the twenty new questions land in
the same place as the old ten.

**The lexical half fixes cross-lingual identifier retrieval and nothing else — and now with no
counterexample.** Split the thirty by whether the question itself is identifier-shaped:

| | n | recall@5 |
|---|--:|--:|
| carries an identifier | 9 | 44.4 % (4) |
| natural language | 21 | **0 %** (0) |

**Not one natural-language cross-lingual question is answered inside the top five, and not one is
answered inside the top ten either.** [ADR-0041](../../.ssot/ADR.md#adr-0041) said the lexical half
recovers cross-lingual identifier retrieval "and nothing else" on the evidence of one question; twenty-one
questions now say it with nothing arguing the other way.

The five identifier-shaped questions that still miss refine it, and the refinement is the useful part:
the lexical half crosses the language boundary **only when the identifier it matches occurs on one page
and that page is in the other language**. `x-en-tr-15` names `HLY-5030`, which is written on the Turkish
startup page *and* in the English error table — the dense side prefers the English one, and a chunk
found by the lexical retriever alone cannot displace it under RRF. `x-tr-en-01` and `x-en-tr-05` carry no
literal token across at all; they are tagged `identifier` because the *answer* is one, which is a
different thing and was worth finding out.

**And the cleanest single number in the run is the matched pairs.** Nineteen of the thirty cross-lingual
questions point at a file and a heading that a question in the *page's own* language also points at —
same page, same section, same fact, and only the language of the asking differs.

| the same heading, asked… | n | in the top five | rank 1 | not in the top ten |
|---|--:|--:|--:|--:|
| …in the page's own language | 19 | **19** | 15 | 0 |
| …in the other language | 19 | 3 | 2 | **15** |

Nineteen for nineteen against three for nineteen, with the question's content held constant. Whatever is
wrong here, it is not that the cross-lingual questions are harder questions.

## How these twenty were written

Under `README.md`'s rule, and it is worth saying exactly how, because the rule is the only thing that
makes this section worth reading. Every one of the twenty was written from a corpus page before any
search was run: the page was read, a question it answers was written down, and the file and heading were
recorded from the page rather than from a result list. Eighteen of the twenty fail. None was softened,
reworded or deleted after seeing it miss.

Two properties were chosen rather than fallen into:

- **Fifteen in each direction**, because the direction claim above could not be tested otherwise.
- **Twelve of the twenty target a heading against which a same-language question already exists**, which
  is what the matched-pair table above is made of. The set already used this device — `en-backup-01` and
  `x-tr-en-03` are such a pair, and so are `en-env-02` and `x-tr-en-01` — and it is the cleanest
  instrument available for this particular defect, because it removes "that question was harder" as an
  explanation. The pairing was a consequence of writing from the corpus rather than a plan: the same
  passages are the ones worth asking about in either language.

The direction tags `xl-tr-en` and `xl-en-tr` were also added to the ten cross-lingual questions that
predate this change. That is a tag on an existing row and nothing else — no question's text, file or
heading moved, which is why the sixty-four reproduce exactly.

## What a rerank could reach, before one is built

A rerank reorders the fused pool; it cannot add to it. So the number that prices ROADMAP.md Item 12's
second stage is not how good a cross-encoder is — it is **how often the right page is in the pool at
all**, and that is answerable today.

**The pool has two depths, and this section reports both because they are two measurements and the file
used to carry them as one.** A search takes `DENSE_CANDIDATES = 50` from the vector index and
`LEXICAL_CANDIDATES = 50` from `ts_rank_cd`, fuses the two lists with RRF, and only then applies the
per-document cap and the limit ([ADR-0041](../../.ssot/ADR.md#adr-0041)) — so the fused set is **50 to
94 distinct chunks, 73.9 on average over the eighty-four questions**: fifty when the two halves nominate
the same chunks, ninety-four when they almost entirely disagree. *In the top fifty* is a window into
that set — the same eighty-four questions with the result window opened from ten to fifty and the
per-document cap raised to its maximum, which is as close to the pool as the product's own settings
allow. *In the whole fused set* is every chunk either retriever nominated, read off the fusion with no
window and no cap, which is exactly the list `rerankedPage` hands a reranker.

| | in the top 5 | in the top 50 | in the whole fused set |
|---|--:|--:|--:|
| all 84 questions | 69.0 % (58) | 81.0 % (68) | 83.3 % (70) |
| `cross-lingual`, all 30 | 13.3 % (4) | **46.7 % (14)** | **53.3 % (16)** |
| `cross-lingual`, natural language (21) | 0 % (0) | **28.6 % (6)** | **38.1 % (8)** |
| `cross-lingual`, identifier-shaped (9) | 44.4 % (4) | 88.9 % (8) | 88.9 % (8) |

**The last two columns differ by exactly two questions, and both are natural language.** `x-tr-en-13`
sits at rank 53 of a pool of 83 and `x-en-tr-10` at rank 65 of 81; nothing else the fusion nominates for
a cross-lingual question falls outside the first fifty of it, which is why the identifier row does not
move between the two columns and the other two rows do.

**53.3 % is the ceiling on the candidate stage 2 actually built; 46.7 % is the ceiling on one handed
only the first fifty.** Fourteen of the thirty cross-lingual questions have no chunk of the right page
anywhere in the fusion, so no reorderer reaches them at any price; sixteen have none inside the first
fifty. The ten that are in the pool and outside the top five sit at ranks 10, 11, 12, 13, 20, 25, 26,
26, 27 and 43. A perfect rerank — the right chunk first every time it is present — measures 53.3 % over
the whole pool and 46.7 % over a fifty-deep window. One that recovers half of what is reachable and not
already in the top five — six of the twelve, or five of the ten — measures about 33 % or 30 %.

**Both figures bound a *reorderer*, and neither bounds a retriever.** This is the one way the number is
easy to quote one step too far. A reranker can only move what the fusion already handed it, so a page
that is not in the pool is out of its reach by construction — but a **second retriever fused as a third
RRF list changes the pool** rather than reordering it, and nothing measured here says anything about
what such a list would find. The bitext-aligned encoder of the LaBSE class is precisely that candidate,
and it was rejected **on price** — a gigabyte-class download, a second `vector(768)` column and a second
HNSW index, a full re-index on every installation and a change to the `EmbeddingProvider` pooling
contract — and not on this ceiling. [ADR-0052](../../.ssot/ADR.md#adr-0052) states it in those terms and
is the wording to quote.

Two things follow from the ceiling as a bound on reordering, and they point opposite ways, which is the
useful part.

**The ceiling clears the number to beat, and the margin depends on which ceiling.**
`paraphrase-multilingual-MiniLM-L12-v2` managed 42.9 % before
[ADR-0037](../../.ssot/ADR.md#adr-0037) replaced it. A reranker over a fifty-deep window clears that by
3.8 points; one over the whole fused pool, which is what the spike does, clears it by 10.4 — and has to
get **thirteen of the sixteen reachable questions to the top five** to do it. So a rerank is not
arithmetically doomed, but it has to be very nearly perfect against a model this product already had,
and anything short of that lands underneath it.

**The half the product most needs is the half least reachable.** Of the twenty-one natural-language
cross-lingual questions a perfect rerank over the whole pool reaches **eight**, and six over the first
fifty; the other **thirteen** are not in the pool at all, because the encoder that builds it never puts
their page there. Those thirteen are the questions Item 12 exists for, and they are the ones a reranker
is the wrong instrument for — not because reranking is hard, but because it is the wrong operation on
them. The identifier-shaped row is the mirror image and says the same thing about the same mechanism:
88.9 % of them are in the pool at either depth, because the lexical half put them there.

The top-fifty column was taken with a throwaway edit to `SEARCH_LIMIT` in `scripts/eval.ts` and
`SEARCH_MAX_PER_DOCUMENT=20`; the whole-fused-set column and the pool sizes come from `searchChunks`
asked for five hundred results with the cap lifted, which returns the fusion entire. Nothing about
either shipped. They are recorded here because they are the cheapest thing that could have priced the
rerank out, and because a spike that does not check them first would spend its time box discovering
them.

## Reproducing it

```bash
npm run eval -- --min-recall5=0.675 --min-heading5=0.650   # exits 0 at 69.0 / 66.7
npm run eval -- --min-recall5=0.855                        # exits 2: the old floor against the new set
```

The second line is the one to run before reading anything above. It fails, and it should: the floor it
names was argued against sixty-four questions and there are eighty-four now.

---

# What a multilingual cross-encoder rerank did to it

[ROADMAP.md](../../.ssot/ROADMAP.md) Item 12, stage 2 — the time-boxed spike the first stage's ceiling
said was worth one try. It is **off by default and it stays off**: `SEARCH_RERANK=off` is what the gated
`eval` job measures and what the product ships, and the numbers below are why that is not going to
change.

| | |
|---|---|
| Date | 2026-09-19 |
| Rerank | `local-rerank:Xenova/bge-reranker-base:q8`, `max_tokens=128`, `batch=16` |
| On disk | 296 MB — `onnx/model_quantized.onnx` 279.3 MB plus a 17.1 MB tokenizer |
| Where | between the fusion and the truncation, over the **whole** fused candidate pool (50–94 chunks, mean 73.9 — see below) |
| Everything else | the run above, unchanged: 26 documents, 577 chunks, 84 questions, `e5-small` at 96/24 |

**One figure in that row was wrong and is corrected in place (2026-09-19).** The pool was recorded here
as a mean of 73.4 chunks. Re-measured off `searchChunks` with no window and no cap, over the same
eighty-four questions against the same corpus and the same index, it is **73.9** — 73.96 with the
twenty-four negative questions counted too. The bounds, 50 and 94, reproduce exactly, and nothing in
this section or the one above turns on the mean; it is corrected rather than left because a figure in a
row that describes the measurement is one a later reader will re-derive from.

**The pool is the *whole* fusion and not a window into it**, which is what makes the ceiling above apply
here at 53.3 % rather than at 46.7 %: `rerankedPage` scores every chunk either retriever nominated, and
applies the per-document cap and the limit afterwards, over the new ordering.

**The shipped path is byte-identical with the rerank off.** The statement is assembled from the same
fragment it always was, and a run with `SEARCH_RERANK=off` after this change reproduces the run before
it — every question, every rank, every one of the ten hits, every score to six decimal places. That is
the first thing to check about a change that adds a branch to the one search path.

## The three numbers it was judged on

| | rerank off | rerank on | |
|---|--:|--:|---|
| `cross-lingual` (30) `recall@5` | 13.3 % (4) | **33.3 %** (10) | the number to beat is 42.9 % |
| the other 54, `recall@5` | **100.0 %** (54) | 96.3 % (52) | FR-254 |
| the other 54, `recall@1` | **87.0 %** (47) | 68.5 % (37) | |
| the other 54, `heading@5` | **96.3 %** | 87.0 % | |
| overall `recall@1` / `@5` | 59.5 / 69.0 | 48.8 / **73.8** | |
| overall `MRR` | **0.638** | 0.589 | |
| wall clock per search | **11.6 ms** | **1 242.6 ms** | NFR-02 is sub-second |

**It is a real effect and it is not enough.** Twenty points of cross-lingual `recall@5` is six questions
and far outside anything a thirty-question slice calls noise — the whole reason stage 1 built the slice
was so that a movement this size would mean something. It means something, and what it means is that the
rerank lands under the model this product already had. See the next section, which measures that rather
than quoting it.

**It fails FR-254 outright, and that is a rejection rather than a trade.** Natural-language retrieval
was perfect on the other fifty-four questions and is not any more: two lose the top five altogether
(`en-api-02`, 410 Gone, rank 1 → 6; `tr-gunluk-02`, the log level at runtime, rank 2 → 9) and **thirteen
lose rank 1** — six English questions and seven Turkish ones, so the damage is not a property of either
language. A rerank that buys six cross-lingual questions with thirteen rank-1 answers and two documents
has moved the failure, which is the outcome FR-254 names and refuses in advance.

**And it misses NFR-02 by two orders of magnitude.** 1 242.6 ms per search against 11.6 ms today, on an
idle laptop with no indexing run competing for the core. Seventy-three pairs through a 278 M-parameter
XLM-R cross-encoder is simply what that costs; the arithmetic in ROADMAP.md Item 12 predicted ~1 090
GFLOP for this class and the measurement is consistent with it. Quality failed first, so this number
decides nothing — but it forecloses the obvious repair, because the only way to buy the latency back is
a smaller pool or a smaller model, and both take quality away from a figure that is already short.

## The direction split, which is the finding worth keeping

The rerank does not improve cross-lingual retrieval. It improves **one direction** of it.

| | n | off | on | gained | lost |
|---|--:|--:|--:|--:|--:|
| `xl-en-tr` — English question, Turkish page | 15 | 13.3 % | **53.3 %** (8) | 6 | 0 |
| `xl-tr-en` — Turkish question, English page | 15 | 13.3 % | **13.3 %** (2) | 1 | 1 |

Fifteen Turkish questions about English pages, and the rerank nets **zero** — one identifier question
gained (`x-tr-en-02`, `HLY-4015`) and one identifier question lost (`x-tr-en-05`, `HALYARD_PAYLOAD_MAX`,
rank 3 → 10). Every one of the six clean gains is an English question about a Turkish page.

Stage 1 refuted the *encoder's* direction asymmetry — `multilingual-e5-small` fails both directions
equally. This is a different asymmetry belonging to a different model: the cross-encoder can judge an
English question against a Turkish passage and cannot judge a Turkish question against an English one.
The likeliest reading is the one on the model card — `bge-reranker-base`'s training is weighted towards
English and Chinese, so a Turkish *query* is the case it has seen least — and this run cannot prove
causation, only that the split is there and is fifteen questions wide on each side.

It matters more than the headline, because the direction this rerank does nothing for is the one the
product's own audience is in. A Turkish operator asking a Turkish question of English reference
documentation is the case Item 12 exists for, and it is exactly the case that did not move.

## The natural-language slice, which is what the item is about

| the 30 cross-lingual questions | n | off | on |
|---|--:|--:|--:|
| natural language | 21 | 0 % (0) | 14.3 % (3) |
| identifier-shaped | 9 | 44.4 % (4) | 77.8 % (7) |

Three of twenty-one. The rerank is best at exactly what the lexical half was already best at — the
identifier row nearly doubles — and moves three of the twenty-one questions that nothing else has ever
moved. Stage 1 measured that at most **eight** of those twenty-one are reachable at all: eight over the
whole fused set, which is the list this rerank is handed, against six inside the first fifty of it — and
for the other thirteen the biased encoder never puts the page in the pool, so no reordering of it can
reach them. The rerank found three of the eight. Across all thirty it found ten of the sixteen
reachable, which is the same ratio said the other way.

## The number to beat, measured on the same thirty questions

42.9 % is `paraphrase-multilingual-MiniLM-L12-v2` on **seven** questions at its own best budget
([ADR-0037](../../.ssot/ADR.md#adr-0037)). Comparing a figure over thirty questions to a figure over
seven is the denominator mistake this whole item is about, so the previous default was re-run on the
enlarged set — same corpus, same questions, its own 112/28 budget, no prefixes, nothing else changed.

| | MiniLM 112/28 | `e5-small` 96/24 | `e5-small` + rerank |
|---|--:|--:|--:|
| the original 7 cross-lingual | **42.9 %** (3) | 14.3 % (1) | 28.6 % (2) |
| `cross-lingual`, all 30 | **40.0 %** (12) | 13.3 % (4) | 33.3 % (10) |
|   `xl-en-tr` (15) | **60.0 %** (9) | 13.3 % (2) | 53.3 % (8) |
|   `xl-tr-en` (15) | **20.0 %** (3) | 13.3 % (2) | 13.3 % (2) |
|   natural language (21) | **19.0 %** (4) | 0 % (0) | 14.3 % (3) |
| the other 54, `recall@5` | 94.4 % (51) | **100.0 %** (54) | 96.3 % (52) |
| the other 54, `heading@5` | 92.6 % | **96.3 %** | 87.0 % |
| the old 64, `recall@5` | **89.1 %** | 87.5 % | 87.5 % |
| all 84, `recall@5` | **75.0 %** | 69.0 % | 73.8 % |

**The harness reproduces ADR-0037's 42.9 % exactly**, which is the control this comparison needed: the
old model gets three of the original seven, as it did a year of changes ago.

**And 42.9 % was not a small-sample artefact.** On thirty questions the old model measures **40.0 %**.
So the rerank — a second model, 296 MB, and a hundredfold latency — recovers less cross-lingual
retrieval than the encoder this product replaced does with nothing bolted on at all. That is the
sentence the spike was run to be able to write, and it is the end of the candidate.

**Two things in that table must not be misread.**

*The overall row is not an argument for reverting the model.* MiniLM's 75.0 % against 69.0 % over all
eighty-four is real arithmetic and a bad reason to act: this question set deliberately over-weights one
known defect, thirty of eighty-four, which is not what a corpus looks like. On the sixty-four questions
that predate the slice the two are within one question of each other, and on the fifty-four that are not
cross-lingual `e5-small` is clearly ahead — 100 % against 94.4 %, `heading@5` 96.3 % against 92.6 %.
ADR-0037's decision stands on the evidence it was taken on; what has changed is the size of the price,
not the sign of the trade. **Read the slice rows, not the overall row** — the overall row is now a
weighted average whose weights were chosen to make one defect visible.

*Nothing works for a Turkish question about an English page.* MiniLM 20 %, `e5-small` 13.3 %, the rerank
13.3 %. Three configurations, one of them carrying an extra model, and the direction the product's own
audience is in does not move in any of them. Every cross-lingual gain anyone has measured on this corpus
— the old model's, the lexical half's, this rerank's — is in the other direction or is an identifier.

## Reproducing it

```bash
SEARCH_RERANK=on npm run eval                 # 48.8 / 73.8 / 0.589 / 66.7 — 148 s, of which 104 s is searching
npm run eval                                  # the shipped path, unchanged — 5.8 s
EMBEDDING_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2 \
  CHUNK_MAX_TOKENS=112 CHUNK_OVERLAP_TOKENS=28 npm run eval   # the previous default, on this set
```

Two reranked runs over freshly carved databases return identical hits for all eighty-four questions at
full precision, so this measurement has the same zero variance as every other one in this file and the
twenty points are not a sampling artefact.

---

# The lexical half, spoken per chunk (2026-09-21)

[ADR-0064](../../.ssot/ADR.md#adr-0064). The query side stops being one configuration for the whole
instance and becomes one `@@` per configuration the index holds; `turkish` joins the list; the `tr/`
half of this corpus is indexed with it, the way an operator would set the source it stands for.

**The premise that kept `turkish` off the list was never measured and is false.** On
`pgvector/pgvector:pg16`, the image every run in this file uses:

```
select to_tsvector('turkish', 'anahtarı anahtarın anahtarlar anahtar');   → 'anahtar':1,2,3,4
select to_tsvector('turkish', 'API anahtarını nereden alırım')
         @@ plainto_tsquery('turkish', 'api anahtarı');                   → t
select to_tsvector('simple',  'API anahtarını nereden alırım')
         @@ plainto_tsquery('simple',  'api anahtarı');                   → f
```

## The numbers

92 questions: the 84 of the enlarged set plus eight Turkish questions written for this change, each
asking about a word the page carries in another inflection. "Before" is `EVAL_TEXT_SEARCH_CONFIG=simple`,
which is the shipped configuration of [ADR-0041](../../.ssot/ADR.md#adr-0041) exactly.

| group | n | `recall@5` before | after | `heading@5` before | after |
|---|--:|--:|--:|--:|--:|
| all | 92 | 66 | 66 | 63 | **64** |
| lang `en` | 41 | 28 | 28 | 26 | 26 |
| lang `tr` | 51 | 38 | 38 | 37 | **38** |
| `cross-lingual` | 30 | 4 | 4 | 4 | 4 |
| the other 62 | 62 | 62 | 62 | 59 | **60** |
| the original 54 | 54 | **54** | **54** | 52 | 52 |
| `inflection` (new) | 8 | 8 | 8 | 7 | **8** |

**Nothing regressed.** The fifty-four questions ADR-0041 and ADR-0052 gate on are 54 of 54 before and
after, and no question anywhere falls out of the top five or the top five headings. With a single
configuration present the statement is byte-equivalent in behaviour: `EVAL_TEXT_SEARCH_CONFIG=simple`
on this branch returns an *identical rank for all eighty-four* of the original questions, which is the
control this change needed and the reason the table above has a trustworthy "before" column.

**`recall@5` does not move, and on this corpus it cannot.** Every one of the thirteen Turkish
`recall@5` misses is cross-lingual — a Turkish question whose answer is an English page — which is the
limit [ADR-0052](../../.ssot/ADR.md#adr-0052) closed and which this change does not touch, and none of
them moves. Within-Turkish `recall@5` was **36 of 36 before the change**. Eleven Turkish documents is
not enough for within-Turkish file-level retrieval to fail, so this corpus cannot price a Turkish
retrieval change at `recall@5`. It can price it one level down, where the metric is the right
*section*: the Turkish question about `serileştirme` against a page that says `serileştirmesinden` goes
from not returning the right section in ten results to returning it first.

### The ceiling, measured rather than asserted

`eval/probes/turkish-ceiling-2026-09-21.jsonl` holds **46 further Turkish questions** written against
this corpus while looking for headroom: full sentences, short keyword fragments of the kind an agent
actually sends, and questions deliberately seeded with vocabulary from a competing Turkish page. Every
one of them asks about a word the page carries in another inflection.

**They are not in `eval/golden.jsonl` and must not be**, because adding questions moves every
denominator in this file and the numbers above would stop being comparable with the runs before them
(ADR-0034, ADR-0044). To reproduce, append them for one run and put the file back:

```bash
cp eval/golden.jsonl /tmp/golden.keep
cat eval/probes/turkish-ceiling-2026-09-21.jsonl >> eval/golden.jsonl
EVAL_TEXT_SEARCH_CONFIG=simple npm run eval   # before
npm run eval                                  # after
cp /tmp/golden.keep eval/golden.jsonl
```

| the 46 probe questions | before | after |
|---|--:|--:|
| `recall@5` | **46 / 46** | 45 / 46 |
| answered at rank 1 | 44 | 41 |
| `heading@5` | 45 / 46 | 45 / 46 |

**Forty-six of forty-six inside the top five before anything changed, forty-four of them first.** That
is the ceiling, and it is why this change cannot be priced at `recall@5` here — not an argument, a run.

**And one of them gets worse, which is recorded because it is the only negative signal anywhere in this
change.** `probe-p10` — *"Bir kapsamın diğerini kapsamadığı durum hangisi?"* — falls from the second
result to the seventh. Three others lose a single place — `probe-p08`, `probe-p12` and `probe-p24`,
each from first to second — and one gains a single place, `probe-p05` from third to second. This is
weak evidence and is not treated as more: these questions were written in a batch to hunt for headroom
rather than to the standard `eval/README.md` sets for the golden set, and one question over a set of 46
is inside the noise band this file has documented twice. It is all here so that the next person to
touch the lexical half starts from it rather than rediscovering it.

## The mutation, which is what prices the query side

Revert the query side to ADR-0041's — one configuration for the instance, matched against every chunk
regardless of what its `tsvector` was built with — and leave the corpus indexed exactly as above. That
is the configuration a source is in *today* if it names a language.

| | shipped | mutated |
|---|--:|--:|
| all 92 `recall@5` | **66** | 65 |
| all 92 `heading@5` | **64** | 60 |
| `tr` `heading@5` | **38** | 35 |
| the other 62, `recall@5` | **62** | 61 |
| the other 62, `heading@5` | **60** | 56 |

**Three** of the nine cases in `test/integration/lexical-configurations.itest.ts` turn red with it — the
Turkish inflection case, the one that asserts a single search reaches a `turkish` source and a `simple`
source at once, and the one that asserts the start-up reconciliation makes a question answerable. A
wider mutation that *also* stops `replaceDocument` recording the configuration turns a fourth red, the
case that asserts the column is written at all. Those are the two variants and those are their counts;
an earlier draft of this section said six, which was a count taken from a third, botched mutation that
had broken the `simple` half as well and was not the mutation described here.

## One thing got less deterministic, and it is this change's doing

**Runs of the shipped configuration over freshly carved databases are no longer identical, and the set
that differs is not the same set twice.** Over six runs, **13 of the 92 questions** return a
ten-result page that is not identical in all of them: `en-api-01`, `en-api-02`, `en-env-01`,
`en-env-02`, `en-env-03`, `en-errors-01`, `en-obs-01`, `en-trouble-01`, `tr-saklama-02`, `x-en-tr-08`,
`x-en-tr-11`, `x-en-tr-14`, `x-tr-en-14`. Any two of those runs differ on between **4 and 12** of them,
and which ones differ changes with the pair — so a single before/after comparison sees a sample of
this and not its size. Three runs at `EVAL_TEXT_SEARCH_CONFIG=simple` — one configuration, everything
else equal — are identical to the question, so this is the multi-configuration path and not the
harness.

**For four of the thirteen it is not a swap inside the page: a different document is on it.**
`en-api-01`, `en-api-02`, `en-trouble-01` and `tr-saklama-02` each have two sections that drift in and
out of the ten between runs — for `tr-saklama-02`, the Turkish page on `HLY-5030` and the English
*Testing a restore* trade the tenth position. In every one of the four the pair that trades is one
Turkish chunk against one English chunk, which is the mechanism below showing its face.

The mechanism is the uuid backstop [ADR-0041](../../.ssot/ADR.md#adr-0041) left in the fused ordering,
reached through a door this change opened. Ranks are now assigned *within* a configuration, so two
chunks in different configurations can hold the same lexical rank; at that depth neither carries a
dense rank, so their `fused_score` is identical — `1/(60 + n)` on both — and `fused_score desc,
dense_rank asc nulls last, id asc` falls through to `id`, which is `gen_random_uuid()` and fresh in
every database. Before this change two chunks could not share a lexical rank, so the tie could not
arise.

**Every number in this file is reproducible, and that is not the same as the product being
deterministic.** Across the six runs `recall@1` is 58, `recall@5` is 66, `heading@1` is 57,
`heading@5` is 64 and the floor refuses one question — every one of them identical in all six. The
metrics are stable because the movement is mostly below the window they measure.

**It is not, however, below the window the product serves.** `en-errors-01` — *What does HLY-4019
mean?* — returns a different **fifth** result depending on the run: a Turkish `HLY-3001 ve HLY-3002`
section in three of the six, an English *Threat model* section in the other three. `DEFAULT_SEARCH_LIMIT`
is 5, so that is a row an agent is handed by default; `MAX_SEARCH_LIMIT` is 20, so positions six to ten
— where the other twelve move — are served to any caller that asks for them. The narrow statement is
the right one: **no metric this product measures moves, and the page it returns does.** FR-262 says
the same question against the same corpus returns the same answer, and for a project holding two
configurations that is now true only down to the point where the two ranked lists meet.

Fixing it means giving the fused ordering a corpus property to break on before the uuid — the same
correction FR-262 made one level down, applied to the fusion rather than to the candidate lists. That
is a change to the ordering mechanism [ADR-0041](../../.ssot/ADR.md#adr-0041) fixed and
[ADR-0064](../../.ssot/ADR.md#adr-0064) deliberately did not touch, so it was recorded here and put to
the operator rather than slipped in.

### Fixed, 2026-09-21 ([ADR-0067](../../.ssot/ADR.md#adr-0067))

**Everything above this heading stands as what was measured, and the defect it describes is gone.**
The fused ordering is now `fused_score desc, dense_rank asc nulls last, content_length asc,
relative_path asc, chunk_index asc, id asc` — the lexical candidate list's own tie-break lifted one
level, with the uuid kept as a backstop that `(relative_path, chunk_index)` being unique inside a
project and generation makes unreachable.

**Six runs over freshly carved databases now return the same ten results, in the same order, for all
92 questions** — compared pair by pair and page by page, which is the bar the defect itself set: one
before/after comparison samples this and does not size it.

| six runs, after the fix | |
|---|---|
| questions whose ten-result page differs in any of the six | **0 of 92** |
| `recall@1` / `recall@5` | 58 / 66 in all six |
| `heading@1` / `heading@5` | 57 / 64 in all six |
| questions the floor refuses | 1 in all six |

No gate metric moved, and ADR-0041's control still holds: `EVAL_TEXT_SEARCH_CONFIG=simple` returns an
identical rank and heading rank for all eighty-four of the original questions. One question's rank
differs from the *arbitrary* value a pre-fix run happened to produce — `x-en-tr-08`, one of the
thirteen that was a coin toss anyway, now settles at the sixth result. `en-errors-01` returns the same
fifth result every time.

The section above is kept in full rather than replaced. Nothing in the suite caught this before, which
is how it was introduced; `test/integration/lexical-configurations.itest.ts` now manufactures the tie
across six freshly created projects and asserts the order the corpus implies, because asserting
stability alone cannot catch it — within one database the uuids do not move and the same query twice
returns the same page either way.

## Reproducing it

```bash
npm run eval                                  # the shipped default: en/ simple, tr/ turkish
EVAL_TEXT_SEARCH_CONFIG=simple npm run eval   # ADR-0041's run, question for question
EVAL_TEXT_SEARCH_CONFIG=english npm run eval  # the whole corpus stemmed as English
```

`EVAL_TEXT_SEARCH_CONFIG` now names the configuration the **corpus** is indexed with and no longer
touches the query side, because it no longer can: every chunk records what it was built with and the
search reads the index.

# One vector index for the instance, or one per project (2026-09-24)

ROADMAP Item 16, and the fallback [ADR-0040](../../.ssot/ADR.md#adr-0040) named and did not build.
Measured with `scripts/hnsw-tenancy.ts` over `scripts/hnsw-tenancy-corpus.ts`, on
`pgvector/pgvector:pg16` (pgvector 0.8.6), at the shipped scan settings `ef_search` = 100,
`iterative_scan` = relaxed_order, `max_scan_tuples` = 20000. None of this touches `eval/corpus/`: a
single-project corpus cannot see a defect that exists only between projects.

**The corpus is adversarial by construction, and says so.** It is `hnsw-scan.itest.ts`'s six projects
— `tiny` 50, `small` 1 000, four large ones at 5 000 — at scale 1×, and the same six at 10× (210 500
chunks). Every chunk's cosine to the query direction is set exactly: the large projects spread over
`[0.30, 0.99]`, `small` sits in `[0.85, 0.90]`, so every question has many of the *instance's* rows
nearer to it than `small`'s best. How many is printed as **rows ahead**. The ten questions are the
query direction and nine tilted towards it (cosine 0.9). Recall is recall@10 of `searchChunks`'s dense
statement (fifty candidates) against an index-free scan of the same project and generation.

## The numbers

Re-run on 2026-09-25 after review: project creation is now measured the way the product runs it
(`CREATE INDEX CONCURRENTLY`, five samples, and the hundred-tenant loop too), and the plan column
recognises an HNSW index by its access method, so a partition's cloned index reads as one. The
24 September run had costed creation with a plain, writer-blocking `CREATE INDEX` and labelled the
partitioned arm "exact sort". HNSW graphs are not built identically twice, so recall moves by a point
or two between runs (88 → 87 % for partial, 1 → 0 % today).

### Recall of the crowded project (`small`)

"Exact pages" counts the questions whose ten results equalled the exact scan's ten, as a set.

| scale | rows ahead (min / median / max) | arm | recall@10 | exact pages | empty pages | plan | p50 |
|--:|--:|---|--:|--:|--:|---|--:|
| 1× | 1 658 / 1 912 / 2 576 | every arm but partial | 100 % | 10/10 | 0/10 | exact sort | ≤ 0.53 ms |
| 1× | | partial | 100 % | 10/10 | 0/10 | own partial | 0.53 ms |
| 10× | 15 714 / 16 942 / 25 876 | `small` alone in its database | **89 %** | 4/10 | 0/10 | HNSW | 0.92 ms |
| 10× | | **today**: one global index | **0 %** | 0/10 | **9/10** | global HNSW | 68 ms |
| 10× | | today, `max_scan_tuples` = 40 000 | 0 % | 0/10 | 9/10 | global HNSW | 67 ms |
| 10× | | today, `max_scan_tuples` = 80 000 | 0 % | 0/10 | 9/10 | global HNSW | 67 ms |
| 10× | | today, 80 000 and `hnsw.scan_mem_multiplier` = 8 | 0 % | 0/10 | 0/10 | global HNSW | 269 ms |
| 10× | | **partial**: one index per project | **87 %** | 4/10 | 0/10 | own partial | 0.98 ms |
| 10× | | **partitioned**: one partition per project | **88 %** | 4/10 | 0/10 | own partition | 1.05 ms |

`searchChunks` itself, run against the same databases, agrees with the script's own statement: 0 % today, 87 % with per-project indexes, 89 % alone.

**The defect is real and it is silent.** At 10× the crowded project gets an empty page for nine
questions in ten, and nothing in the response says so. Alone in its own database, the same project and
the same questions score 88–89 % — which is the HNSW graph's own ceiling on this corpus, not a tenancy
effect, and the number every candidate is judged against.

**Raising `max_scan_tuples` does nothing, and the reason is a second limit.** The global scan stops at
about 21 000 visited tuples whatever `max_scan_tuples` says (21 133 rows removed by the filter, none
returned), because pgvector 0.8 also caps an iterative scan's memory at `hnsw.scan_mem_multiplier` ×
`work_mem`. Lifting that cap too fills the pages — with the wrong rows: still 0 %, at four times the
latency. The rows `small` needs are behind 16 000 better ones from other projects, and no scan budget
an interactive search can afford reaches them through a graph that is mostly other projects.

### What each strategy costs

"Create a project" is what ships: the project row plus, for partial, `CREATE INDEX CONCURRENTLY`, as
`createProjectVectorIndex` runs it. The plain `CREATE INDEX` beside it is for comparison only.

| scale | arm | HNSW indexes | total size | build | rebuild: next generation written | live / next recall during rebuild | create a project, as shipped (median / max of 5) | plain `CREATE INDEX` (median of 5) | lock the plain DDL takes on `chunks` |
|--:|---|--:|--:|--:|--:|--:|--:|--:|---|
| 1× | today | 1 | 45.0 MB | 1 464 ms | 1 444 ms (1 000 rows) | 100 / 100 % | 0.94 / 2.02 ms | – | none |
| 1× | partial | 6 | 41.2 MB | 1 314 ms | 215 ms | 100 / 100 % | 17 / 18 ms | 15 ms | ShareLock |
| 1× | partitioned | 6 | 41.2 MB | 1 361 ms + 58 ms copy | 208 ms | 100 / 100 % | 1.38 / 2.17 ms | – | AccessExclusiveLock on the parent |
| 10× | today | 1 | 430.7 MB | 117.0 s | 20.5 s (10 000 rows) | **0** / 100 % | 0.48 / 1.15 ms | – | none |
| 10× | partial | 6 | 411.2 MB | 63.3 s | 7.5 s | 86 / 100 % | **100 / 104 ms** | 38 ms | ShareLock |
| 10× | partitioned | 6 | 411.2 MB | 63.6 s + 604 ms copy | 7.4 s | 86 / 100 % | 1.45 / 2.25 ms | – | AccessExclusiveLock on the parent |

"Rebuild" is [ADR-0039](../../.ssot/ADR.md#adr-0039)'s generation swap, measured: `small`'s next
generation written beside the live one, the live generation searched while both exist, the swap, and
the sweep of the old one. **The swap contract survives both candidates unchanged** — both generations
are rows of one project, so they share that project's index or partition, and `index_generation`
stays the post-filter it always was, over one project's rows instead of the instance's. Writing is
2.7× faster under either, because each insert maintains a graph of one project rather than of all six.

**Concurrently is two and a half times the plain build, and it is the one that ships.** A plain
`CREATE INDEX` holds `ShareLock` on `chunks` for its whole run, so every other project's indexing
waits behind an empty project's creation; `CONCURRENTLY` blocks no writer, and pays for it with a
second pass and a wait for the transactions open when it started — a running `pg_dump` among them.

### At a hundred tenants

94 empty projects added to each instance, created as shipped, then the same search and the same
1 000-chunk write.

| scale | arm | HNSW indexes | creating one, as shipped (mean / max) | planning the search | search p50 | 1 000 chunks written, 6 → 100 tenants |
|--:|---|--:|--:|--:|--:|--:|
| 1× | today | 1 | 0.34 / 2.23 ms | 0.08 ms | 0.56 ms | 1 282 → 1 420 ms |
| 1× | partial | 100 | 17 / 20 ms | 0.18 ms | 0.68 ms | 861 → 833 ms |
| 1× | partitioned | 100 | 1.34 / 5.65 ms | 0.20 ms | 0.55 ms | 860 → 837 ms |
| 10× | today | 1 | 0.35 / 1.45 ms | 0.11 ms | 64 ms | 1 998 → 1 967 ms |
| 10× | partial | 100 | **94 / 104 ms** | 0.24 ms | 1.04 ms | 919 → 879 ms |
| 10× | partitioned | 100 | 1.25 / 2.72 ms | 0.14 ms | 0.85 ms | 906 → 864 ms |

**A per-project index is built by scanning the whole table**, so creating an empty project costs in
proportion to the *instance*: 17 ms at 21 050 chunks, 100 ms at 210 500 — about 0.44 µs a chunk past
a small fixed cost — and taking the 10× instance to a hundred projects cost about 94 ms each. A hundred
indexes cost the planner 0.24 ms a search, and writes do not slow at all: an insert maintains only the
index whose predicate it satisfies.

### Why partitioning is not the answer, in its own numbers

Partitioning matches partial indexes on recall (88 % vs 87 %) and latency (1.05 ms vs 0.98 ms), and
creates a project seventy times faster. It loses on what it asks of everything else:

- **`CREATE TABLE … PARTITION OF` takes `AccessExclusiveLock` on `chunks`** — every project's searches
  and writes stop behind every project creation, and behind any long search already running. A
  partial index built `CONCURRENTLY` blocks no reader or writer of `chunks`; other project creations
  and deletions queue behind it.
- **The primary key has to become `(id, project_id)`**, and `chunks_document_chunk_index_uq` has to
  carry `project_id`, because a partitioned table's unique constraints must include the partition key.
- **The migration is a copy of the whole table** (604 ms at 210 500 chunks here, and a full rewrite
  of an operator's largest table) and drizzle cannot describe a partitioned table, so the schema would
  leave generated migrations for hand-written DDL.

Partial indexes need no migration at all: they are created by the bootstrap, and an older build that
finds them recreates its one global index beside them.

## Reproducing it

```bash
npx tsx scripts/hnsw-tenancy.ts --scale 1,10 --probes 10            # about six minutes; Docker
npx tsx scripts/hnsw-tenancy.ts --scale 1 --probes 5 --json out.json # the quick version
```

The script starts its own `pgvector/pgvector:pg16` container unless `HNSW_TENANCY_DATABASE_URL` (or
`EVAL_DATABASE_URL`) points at a server it may create databases on, and drops the databases it created.


---

# The relevance floor across corpus shapes (2026-09-25)

ROADMAP Item 17. `SEARCH_SCORE_FLOOR=0.82` was set by [ADR-0042](../../.ssot/ADR.md#adr-0042) from one
corpus, the synthetic product documentation in `eval/corpus/`, and its note said so: one model, one
corpus. This asks whether the same number means the same thing on a corpus of a different shape, and
measures two ways of letting it differ, before anything in the floor's mechanism changes.

Measured with `scripts/floor-calibration.ts` (corpora and indexing in `scripts/eval-corpora.ts`) through
`searchProject` itself with the floor off, deciding refusals with `belowRelevanceFloor` — the product's
own function, escape hatch included — at whatever floor is being asked about. Nothing in `eval/corpus/`,
`eval/golden.jsonl` or `eval/negative.jsonl` changed, and `scripts/eval.ts` did not change.

Model local:Xenova/multilingual-e5-small:fp32:"query: "+"passage: "; chunking 96/24; max_per_document=2, neighbor_context=1; rerank off; 432 questions are identifier-shaped (the escape hatch can apply).

**The four corpora.**

- **halyard** — `eval/corpus/` with `golden.jsonl` and `negative.jsonl`: the control. Its golden
  numbers here (recall@5 71.7 %, heading@5 69.6 %, one golden question refused at 0.804) are the same
  to the digit as `npm run eval` on the same commit, which is the check that the two indexing loops
  agree.
- **wiki** — the Contextator wiki (28 pages, wiki commit `41e8837`) with
  `eval/probes/floor-wiki-2026-09-25.jsonl`: 30 answerable questions (24 en, 6 tr) and 12
  absent-feature questions, each with a note saying what the wiki would have to contain. Written for
  this measurement by someone who had read the wiki, so read its answerable band as optimistic, and its
  n as small.
- **xquad-tr**, **xquad-en** — the external set (`eval/external/xquad/`, CC BY-SA 4.0): encyclopaedic
  prose, one section per paragraph, 1190 questions per language written by other people.

**Off-domain questions are borrowed across corpora.** halyard and wiki get `negative.jsonl`'s twelve
off-domain rows plus the first question of every XQuAD article (48 tr + 48 en); the XQuAD corpora get
those twelve plus the halyard golden questions and the wiki's answerable ones. Hand-written off-domain
questions score noticeably higher than borrowed ones (on halyard, median 0.807 against 0.762 and 0.748), so the
off-domain refusal rates below are flattered by the borrowed rows. The rows that matter for the floor's
*price*, the answerable ones, are each corpus's own.

## Corpora

| corpus | shape | files | chunks | answerable | absent-feature | off-domain |
|---|---|---:|---:|---:|---:|---:|
| halyard | synthetic product documentation, en + tr, many short sections and identifiers | 26 | 577 | 92 | 12 | 108 |
| wiki | real product user guide (Contextator wiki), en, prose + tables + config blocks | 28 | 1319 | 30 | 12 | 108 |
| xquad-tr | encyclopaedic prose (XQuAD tr), 48 articles, one section per paragraph | 48 | 779 | 1190 | 0 | 134 |
| xquad-en | encyclopaedic prose (XQuAD en), 48 articles, one section per paragraph | 48 | 764 | 1190 | 0 | 134 |

## Top-hit cosine similarity, by class

| corpus | class | n | min | p10 | median | p90 | max |
|---|---|---:|---:|---:|---:|---:|---:|
| halyard | answerable | 92 | 0.804 | 0.845 | 0.871 | 0.908 | 0.919 |
| halyard | ↳ right file at rank 1 | 58 | 0.845 | 0.853 | 0.886 | 0.912 | 0.919 |
| halyard | ↳ right file not at rank 1 | 34 | 0.804 | 0.833 | 0.858 | 0.872 | 0.887 |
| halyard | absent-feature | 12 | 0.802 | 0.804 | 0.839 | 0.873 | 0.874 |
| halyard | off-domain | 108 | 0.696 | 0.729 | 0.758 | 0.808 | 0.839 |
| halyard | ↳ off-domain from negative.jsonl | 12 | 0.794 | 0.794 | 0.807 | 0.828 | 0.839 |
| halyard | ↳ off-domain from xquad-tr | 48 | 0.719 | 0.739 | 0.762 | 0.799 | 0.835 |
| halyard | ↳ off-domain from xquad-en | 48 | 0.696 | 0.720 | 0.748 | 0.793 | 0.836 |
| wiki | answerable | 30 | 0.812 | 0.825 | 0.872 | 0.905 | 0.922 |
| wiki | ↳ right file at rank 1 | 16 | 0.825 | 0.827 | 0.879 | 0.916 | 0.918 |
| wiki | ↳ right file not at rank 1 | 14 | 0.812 | 0.821 | 0.863 | 0.899 | 0.922 |
| wiki | absent-feature | 12 | 0.792 | 0.836 | 0.849 | 0.861 | 0.865 |
| wiki | off-domain | 108 | 0.681 | 0.726 | 0.757 | 0.800 | 0.835 |
| wiki | ↳ off-domain from negative.jsonl | 12 | 0.750 | 0.762 | 0.787 | 0.835 | 0.835 |
| wiki | ↳ off-domain from xquad-tr | 48 | 0.681 | 0.720 | 0.742 | 0.780 | 0.797 |
| wiki | ↳ off-domain from xquad-en | 48 | 0.724 | 0.735 | 0.776 | 0.808 | 0.829 |
| xquad-tr | answerable | 1190 | 0.761 | 0.822 | 0.866 | 0.901 | 0.955 |
| xquad-tr | ↳ right file at rank 1 | 1146 | 0.775 | 0.827 | 0.867 | 0.901 | 0.955 |
| xquad-tr | ↳ right file not at rank 1 | 44 | 0.761 | 0.787 | 0.805 | 0.830 | 0.847 |
| xquad-tr | off-domain | 134 | 0.740 | 0.757 | 0.795 | 0.818 | 0.846 |
| xquad-tr | ↳ off-domain from negative.jsonl | 12 | 0.741 | 0.746 | 0.781 | 0.813 | 0.816 |
| xquad-tr | ↳ off-domain from halyard-golden | 92 | 0.747 | 0.758 | 0.798 | 0.819 | 0.839 |
| xquad-tr | ↳ off-domain from wiki-probes | 30 | 0.740 | 0.754 | 0.776 | 0.814 | 0.846 |
| xquad-en | answerable | 1190 | 0.738 | 0.812 | 0.856 | 0.892 | 0.928 |
| xquad-en | ↳ right file at rank 1 | 1158 | 0.748 | 0.816 | 0.857 | 0.893 | 0.928 |
| xquad-en | ↳ right file not at rank 1 | 32 | 0.738 | 0.760 | 0.788 | 0.822 | 0.850 |
| xquad-en | off-domain | 134 | 0.740 | 0.760 | 0.779 | 0.810 | 0.832 |
| xquad-en | ↳ off-domain from negative.jsonl | 12 | 0.740 | 0.745 | 0.770 | 0.801 | 0.810 |
| xquad-en | ↳ off-domain from halyard-golden | 92 | 0.742 | 0.760 | 0.776 | 0.805 | 0.820 |
| xquad-en | ↳ off-domain from wiki-probes | 30 | 0.759 | 0.765 | 0.786 | 0.810 | 0.832 |

## What 0.82 does on each corpus

`belowRelevanceFloor` itself, escape hatch included. "…with the answer in the top 5" is a false refusal the ranking had right.

| corpus | recall@5 (no floor) | heading@5 | answerable refused | …with the answer in the top 5 | absent-feature refused | off-domain refused |
|---|---:|---:|---:|---:|---:|---:|
| halyard | 0.717 | 0.696 | 1/92 (1.1%) | 0 | 1/12 (8.3%) | 94/108 (87.0%) |
| wiki | 0.867 | 0.600 | 1/30 (3.3%) | 1 | 1/12 (8.3%) | 96/108 (88.9%) |
| xquad-tr | 0.993 | 0.962 | 92/1190 (7.7%) | 84 | — | 104/134 (77.6%) |
| xquad-en | 0.999 | 0.985 | 146/1190 (12.3%) | 145 | — | 114/134 (85.1%) |

## Sweep — share refused per class

| corpus | class | 0.78 | 0.79 | 0.80 | 0.81 | 0.82 | 0.83 | 0.84 | 0.85 | 0.86 | 0.87 | 0.88 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| halyard | answerable | 0% | 0% | 0% | 1% | 1% | 3% | 8% | 14% | 28% | 41% | 52% |
| halyard | absent-feature | 0% | 0% | 0% | 8% | 8% | 17% | 25% | 33% | 33% | 33% | 42% |
| halyard | off-domain | 60% | 67% | 77% | 83% | 87% | 87% | 90% | 90% | 90% | 90% | 90% |
| wiki | answerable | 0% | 0% | 0% | 0% | 3% | 13% | 20% | 23% | 33% | 43% | 53% |
| wiki | absent-feature | 0% | 0% | 8% | 8% | 8% | 8% | 17% | 33% | 58% | 58% | 58% |
| wiki | off-domain | 67% | 78% | 83% | 86% | 89% | 93% | 94% | 94% | 94% | 94% | 94% |
| xquad-tr | answerable | 0% | 0% | 3% | 4% | 8% | 13% | 19% | 28% | 38% | 49% | 61% |
| xquad-tr | off-domain | 34% | 41% | 49% | 65% | 78% | 81% | 84% | 85% | 85% | 85% | 85% |
| xquad-en | answerable | 2% | 4% | 5% | 8% | 12% | 19% | 27% | 37% | 48% | 59% | 69% |
| xquad-en | off-domain | 45% | 58% | 72% | 79% | 85% | 87% | 87% | 87% | 87% | 87% | 87% |

## The floor each corpus would have asked for

Highest floor (0.001 grid) that refuses no answerable question, then at most 1% of them — and what each catches.

| corpus | floor, 0 refused | off-domain caught | absent caught | floor, ≤1% refused | off-domain caught | absent caught |
|---|---:|---:|---:|---:|---:|---:|
| halyard | 0.804 | 85/108 (78.7%) | 1/12 (8.3%) | 0.804 | 85/108 (78.7%) | 1/12 (8.3%) |
| wiki | 0.811 | 93/108 (86.1%) | 1/12 (8.3%) | 0.811 | 93/108 (86.1%) | 1/12 (8.3%) |
| xquad-tr | 0.775 | 37/134 (27.6%) | — | 0.793 | 56/134 (41.8%) | — |
| xquad-en | 0.738 | 0/134 (0.0%) | — | 0.773 | 44/134 (32.8%) | — |

## Candidate (a′): a per-project floor set from probe questions the corpus cannot answer

The floor is the highest top-hit score of `negative.jsonl`'s off-domain rows on that corpus (the calibration probes); it is scored on the corpus's answerable questions and on the off-domain rows **not** used to set it.

| corpus | probe-derived floor | answerable refused | held-out off-domain refused | absent-feature refused |
|---|---:|---:|---:|---:|
| halyard | 0.839 | 6/92 (6.5%) | 86/96 (89.6%) | 2/12 (16.7%) |
| wiki | 0.835 | 5/30 (16.7%) | 90/96 (93.8%) | 1/12 (8.3%) |
| xquad-tr | 0.816 | 80/1190 (6.7%) | 85/122 (69.7%) | — |
| xquad-en | 0.810 | 89/1190 (7.5%) | 94/122 (77.0%) | — |

## Separation: the absolute score against three relative ones (AUC, answerable vs …)

1.0 means some threshold on that feature splits the two classes perfectly on that corpus; 0.5 is a coin. `pooled` puts every corpus into one pool, which is what a **single global** threshold on that feature has to split.

| corpus | vs | abs | gap | spread | zscore |
|---|---|---:|---:|---:|---:|
| halyard | off-domain | 0.997 | 0.776 | 0.687 | 0.830 |
| halyard | absent-feature | 0.851 | 0.776 | 0.563 | 0.798 |
| wiki | off-domain | 0.993 | 0.553 | 0.772 | 0.502 |
| wiki | absent-feature | 0.778 | 0.764 | 0.608 | 0.828 |
| xquad-tr | off-domain | 0.967 | 0.892 | 0.880 | 0.940 |
| xquad-en | off-domain | 0.968 | 0.888 | 0.977 | 0.806 |
| pooled | off-domain | 0.974 | 0.881 | 0.932 | 0.864 |

## One global threshold per feature, fitted to refuse no answerable question in the pool

| feature | threshold | halyard off-domain caught | wiki off-domain caught | xquad-tr off-domain caught | xquad-en off-domain caught |
|---|---:|---:|---:|---:|---:|
| abs | 0.7383 | 16/108 (14.8%) | 27/108 (25.0%) | 0/134 (0.0%) | 0/134 (0.0%) |
| gap | -0.0810 | 0/108 (0.0%) | 0/108 (0.0%) | 0/134 (0.0%) | 0/134 (0.0%) |
| spread | 0.0119 | 1/108 (0.9%) | 5/108 (4.6%) | 3/134 (2.2%) | 13/134 (9.7%) |
| zscore | -0.1122 | 12/108 (11.1%) | 10/108 (9.3%) | 3/134 (2.2%) | 5/134 (3.7%) |

## What a hit-level drop ratio would cost

Keep only hits scoring at least `ratio × top`. It can never refuse a query — the top hit always passes — so this is only its price: answerable questions whose right file was in the top 5 and would be trimmed out of it, and hits kept on average.

| corpus | 0.95 lost / kept | 0.97 lost / kept | 0.98 lost / kept | 0.99 lost / kept |
|---|---:|---:|---:|---:|
| halyard | 0 / 6.4 | 1 / 4.7 | 2 / 3.5 | 4 / 2.4 |
| wiki | 0 / 7.5 | 1 / 5.7 | 1 / 4.3 | 3 / 3.0 |
| xquad-tr | 0 / 2.8 | 6 / 1.9 | 8 / 1.6 | 13 / 1.4 |
| xquad-en | 1 / 2.1 | 3 / 1.6 | 5 / 1.4 | 7 / 1.3 |

## What it says

**The band moves with the corpus's shape, and 0.82 does not travel.** On the two documentation corpora
0.82 sits where ADR-0042 put it: under every answerable question but one, over most off-domain ones,
and the floor either corpus would have asked for itself is 0.804 and 0.811. On encyclopaedic prose the
answerable band sits lower — p10 0.822 (tr) and 0.812 (en) against 0.845 and 0.825 — and 0.82 refuses
7.7 % of the Turkish questions and 12.3 % of the English ones, **84 and 145 of them with the answer in
the top five**. Of the questions whose top hit is under 0.82, the right article is at rank 1 for 67 of
102 (tr) and 139 of 167 (en). The floor those corpora would have asked for is 0.775 / 0.738 (refusing
nothing) or 0.793 / 0.773 (refusing at most 1 %). The first half of Item 17 is therefore **not**
closed: a single instance-wide number is right for documentation and wrong for prose.

**What would have closed it**, recorded so the next measurement is judged by the same bar — the one
bar this question is reopened or closed by: on every measured corpus, the server floor refusing at most
2 % of the answerable questions (counting only those whose answer was in the top five), and the ≤1 %
fitted floor within 0.02 of the server floor. Only halyard is inside it (0 %, 0.804). wiki is outside
on the first half (1 of 30, 3.3 %; its floor 0.811 is inside the second), and xquad-tr (84 of 1190,
7.1 %, 0.793) and xquad-en (145 of 1190, 12.2 %, 0.773) are well outside on both.

**A relative criterion is worse than the absolute score, not better — where it has to work.** Pooled
across all four corpora, which is what one global threshold has to split, the absolute top score
separates answerable from off-domain best (AUC 0.974 against 0.932 for the spread of the top ten, 0.881
for the gap to the second hit, 0.864 for the z-score). Corpus by corpus it is not always ahead: on
xquad-en the spread separates off-domain slightly better (0.977 against 0.968), and on the wiki the
z-score separates absent-feature questions better (0.828 against 0.778, on 12 of them). Neither helps
a single threshold: fitted globally to refuse no answerable question, no relative feature catches more
than 11.1 % of any corpus's off-domain questions (the z-score on halyard, 12 of 108), where the absolute
score catches 14.8 % and 25.0 % on the documentation corpora. A hit-level drop ratio cannot refuse anything — the top hit always
passes it — and trims answers out of the top five as it tightens (xquad-tr loses 6 at 0.97, 13 at
0.99). Candidate (b) is not worth building.

**A floor per project is the one that fits, set by the operator and not derived.** Deriving it from
probe questions — the highest top score of `negative.jsonl`'s off-domain rows on that corpus
(candidate a′) — lands at 0.839 and 0.835 on the documentation corpora and refuses 6.5 % and 16.7 % of
their answerable questions: one hand-written probe that happens to score well decides the floor. On
prose it lands at 0.816 / 0.810 and still refuses 6.7 % / 7.5 %. What the numbers support is a
nullable per-project override of the global floor, with today's `SEARCH_SCORE_FLOOR` as the default,
and the operator shown what it costs before changing it. It remains a query-level gate on the best
hit, so it leaves ADR-0042's selection alone.

## Reproducing it

```bash
npx tsx scripts/floor-calibration.ts --wiki=../wiki --json=floor.json    # Docker
npx tsx scripts/floor-calibration.ts --corpora=halyard,xquad-tr          # a subset
```

Like `npm run eval`, it starts its own `pgvector` container unless `EVAL_DATABASE_URL` (or
`DATABASE_URL`) points at a server it may create databases on. `--wiki` is a checkout of the
Contextator wiki; without it the wiki corpus is skipped.

---

# The external set: XQuAD (2026-09-25)

Retrieval on `eval/external/xquad/` — see its README for the source, the licence (CC BY-SA 4.0) and
how the JSON becomes a corpus. **These numbers are not golden-set numbers and are never pooled with
them**: 2380 questions beside 92 would be a pool that is almost all XQuAD, and the floors of
[ADR-0044](../../.ssot/ADR.md#adr-0044) were argued from the golden set alone. Measured with
`scripts/eval-external.ts`; each language is its own project in its own database.

| set | articles | paragraphs | chunks | n | recall@1 | recall@5 | MRR@10 | heading@1 | heading@5 | refused at 0.82 | …with the answer in the top 5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| xquad-tr | 48 | 240 | 779 | 1190 | 96.3% | 99.3% | 0.975 | 90.5% | 96.2% | 92 (7.7%) | 84 |
| xquad-en | 48 | 240 | 764 | 1190 | 97.3% | 99.9% | 0.984 | 93.1% | 98.5% | 146 (12.3%) | 145 |

Measured at local:Xenova/multilingual-e5-small:fp32:"query: "+"passage: " · CHUNK_MAX_TOKENS=96 · CHUNK_OVERLAP_TOKENS=24 · max_per_document=2, neighbor_context=1 · score_floor=0.82 · rerank off · tr → turkish, en → simple.

Retrieval on prose with questions written against a single paragraph is close to saturated — recall@5
99.3 % and 99.9 % — so this set's use is as a tripwire, not a scoreboard: a change that costs a point
here has broken something the golden set cannot see. What it does show that the golden set does not is
the relevance floor's price on a corpus of a different shape, in the last two columns.

```bash
npx tsx scripts/eval-external.ts                                        # report only
npx tsx scripts/eval-external.ts --min-recall5=0.98 --min-heading5=0.95  # exits 2 when short
npx tsx scripts/eval-external.ts --min-recall5=0.98 --min-heading5=0.95 \
  --min-recall5-en=0.985 --min-heading5-en=0.97                          # a bar per language
```

The run above used those two floors and passed. CI's eval job runs it with per-language bars
(TR 0.98 / 0.95, EN 0.985 / 0.97; ADR-0083). The Turkish bars were read off the Turkish numbers;
English sits higher (99.9 % / 98.5 %), so one bar for both would leave English 1.9 and 3.5 points of
room — the per-language flags hold each language to its own height.
