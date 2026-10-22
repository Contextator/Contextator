# File types

A source indexes `.md`/`.mdx` by default and can be told to take `.txt`, `.html`/`.htm`, `.csv`, `.docx`,
`.pdf`, `.pptx`, `.xlsx`, `.ipynb`, `.rst` and `.adoc` as well; `.yaml`/`.yml`/`.json` are readable only through the
[OpenAPI / Swagger](document-sources.md#openapi-and-swagger) content type. **Everything becomes Markdown on the way in**,
once, at the edge, so the chunker, the embedder and `read_document` see one format. A file that cannot be
converted — a scanned or encrypted PDF, a Word file that is all images — is refused by name rather than
indexed blank, and the refusal never fails the source or the project.

Full per-type conversion table (what each format keeps and loses), the size and page caps that bound a
single file while it converts, and the PDF-length benchmark against `MAX_STORED_DOCUMENT_BYTES`:
[Document Sources](https://contextator.com/en/docs/document-sources/#what-gets-indexed).

## Presentations, workbooks, notebooks and markup

| Type | One section per | What is kept | What is left out |
|------|-----------------|--------------|------------------|
| `.pptx` | slide, in presentation order (`## Slide 3: Title`) | text, bullets, tables, and the speaker notes on a `Notes:` line under their slide | pictures, charts, SmartArt, slide numbers and footers |
| `.xlsx` | visible sheet (`## Sheet name`) | cell values as a table, shared strings, the cached result of each formula | hidden sheets, formulas themselves (never evaluated), charts, cell formatting (a date reads as its serial number) |
| `.ipynb` | notebook (`#` from the markdown cells) | markdown and code cells, code fenced with the notebook language | cell outputs, raw cells, metadata |
| `.rst` | the document's own headings, by order of appearance | headings, paragraphs, lists, literal blocks, tables, admonitions, links | comments, toolchain directives such as `contents` |
| `.adoc` | the document's own headings (`=`, `==`, ...) | headings, paragraphs, lists, listing blocks, tables, admonitions, links, attribute references | comments, attribute entries, conditionals |

`.pptx` and `.xlsx` are zip archives, read by a small in-process reader that refuses an archive whose
parts declare more than `MAX_DOCX_UNPACKED_BYTES` (the same limit as `.docx`, now covering every
Office Open XML type) before inflating anything, and that bounds what a part really unpacks to when
its declared size is a lie. A file that is not a zip, is encrypted, or is a zip of a different kind is
refused by name like any other unreadable file. The older binary `.ppt`, `.xls` and `.doc` are not read.
