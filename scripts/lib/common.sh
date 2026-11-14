# shellcheck disable=SC2034  # the HS_* names are used by the scripts that source this
# Shared helpers. Source it: . "$(dirname "$0")/lib/common.sh"
# shellcheck shell=bash

# Non-interactive SSH sessions on macOS don't include Homebrew's bin folders; add them.
case ":$PATH:" in *:/usr/local/bin:*) ;; *) PATH="/usr/local/bin:$PATH" ;; esac
case ":$PATH:" in *:/opt/homebrew/bin:*) ;; *) [ -d /opt/homebrew/bin ] && PATH="/opt/homebrew/bin:$PATH" ;; esac
export PATH

HS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Config: $HOME_SERVER_CONFIG, else config/home-server.json in the repo, else ~/.home-server/config.json
# (the last keeps it out of the repo, e.g. a symlink into another private repo).
if [ -n "${HOME_SERVER_CONFIG:-}" ]; then HS_CONFIG="$HOME_SERVER_CONFIG"
elif [ -f "$HS_ROOT/config/home-server.json" ]; then HS_CONFIG="$HS_ROOT/config/home-server.json"
else
  _home="$HOME"   # under sudo, use the calling user's home, not root's
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then _home="$(eval echo "~$SUDO_USER")"; fi
  HS_CONFIG="$_home/.home-server/config.json"
fi
HS_STATE_DIR=/usr/local/var/home-server         # root-owned; staging, deploy request and status
HS_HELPER=/usr/local/sbin/home-server-helper    # root-owned; the only thing sudo runs without a password
HS_LABEL_PREFIX="${HS_LABEL_PREFIX:-local.home-server}"

_tag="$(basename "$0" .sh)"
say() { printf '[%s] %s\n' "$_tag" "$*"; }
warn() { printf '[%s] WARNING: %s\n' "$_tag" "$*" >&2; }
die() { printf '[%s] ERROR: %s\n' "$_tag" "$*" >&2; exit 1; }

need_config() {
  [ -f "$HS_CONFIG" ] || die "no config. Copy config/home-server.example.json to config/home-server.json (or ~/.home-server/config.json) and fill it in."
}

# cfg <dotted.path> [default]: print one value from the config. Array items are numbers:
# services.0.name. An array or object prints its length. Missing or empty prints the default.
# Uses plutil (built into macOS), then jq, then python3.
cfg() {
  local path="$1" def="${2:-}" out=""
  if [ -x /usr/bin/plutil ]; then
    out="$(/usr/bin/plutil -extract "$path" raw -o - "$HS_CONFIG" 2>/dev/null || true)"
  elif command -v jq >/dev/null 2>&1; then
    local jqpath; jqpath="$(printf '%s' "$path" | awk -F. '{for(i=1;i<=NF;i++){printf ($i ~ /^[0-9]+$/) ? "[" $i "]" : "[\"" $i "\"]"}}')"
    out="$(jq -r "getpath(path(.$jqpath)) // empty | if type == \"array\" or type == \"object\" then length else . end" "$HS_CONFIG" 2>/dev/null || true)"
  else
    out="$(python3 -I -c '
import json, sys
v = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    try: v = v[int(k)] if isinstance(v, list) else v[k]
    except (KeyError, IndexError, ValueError): sys.exit(0)
print(len(v) if isinstance(v, (list, dict)) else ("true" if v is True else "false" if v is False else v))
' "$HS_CONFIG" "$path" 2>/dev/null || true)"
  fi
  [ -n "$out" ] && printf '%s\n' "$out" || printf '%s\n' "$def"
}

# Names of the services in the config, one per line.
service_names() {
  local n i; n="$(cfg services 0)"
  for ((i = 0; i < n; i++)); do cfg "services.$i.name"; done
}

# service_index <name>: the array index of a service, or nothing.
service_index() {
  local n i; n="$(cfg services 0)"
  for ((i = 0; i < n; i++)); do [ "$(cfg "services.$i.name")" = "$1" ] && { echo "$i"; return; }; done
}

valid_name() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]]; }

user_home() { dscl . -read "/Users/$1" NFSHomeDirectory 2>/dev/null | awk '{print $2}'; }

on_macos() { [ "$(uname -s)" = Darwin ]; }
