---
name: Bug report
about: Something does not work the way it says it does
labels: bug
---

**What happened, and what you expected instead.**

**How to reproduce it.** The smallest sequence of steps you can get it down to.

**Version.** The tag or commit, or the `version` from `GET /api/health`.

**How it is deployed.** One of:

- the published image (`docker compose up -d`, pulling `contextator/contextator` from Docker Hub) —
  say which tag or digest: `docker image inspect --format '{{index .RepoDigests 0}}' contextator/contextator`
- built from source (`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`,
  or a plain `docker build`)
- `npm run dev` against `docker-compose.dev.yml`
- something else — say what

**The relevant log lines.** `docker compose logs contextator`, or the terminal running `npm run dev`.
Paste the lines around the failure rather than the whole file, and check them for tokens before you do.

<!-- Not a bug report: a security problem. Do not file one here — SECURITY.md says where it goes. -->
