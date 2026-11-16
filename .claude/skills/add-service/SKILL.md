---
name: add-service
description: Add, change or remove a service (website, API, MCP server, bot, anything with a port) on the home server. Use when the person asks to host, expose, add or remove something on their home server.
---

# Add a service

1. **Code:** a folder under `services/<name>/` (not `services/examples/`). It must:
   - listen on `process.env.HOST` and `process.env.PORT` (HOST is always 127.0.0.1);
   - answer `GET /` with any HTTP status, so deploy.sh and doctor.sh can tell it's up;
   - keep dependencies in `package.json` with a committed `package-lock.json` (Node), in a
     `requirements.lock` with a `--hash` on every line (Python), or be self-contained. Install
     scripts don't run (`npm ci --ignore-scripts`), and pip installs only prebuilt wheels that match
     their hashes. For Python, the helper makes `.venv/` in the service folder, so `run` is
     `.venv/bin/python ...` (add `env PYTHONPATH=src` for a src layout, since the app itself isn't
     installed). A `.python-version` with e.g. `3.12` picks Homebrew's `python3.12`; otherwise
     `python3`. Make the lock with `uv export --format requirements-txt --no-dev --no-emit-project`
     or `pip-compile --generate-hashes`.
   - read secrets from `$HOME/secrets/<name>.env`, never from the repo.
   Any language works if `run` can start it with what's installed on the server.

   **Code in another repo:** instead of a folder here, give the entry `"source": {"repo":
   "git@github.com:<owner>/<repo>.git", "rev": "<full commit hash>"}` and set `dir` to the folder
   in that repo (`.` for its root). The server's admin account fetches it, so a private repo needs
   a read-only deploy key for that account (docs/operate.md). To ship a new version, change `rev`
   in a commit here and deploy: this repo's history then records every version that ran.

   **Scheduled jobs** (a sync, a backup, a report): add `"jobs": [{"name": "sync", "run": "...",
   "at": ["06:00", "18:00"]}]` to the service. Each job runs as the service's user, in its folder,
   with its secrets and data, at those times in the server's time zone. launchd catches up on a time
   missed while the Mac slept but not one missed while it was off, so a job that must not skip
   should check its own last success, and can set `"runAtLoad": true` to also run at boot and after
   each deploy. A job is one command, like `run`.
2. **Config:** add an entry to `services` in `config/home-server.json`: `name` (lowercase, dashes),
   `dir`, `run` (started inside `dir`), a free `port` (1024+, unique), and `expose.auth`
   (docs/exposure.md). Default to the least exposure that does the job: `local` or `tailscale`
   unless they asked for public.
   For an **MCP server** they want in claude.ai, ChatGPT, Claude Code or Codex: `"expose": { "auth":
   "gateway" }` plus `"mcp": { "tools": [...], "clients": [...] }` (docs/gateway.md). The service
   name is the namespace and its URL path, so pick a short general one (`notes`, not
   `my-notes-mcp`). The server must serve MCP at `$MCP_PATH`. List only the tools they want
   published and only the apps they named; ask if they didn't say which apps. A new namespace when
   the tools have a different trust level or different apps from an existing one; otherwise add the
   tools to the existing server.
3. **Run it locally** first: `PORT=<port> <run>` in the folder, and hit it with curl.
4. **Ship:** commit, push to the branch (or open a PR if that's how they work), then
   `scripts/deploy.sh`. For a new public hostname, run `scripts/setup-tunnel.sh` on the server
   once to add its DNS record. For `access`, the person creates the Access app (checklist 7).
5. **Verify:** `scripts/deploy.sh status`, and for public ones `curl -I https://<hostname>`.
   For MCP namespaces, `scripts/doctor.sh` on the server. Report the address, and for a new
   namespace tell them the one thing left: add `https://<gateway.hostname>/<name>` as a connector
   in each app that should have it.

To remove a service, delete its config entry (and folder) and deploy: deploy.sh stops it and
deletes its files on the server.
