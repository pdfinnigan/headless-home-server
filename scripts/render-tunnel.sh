#!/bin/bash
# Print the cloudflared config for every service exposed with auth "public" or "access".
# Prints nothing when no service needs the tunnel. deploy.sh installs the result through the
# helper; run it yourself to see what would be installed.
#
# Access is enforced on each ingress rule (originRequest.access), so a request that didn't pass
# the Access policy never reaches the service, even if someone finds the hostname.

set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
need_config

SVC="$(cfg server.serviceUser svc)"
SVC_HOME="$(user_home "$SVC" 2>/dev/null || true)"; SVC_HOME="${SVC_HOME:-/Users/$SVC}"
TUNNEL="$(cfg exposure.tunnelId)"
TEAM="$(cfg exposure.accessTeam)"

rules=""
for s in $(service_names); do
  i="$(service_index "$s")"
  auth="$(cfg "services.$i.expose.auth")"
  [ "$auth" = public ] || [ "$auth" = access ] || continue
  host="$(cfg "services.$i.expose.hostname")"; port="$(cfg "services.$i.port")"
  [[ "$host" =~ ^[a-z0-9.-]+$ ]] || die "$s: expose.hostname '$host' doesn't look like a hostname"
  rules+="  - hostname: $host
    service: http://127.0.0.1:$port
"
  if [ "$auth" = access ]; then
    aud="$(cfg "services.$i.expose.accessAud")"
    [[ "$aud" =~ ^[0-9a-f]{64}$ ]] || die "$s: auth access needs expose.accessAud (the Access app's 64-hex Audience tag)"
    [[ "$TEAM" =~ ^[a-z0-9-]+$ ]] || die "$s: auth access needs exposure.accessTeam"
    rules+="    originRequest:
      access:
        required: true
        teamName: $TEAM
        audTag:
          - $aud
"
  fi
done

[ -n "$rules" ] || exit 0
[[ "$TUNNEL" =~ ^[0-9a-f-]{36}$ ]] || die "a service needs the tunnel, but exposure.tunnelId isn't set (scripts/setup-tunnel.sh)"
cat <<EOF
# Written by headless-home-server scripts/render-tunnel.sh. Edit the config, not this file.
tunnel: $TUNNEL
credentials-file: $SVC_HOME/.cloudflared/$TUNNEL.json
ingress:
${rules}  - service: http_status:404
EOF
