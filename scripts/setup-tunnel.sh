#!/bin/bash
# One-time, on the server, as the admin user (not sudo). Creates the Cloudflare Tunnel that
# carries every public, Access-protected or gateway service, and hands its credentials to the service user.
# Needs: a domain on Cloudflare, and cloudflared (brew install cloudflared).
#
#   scripts/setup-tunnel.sh [tunnel-name]     default name: home-server
#
# Steps it takes:
#   1. cloudflared tunnel login: prints a URL. Open it on any device (your laptop or phone),
#      pick the domain. The server never needs a screen.
#   2. Creates the tunnel, or reuses one with that name.
#   3. Points a DNS record at the tunnel for each hostname in the config.
#   4. Copies the tunnel's credentials into the service user's ~/.cloudflared (asks for your
#      password once), then prints the tunnel id for exposure.tunnelId in your config.
# Run it again after adding a hostname to the config: steps 1, 2 and 4 are skipped when done.

set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
need_config
on_macos || die "macOS only for now."
[ "$(id -u)" != 0 ] || die "run as your admin user, not with sudo. It asks for the password when it needs it."

NAME="${1:-home-server}"
SVC="$(cfg server.serviceUser svc)"
SVC_HOME="$(user_home "$SVC")"
[ -n "$SVC_HOME" ] || die "service user $SVC doesn't exist. Run sudo scripts/harden.sh first."
CLOUDFLARED="$(command -v cloudflared || true)"
[ -n "$CLOUDFLARED" ] || die "cloudflared isn't installed: brew install cloudflared"

# 1. Sign in (once; leaves ~/.cloudflared/cert.pem)
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  say "signing in to Cloudflare. Open the URL below on any device and pick your domain."
  say "The link expires after about 8 minutes. If it does, run this script again for a new one."
  "$CLOUDFLARED" tunnel login || die "Cloudflare sign-in didn't finish (the link may have expired). Run this script again."
fi

# 2. Tunnel
# The id is the only UUID in the listing; don't depend on cloudflared's JSON spacing.
tunnel_id() { "$CLOUDFLARED" tunnel list -n "$NAME" -o json 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true; }
id="$(tunnel_id)"
if [ -z "$id" ]; then
  "$CLOUDFLARED" tunnel create "$NAME" >/dev/null || die "cloudflared couldn't create tunnel $NAME (see above)"
  id="$(tunnel_id)"
  say "created tunnel $NAME"
fi
[ -n "$id" ] || die "tunnel $NAME exists but its id couldn't be read; run: cloudflared tunnel list -n $NAME"
CREDS="$HOME/.cloudflared/$id.json"
[ -f "$CREDS" ] || die "no credentials at $CREDS. If the tunnel was made on another machine, copy that file here (it's a secret: scp, never chat or email)."

# 3. DNS for every hostname in the config. These CNAME records stay in Cloudflare when a tunnel
#    or service is removed; delete them in the dashboard (DNS > Records) when you retire one.
for s in $(service_names); do
  i="$(service_index "$s")"
  auth="$(cfg "services.$i.expose.auth")"
  [ "$auth" = public ] || [ "$auth" = access ] || continue
  host="$(cfg "services.$i.expose.hostname")"
  "$CLOUDFLARED" tunnel route dns "$NAME" "$host" >/dev/null 2>&1 \
    && say "DNS: $host -> tunnel $NAME" || warn "DNS for $host wasn't changed (it may already point somewhere else)"
done
oh="$(cfg gateway.originHostname)"
if [ -n "$oh" ]; then
  "$CLOUDFLARED" tunnel route dns "$NAME" "$oh" >/dev/null 2>&1 \
    && say "DNS: $oh -> tunnel $NAME (the gateway's way in)" || warn "DNS for $oh wasn't changed (it may already point somewhere else)"
fi

# 4. Credentials to the service user (a secret: readable only by that user)
if ! sudo -n test -f "$SVC_HOME/.cloudflared/$id.json" 2>/dev/null; then
  say "copying the tunnel credentials to $SVC (asks for your password)"
  sudo install -d -o "$SVC" -m 700 "$SVC_HOME/.cloudflared"
  sudo install -o "$SVC" -m 400 "$CREDS" "$SVC_HOME/.cloudflared/$id.json"
fi

[ "$(cfg exposure.tunnelId)" = "$id" ] || cat <<EOF

Put this in your config, then deploy (scripts/deploy.sh):
  "exposure": { "provider": "cloudflare", "domain": "...", "tunnelId": "$id" }
EOF
say "tunnel $NAME is ready"
