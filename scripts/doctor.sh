#!/bin/bash
# Read-only health and security check. Run it on the server any time; it changes nothing.
#
#   scripts/doctor.sh          (some checks need sudo to see everything; it says which)
#
# Exit status is the number of FAIL lines, so an agent or a cron job can act on it.

set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
. "$(dirname "$0")/lib/common.sh"
need_config
on_macos || die "macOS only for now."

fails=0
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }
note() { printf '  note  %s\n' "$*"; }

SVC="$(cfg server.serviceUser svc)"
ADMIN="$(cfg server.adminUser)"

echo "Headless"
s="$(pmset -g | awk '$1 == "sleep" {print $2}')"
[ "$s" = 0 ] && ok "system sleep is off" || bad "system sleeps after $s min (sudo scripts/harden.sh)"
[ "$(pmset -g | awk '$1 == "womp" {print $2}')" = 1 ] && ok "wakes for network access" || note "wake for network access is off"
if fdesetup isactive >/dev/null 2>&1; then
  note "FileVault is on: after a reboot nothing starts until someone types the password at the machine (docs/headless.md)"
else
  ok "FileVault is off: comes back by itself after a reboot (docs/headless.md has the tradeoff)"
fi

echo "Security"
FW=/usr/libexec/ApplicationFirewall/socketfilterfw
"$FW" --getglobalstate 2>/dev/null | grep -q enabled && ok "firewall on" || bad "firewall off"
"$FW" --getstealthmode 2>/dev/null | grep -qi 'on\|enabled' && ok "stealth mode on" || bad "stealth mode off"
if [ -f /etc/ssh/sshd_config.d/100-keys-only.conf ]; then ok "SSH accepts keys only"; else bad "SSH still accepts passwords (add your key, then sudo scripts/harden.sh)"; fi
[ "$(stat -f %u /usr/local/sbin 2>/dev/null)" = 0 ] && ok "/usr/local/sbin is owned by root" || bad "/usr/local/sbin isn't owned by root, so the helper could be swapped (sudo scripts/harden.sh)"
if [ -x "$HS_HELPER" ]; then
  cmp -s "$HS_HELPER" "$HS_ROOT/scripts/home-server-helper" && ok "deploy helper matches the repo" || bad "deploy helper differs from the repo (sudo scripts/install-helper.sh)"
else
  bad "deploy helper isn't installed (sudo scripts/install-helper.sh)"
fi
if id "$SVC" >/dev/null 2>&1; then
  dseditgroup -o checkmember -m "$SVC" admin >/dev/null 2>&1 && bad "service user $SVC is an admin" || ok "service user $SVC is a standard account"
else
  bad "service user $SVC doesn't exist (sudo scripts/harden.sh)"
fi
[ "$(defaults read /Library/Preferences/com.apple.SoftwareUpdate CriticalUpdateInstall 2>/dev/null)" = 1 ] \
  && ok "security responses install automatically" || note "security responses don't install automatically"
pending="$(softwareupdate -l 2>/dev/null | grep -c '^\* Label' || true)"
[ "${pending:-0}" = 0 ] && ok "no pending software updates" || note "$pending software update(s) pending (softwareupdate -l)"

echo "Listening ports (anything not on 127.0.0.1 or ::1 is reachable from your network)"
if [ "$(id -u)" != 0 ]; then note "run with sudo to see other users' ports too"; fi
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 {print $1, $3, $9}' | sort -u | while read -r cmd user addr; do
  case "$addr" in
    127.0.0.1:*|\[::1\]:*|localhost:*) ;;
    *:22) printf '  ok    %s (%s) on %s: SSH\n' "$cmd" "$user" "$addr" ;;
    *) printf '  note  %s (%s) listens on %s: bind it to 127.0.0.1 unless you mean it\n' "$cmd" "$user" "$addr" ;;
  esac
done

echo "Services"
for s in $(service_names); do
  i="$(service_index "$s")"; port="$(cfg "services.$i.port")"; auth="$(cfg "services.$i.expose.auth")"
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null || true)"
  [ -n "$code" ] && [ "$code" != 000 ] && ok "$s answers on 127.0.0.1:$port ($auth)" || bad "$s isn't answering on 127.0.0.1:$port (log: ~$SVC/Library/Logs/$s.log)"
  if [ "$auth" = public ] || [ "$auth" = access ]; then
    host="$(cfg "services.$i.expose.hostname")"
    pc="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "https://$host/" 2>/dev/null || true)"
    case "$auth:$pc" in
      public:2*|public:3*|public:4[0-9][0-9]) ok "$s is reachable at https://$host (HTTP $pc)" ;;
      access:302|access:401|access:403) ok "$s at https://$host asks for an Access login (HTTP $pc)" ;;
      access:2*) bad "$s at https://$host answered without an Access login (HTTP $pc)" ;;
      *) bad "$s isn't reachable at https://$host (HTTP ${pc:-none}); is the tunnel running?" ;;
    esac
  fi
done
[ -n "$ADMIN" ] && [ -f "$(user_home "$ADMIN")/.home-server/deploy/last-run.log" ] && note "last deploy log: ~$ADMIN/.home-server/deploy/last-run.log"

echo
[ "$fails" = 0 ] && say "all checks passed" || say "$fails check(s) failed"
exit "$fails"
