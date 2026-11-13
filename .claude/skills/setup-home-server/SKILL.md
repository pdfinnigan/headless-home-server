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
- Make sure their laptop key is on the server (checklist 2), then `scripts/install-ssh-alias.sh`
  and test with `ssh -o BatchMode=yes homeserver true`.

## 1. The server's clone

`ssh -t homeserver 'bash -s' < scripts/setup-server.sh <owner/repo> <server.repoPath> <branch>`.
The first run prints a deploy key and a link (checklist 4). Run it again after they add it.
Commit and push the config first, so the server's clone has it.

## 2. Hardening and the helper (one sudo paste)

Ask them to run, from their laptop:

```
ssh -t homeserver 'cd <repoPath> && sudo scripts/harden.sh && sudo scripts/install-helper.sh'
```

Read the output with them. If harden.sh warns that SSH still accepts passwords, their key isn't in
`~/.ssh/authorized_keys` on the server yet: fix that and run harden.sh again.

## 3. Prerequisites on the server

Over SSH, check `node -v` (20+) and, if anything is public, `cloudflared --version`. If Homebrew is
missing or a tool isn't installed, give them the one install command to paste on the server
(Homebrew's installer needs their password).

## 4. Exposure

- Anything `public` or `access`: `ssh -t homeserver 'cd <repoPath> && scripts/setup-tunnel.sh'`.
  It prints a Cloudflare sign-in URL they can open on any device (checklist 6) and the tunnel id.
  Put the id in `exposure.tunnelId`, commit, push.
- Anything `access`: checklist 7, then put the AUD tag in that service's `expose.accessAud`.
- Anything `tailscale`: ask them to install Tailscale on the server and sign in.

## 5. First deploy and check

`scripts/deploy.sh` from the laptop, then `ssh homeserver '<repoPath>/scripts/doctor.sh'`. Fix
every FAIL. Report what's running, at which address, and anything left for them to decide (for
example FileVault, docs/headless.md).
