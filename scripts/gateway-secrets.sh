#!/bin/bash
# Put the gateway's secrets into the Worker. Run it yourself in Terminal, on the server (or any
# machine where wrangler is signed in): it asks for each value without echoing it, so secrets
# never pass through a chat, the repo or your shell history.
#
#   scripts/gateway-secrets.sh             all four: GitHub OAuth app, then the Access service token
#   scripts/gateway-secrets.sh github      just GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
#   scripts/gateway-secrets.sh access      just CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET
#
# docs/gateway.md says where each value comes from.

set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
need_config
WORKER="$(cfg gateway.workerName home-server-gateway)"
VERSION="$(node -p 'require(process.argv[1]).devDependencies.wrangler' "$HS_ROOT/gateway/package.json")"
cf_env="$HOME/.home-server/secrets/cloudflare.env"
if [ -f "$cf_env" ]; then set -a; . "$cf_env"; set +a; fi

case "${1:-all}" in
  all) names="GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET" ;;
  github) names="GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET" ;;
  access) names="CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET" ;;
  *) die "usage: $0 [github|access]" ;;
esac

for n in $names; do
  printf '%s for %s (input hidden): ' "$n" "$WORKER"
  IFS= read -rs value; echo
  [ -n "$value" ] || die "$n was empty; nothing changed for it"
  printf '%s' "$value" | npx --yes "wrangler@$VERSION" secret put "$n" --name "$WORKER" >/dev/null \
    || die "wrangler couldn't set $n. If the Worker doesn't exist yet, deploy once first (scripts/deploy.sh)."
  unset value
  say "$n set"
done
