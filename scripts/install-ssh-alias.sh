#!/bin/bash
# On your laptop. Writes an SSH alias for the server (server.sshAlias, default `homeserver`)
# to ~/.ssh/config.d/ and makes ~/.ssh/config include that folder. Nothing secret is written.
#
#   scripts/install-ssh-alias.sh [key]        key defaults to ~/.ssh/id_ed25519
#
# Uses server.lanIp, not the .local name, which can resolve to IPv6 only and fail.
# Give the server a DHCP reservation on your router so the address stays put.

set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
need_config

ALIAS="$(cfg server.sshAlias homeserver)"
IP="$(cfg server.lanIp)"; USER_NAME="$(cfg server.adminUser)"; KEY="${1:-~/.ssh/id_ed25519}"
[[ "$IP" =~ ^[0-9.]+$ ]] || die "server.lanIp isn't an IPv4 address: '$IP'"
[ -n "$USER_NAME" ] || die "server.adminUser is empty"

mkdir -p ~/.ssh/config.d; chmod 700 ~/.ssh ~/.ssh/config.d
cat > ~/.ssh/config.d/"$ALIAS" <<CONF
# Written by headless-home-server scripts/install-ssh-alias.sh
Host $ALIAS
  HostName $IP
  User $USER_NAME
  IdentityFile $KEY
  IdentitiesOnly yes
  HostKeyAlias $ALIAS
  ServerAliveInterval 30
CONF
chmod 600 ~/.ssh/config.d/"$ALIAS"

touch ~/.ssh/config; chmod 600 ~/.ssh/config
if ! grep -qE '^[[:space:]]*Include[[:space:]]+(~/\.ssh/)?config\.d/\*' ~/.ssh/config; then
  { echo 'Include config.d/*'; echo; cat ~/.ssh/config; } > ~/.ssh/config.new
  mv ~/.ssh/config.new ~/.ssh/config; chmod 600 ~/.ssh/config
  say "added 'Include config.d/*' to the top of ~/.ssh/config"
fi
# First connection: record the server's host key under the alias (trust on first use, on your LAN).
if ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "$ALIAS" true 2>/dev/null; then
  say "wrote alias '$ALIAS' and connected; the server's host key is now trusted"
else
  warn "wrote alias '$ALIAS', but couldn't connect yet. Is your key on the server (docs/HUMAN_CHECKLIST.md, step 2)?"
fi
