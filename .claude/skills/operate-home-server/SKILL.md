---
name: operate-home-server
description: Deploy to, check on, or debug the home server. Use when the person asks to deploy or ship, asks whether the server or a service is up, or reports something broken.
---

# Operate the home server

`<alias>` is `server.sshAlias` from the config (default `homeserver`).

- **Deploy:** `scripts/deploy.sh` (from the laptop it runs on the server over SSH). Only when the
  person asks, or as the last step of a change they asked for. Report what it deployed.
- **Status:** `scripts/deploy.sh status`. **Health:** `ssh <alias> '<repoPath>/scripts/doctor.sh'`.
- **Logs:** `ssh <alias> 'sudo -n true 2>/dev/null; tail -n 50 ~/.home-server/deploy/last-run.log'`
  for deploys. Service logs are in the service user's home and need sudo to read; ask the person to
  paste `sudo tail -n 50 ~svc_<name>/Library/Logs/<name>.log` if you need them (dashes in the
  name become underscores; `~svc` for `"user": "shared"` services).
- **MCP namespaces:** `curl -s https://<gateway.hostname>/stats` shows each namespace's state and
  uptime from the gateway's 5-minute probe, without signing in. A namespace that's down there but
  answers in doctor.sh points at the tunnel route or Access.
- **Can't reach it:** check it's on the same network (or Tailscale), then whether it rebooted with
  FileVault on (it waits at the password screen; the person has to go to it once).
- **Helper changed:** deploy.sh warns. Ask the person to run
  `ssh -t <alias> 'cd <repoPath> && sudo scripts/install-helper.sh'`.

Never work around deploy.sh with one-off copies or `launchctl` commands; fix the script instead.
