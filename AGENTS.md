# Agent guide

This repo turns a Mac into a headless home server. You do the work; the person only does the steps
in docs/HUMAN_CHECKLIST.md.

- First setup: follow `.claude/skills/setup-home-server/SKILL.md`.
- Adding or changing a service: `.claude/skills/add-service/SKILL.md`.
- Deploying, checking, debugging: `.claude/skills/operate-home-server/SKILL.md`.

Rules:
- Config (`config/home-server.json`) holds identifiers only. Never put a secret in it, in the repo,
  or in chat. Secrets go in the service user's files, typed by the person (docs/security.md).
- Services listen on `$HOST:$PORT` (always 127.0.0.1). Never bind to 0.0.0.0. MCP services serve
  at `$MCP_PATH`.
- An MCP namespace's `mcp.clients` and `mcp.tools` are its access control: add only what the person
  asked for, and never widen them to make something work.
- `gateway/` changes: run `npm test` there before you push.
- `scripts/deploy.sh` is the only deploy path. If it can't do something, change the script.
- Changing `scripts/home-server-helper` means updating `scripts/home-server-helper.sha256` in the
  same commit and asking the person to run `sudo scripts/install-helper.sh` once.
- Give the person one paste-able command when a step needs their password, and say which machine
  it runs on.
