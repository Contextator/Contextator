# Security notes

The port is published on `127.0.0.1` only by default; MCP endpoints require a token unless a project is
explicitly set `open`; source tokens are encrypted at rest with `SECRET_KEY` (AES-256-GCM) and rotatable
without re-entering them; local and Confluence sources are confined against path escapes and private-network
egress; passwords are salted `scrypt` and sessions are revocable rows; and the last active root account can
never be deleted, demoted or disabled.

Full write-up of every guarantee above, plus what a reverse proxy has to add and what a static MCP token
does and does not protect: [Security](https://contextator.com/en/docs/security/).
