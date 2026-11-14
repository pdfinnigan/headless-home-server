#!/bin/bash
# One-time, on the server, as the admin user. Gives the server its own clone of YOUR copy of
# this repo, read through a read-only deploy key, so deploys can pull without your GitHub login.
# It doesn't need the rest of the repo yet, so you can pipe it over SSH from your laptop:
#
#   ssh homeserver 'bash -s' < scripts/setup-server.sh you/my-home-server [~/git/my-home-server] [main]
#
# The first run prints a public key. Add it on GitHub as a read-only deploy key (the script
# prints the link), then run the same command again.

set -euo pipefail
say() { printf '[setup-server] %s\n' "$*"; }
die() { printf '[setup-server] ERROR: %s\n' "$*" >&2; exit 1; }

SLUG="${1:-}"; DEST="${2:-}"; BRANCH="${3:-main}"
[[ "$SLUG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "usage: setup-server.sh <owner/repo> [path] [branch]"
DEST="${DEST:-$HOME/git/${SLUG#*/}}"; DEST="${DEST/#\~/$HOME}"
[ "$(id -u)" != 0 ] || die "run as your admin user, not root."

# GitHub's published ed25519 host key fingerprint, so the first connection can't be intercepted.
GITHUB_ED25519_FP="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
KEY="$HOME/.ssh/home-server-deploy"
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
[ -f "$KEY" ] || { ssh-keygen -q -t ed25519 -N "" -C "home-server-deploy@$(hostname -s)" -f "$KEY"; say "created deploy key $KEY"; }

if ! ssh-keygen -F github.com -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1; then
  scanned="$(ssh-keyscan -t ed25519 github.com 2>/dev/null)"
  fp="$(printf '%s\n' "$scanned" | ssh-keygen -lf - | awk '{print $2}')"
  [ "$fp" = "$GITHUB_ED25519_FP" ] || die "github.com host key $fp doesn't match the published one. Stopping."
  printf '%s\n' "$scanned" >> "$HOME/.ssh/known_hosts"
  say "pinned github.com's host key"
fi

export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes"
REMOTE="git@github.com:$SLUG.git"
if ! git ls-remote -q "$REMOTE" HEAD >/dev/null 2>&1; then
  cat <<MSG

The server can't read $SLUG yet. Add this key, then run the same command again:

  1. Open https://github.com/$SLUG/settings/keys/new
  2. Title: home server ($(hostname -s))
  3. Key: $(cat "$KEY.pub")
  4. Leave "Allow write access" unticked. The server only pulls.

MSG
  exit 1
fi

if [ -d "$DEST/.git" ]; then
  say "$DEST is already a clone"
else
  [ -e "$DEST" ] && die "$DEST exists but isn't a git clone. Move it aside first."
  mkdir -p "$(dirname "$DEST")"
  git clone -q -b "$BRANCH" "$REMOTE" "$DEST"
  say "cloned $SLUG into $DEST"
fi
git -C "$DEST" config core.sshCommand "ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes"
say "done. Next: sudo $DEST/scripts/harden.sh (docs/HUMAN_CHECKLIST.md)"
