# File types

A source indexes `.md`/`.mdx` by default and can be told to take `.txt`, `.html`/`.htm`, `.csv`, `.docx`
and `.pdf` as well; `.yaml`/`.yml`/`.json` are readable only through the
[OpenAPI / Swagger](document-sources.md#openapi-and-swagger) content type. **Everything becomes Markdown on the way in**,
once, at the edge, so the chunker, the embedder and `read_document` see one format. A file that cannot be
converted — a scanned or encrypted PDF, a Word file that is all images — is refused by name rather than
indexed blank, and the refusal never fails the source or the project.

Full per-type conversion table (what each format keeps and loses), the size and page caps that bound a
single file while it converts, and the PDF-length benchmark against `MAX_STORED_DOCUMENT_BYTES`:
[Document Sources](https://contextator.com/en/docs/document-sources/#what-gets-indexed).
