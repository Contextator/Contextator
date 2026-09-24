# XQuAD — the external set

A second container for retrieval measurements, kept **apart from** `eval/golden.jsonl`. Nothing in
this directory is read by `npm run eval`, and no number measured on it is folded into a golden-set
number or a golden-set floor.

## What it is

| | |
|---|---|
| Dataset | XQuAD (Cross-lingual Question Answering Dataset) — Artetxe, Ruder and Yogatama, *On the Cross-lingual Transferability of Monolingual Representations*, ACL 2020 |
| Source | <https://github.com/google-deepmind/xquad> |
| Upstream commit | `7d30520c717524000f0d9d2f9c10a069acd9d285` |
| Files | `xquad.tr.json`, `xquad.en.json` — downloaded as data, **unmodified** |
| Licence | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), as stated in the upstream README (the repository carries no separate LICENSE file) |
| Size | 48 articles, 240 paragraphs, 1190 questions per language; the paragraphs and questions are parallel across languages |

| file | sha256 |
|---|---|
| `xquad.tr.json` | `92179a564774b7696100d144c1e10870d0a966b6fccbdd254a65b9d2ab1971cc` |
| `xquad.en.json` | `e4c57d1c9143aaa1c5d265ba5987a65f4e69528d2a98f29d6e75019b10344f29` |

`scripts/eval-corpora.ts` checks both hashes on every load and refuses a file that does not match:
the licence's share-alike condition is easiest to keep by not editing the files at all, and a number
measured on an edited file is not comparable with the next one.

The paragraphs are from English Wikipedia (SQuAD v1.1's development set) and their professional
translations; the attribution the licence asks for is the citation above and this directory's link
to the upstream repository.

## Why XQuAD and not something else

ADR-0034 looked for a public Turkish retrieval set and found that MIRACL has no Turkish split. XQuAD
has Turkish, has English beside it on the same paragraphs, and ships as plain JSON — which is the only
form this repository takes an external set in: **data is downloaded, no external code is run**, and
no dependency is added to read it.

It is a different shape from the golden corpus on purpose. The golden set is one synthetic product's
documentation — many short sections, identifiers, error codes. XQuAD is encyclopaedic prose with
questions written by other people. A change that helps the first and hurts the second shows up only
when both are measured.

## How it becomes a corpus

`xquadToCorpus` in `scripts/eval-corpora.ts`, deterministically:

- one Markdown document per article, `<lang>/<Title_slug>.md`, starting `# <Title>`;
- one `##` section per paragraph, headed with the paragraph's number (`## 1`, `## 2`, …) and nothing
  else, so the breadcrumb the chunker puts in front of every chunk carries no words the question could
  match;
- one golden-shaped question per QA: `id` `xq-<lang>-<qa id>`, `expectFile` the article,
  `expectHeading` the paragraph number, so `heading@5` means "the paragraph the answer came from".

The Turkish file's byte-order mark is stripped from the first context string; nothing else is changed.
Each language is indexed as its own project in its own database, Turkish with the `turkish` text
search configuration and English with `simple`, as an operator would set them.

## Running it

```bash
npx tsx scripts/eval-external.ts                                   # both languages, report only
npx tsx scripts/eval-external.ts --lang=tr --markdown=out.md        # one language, Markdown too
npx tsx scripts/eval-external.ts --min-recall5=0.98 --min-heading5=0.95   # exits 2 when short
```

Like `npm run eval`, it starts its own `pgvector` container unless `EVAL_DATABASE_URL` (or
`DATABASE_URL`) points at a server it may create databases on. `scripts/floor-calibration.ts` reads the
same two files as two of its four corpora. The numbers are in `eval/BASELINE.md`, under their own
heading.
