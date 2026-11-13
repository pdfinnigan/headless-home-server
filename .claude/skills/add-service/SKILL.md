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
3. **Run it locally** first: `PORT=<port> <run>` in the folder, and hit it with curl.
4. **Ship:** commit, push to the branch (or open a PR if that's how they work), then
   `scripts/deploy.sh`. For a new public hostname, run `scripts/setup-tunnel.sh` on the server
   once to add its DNS record. For `access`, the person creates the Access app (checklist 7).
5. **Verify:** `scripts/deploy.sh status`, and for public ones `curl -I https://<hostname>`.
   Report the address.

To remove a service, delete its config entry (and folder) and deploy: deploy.sh stops it and
deletes its files on the server.
