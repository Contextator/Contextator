# Where your data goes

Four things leave the machine, or stay on it, in ways worth knowing before a security review. Everything
else in this documentation happens inside your own deployment.

1. **The default embedding model is downloaded once, on first start.** `Xenova/multilingual-e5-small` is
   fetched into the `contextator-models` volume from the Hugging Face Hub, the transformers.js default.
   After that, embedding runs on the CPU of your own host and document text is not sent anywhere for it. On a
   host with no route out, fill the volume beforehand and set `EMBEDDING_OFFLINE=1`; see
   [Embedding Models](https://contextator.com/en/docs/embedding-models/).
2. **Remote sources make outbound requests; local ones do not.** A git, Notion, Confluence or Documentation
   site source contacts its host, from this server, when it syncs: on demand, on a source's schedule, and
   when a push webhook arrives. A local directory and an upload source contact nobody. And if you set
   `EMBEDDING_PROVIDER=openai`, document text and search queries go to the endpoint named by
   `EMBEDDING_BASE_URL`, which is OpenAI unless you point it at a server of your own.
3. **The `-slim` image and the Helm chart bring no database.** They use an external PostgreSQL that you
   provision (`DATABASE_URL` is required), so where that server runs, who runs it and what backs it up decide
   where projects, documents, embeddings, accounts and logs live. See
   [Bringing your own PostgreSQL](deployment.md#bringing-your-own-postgresql).
4. **The PII scan keeps where a secret is, not the secret.** By default (`PII_SCAN`, see
   [Configuration](configuration.md#scanning-documents-for-secrets-and-personal-numbers)) the server looks through
   the text it has stored for AWS keys, GitHub tokens, private key headers, JWTs, citizen numbers and IBANs, and
   writes `document_findings` and `document_scans`. A finding holds the document, the line and column, a masked
   preview (a fixed prefix and at most four characters of the value) and, when `SECRET_KEY` is set, an HMAC of the
   value under a key derived from it. **The value and any plain hash of it are not stored.** Nothing leaves the
   machine for it. The findings are in a backup, which is a full database dump, and are left out of a project
   export; they are shown only to an `editor` of the project and above. The preview of a citizen number and the
   HMAC are personal data in a derived form, and the findings are kept only as long as the document is.
