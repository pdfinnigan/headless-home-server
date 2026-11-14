---
name: add-service
description: Add, change or remove a service (website, API, MCP server, bot, anything with a port) on the home server. Use when the person asks to host, expose, add or remove something on their home server.
---

# Add a service

1. **Code:** a folder under `services/<name>/` (not `services/examples/`). It must:
   - listen on `process.env.HOST` and `process.env.PORT` (HOST is always 127.0.0.1);
   - answer `GET /` with any HTTP status, so deploy.sh and doctor.sh can tell it's up;
   - keep dependencies in `package.json` with a committed `package-lock.json` (Node), or be
     self-contained. Install scripts don't run (`npm ci --ignore-scripts`).
   - read secrets from `$HOME/secrets/<name>.env`, never from the repo.
   Any language works if `run` can start it with what's installed on the server.
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
