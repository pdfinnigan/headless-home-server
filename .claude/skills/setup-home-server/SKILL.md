---
name: setup-home-server
description: Set up a Mac as a headless home server from this repo, end to end. Use when the person asks to set up, install or harden their home server, or to start over on a new machine.
---

# Set up the home server

You do every step you can. Ask the person only for the items in docs/HUMAN_CHECKLIST.md, one at a
time, each as a single action or a single paste, and say which machine it runs on.

## 0. Preflight (on the laptop, in their private copy of this repo)

- Confirm the repo is private. If it isn't, stop and ask them to make it private: the config will
  hold their domain and LAN address.
- If `config/home-server.json` doesn't exist, copy the example and fill in what you can. Ask for:
  their server's admin username, its LAN IP (checklist 1), and which services they want public.
  Leave `exposure` out if nothing is public. Remove example services they don't want.
- Make sure their laptop key is on the server (checklist 2), then `scripts/install-ssh-alias.sh`.
  It connects once to trust the server's host key. Below, `<alias>` is `server.sshAlias`.
- If the config lives outside the repo (`~/.home-server/config.json`), copy it to the same path on
  the server too: `ssh <alias> 'mkdir -p ~/.home-server' && scp <config> <alias>:.home-server/config.json`.
  Copy it again whenever it changes.

## 1. The server's clone

`ssh <alias> 'bash -s' < scripts/setup-server.sh <owner/repo> <server.repoPath> <branch>` (no `-t`: stdin is the script).
The first run prints a deploy key and a link (checklist 4). Run it again after they add it.
Commit and push the config first, so the server's clone has it.

## 2. Hardening and the helper (one sudo paste)

Ask them to run, from their laptop:

```
ssh -t <alias> 'cd <repoPath> && sudo scripts/harden.sh && sudo scripts/install-helper.sh'
```

Read the output with them. If harden.sh warns that SSH still accepts passwords, their key isn't in
`~/.ssh/authorized_keys` on the server yet: fix that and run harden.sh again.

## 3. Prerequisites on the server

Over SSH, check `node -v` (20+) and, if anything is public, `cloudflared --version`. Non-interactive
SSH doesn't put Homebrew on PATH, so run them as
`ssh <alias> 'PATH=/usr/local/bin:/opt/homebrew/bin:$PATH; node -v; cloudflared --version'`
(the repo's scripts add those folders themselves). If Homebrew is
missing or a tool isn't installed, give them the one install command to paste on the server
(Homebrew's installer needs their password).

## 4. Exposure

- Anything `public` or `access`: `ssh -t <alias> 'cd <repoPath> && scripts/setup-tunnel.sh'`.
  It prints a Cloudflare sign-in URL they can open on any device (checklist 6) and the tunnel id.
  Send them the URL the moment it appears: it expires after about 8 minutes. If it does, ask when
  they're at a browser and run the script again. It also creates a DNS record per hostname.
  Put the id in `exposure.tunnelId`, commit, push.
- Anything `access`: checklist 7, then put the AUD tag in that service's `expose.accessAud`.
- Anything `tailscale`: ask them to install Tailscale on the server and sign in.
- Anything `gateway` (MCP for hosted apps): follow docs/gateway.md, "Set it up". Do steps 2 and 5
  yourself; ask for 1, 3, 4 and 6 one at a time (checklist 9).

## 5. First deploy and check

`scripts/deploy.sh` from the laptop, then `ssh <alias> 'sudo <repoPath>/scripts/doctor.sh'`.
Public services stay off the tunnel (with a warning) until `exposure.tunnelId` is set. Fix
every FAIL. Report what's running, at which address, and anything left for them to decide (for
example FileVault, docs/headless.md).
