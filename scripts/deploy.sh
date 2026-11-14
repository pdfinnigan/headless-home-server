#!/bin/bash
# The one deploy command. Ships whatever on the branch hasn't been deployed yet.
#
#   scripts/deploy.sh            pull, then deploy every service whose folder or config changed
#   scripts/deploy.sh --force    pull, then redeploy every service
#   scripts/deploy.sh status     what's deployed and whether each service answers
#
# On the server it works in its own clone (server.repoPath). Anywhere else it runs the same
# command on the server over SSH (server.sshAlias, from scripts/install-ssh-alias.sh).
# The deploy watcher (scripts/install-helper.sh) runs it when $HS_STATE_DIR/request is touched,
# so a service, a cron job or an agent can ask for a deploy without SSH.

set -euo pipefail
. "$(dirname "$0")/lib/common.sh"
need_config

BRANCH="$(cfg server.branch main)"
ALIAS="$(cfg server.sshAlias homeserver)"
REPO_PATH="$(cfg server.repoPath)"

MODE=deploy FORCE=0 NO_PULL=0
for a in "$@"; do
  case "$a" in
    status) MODE=status ;;
    --force) FORCE=1 ;;
    --no-pull) NO_PULL=1 ;;   # internal: set when the script re-runs itself after a pull
    *) die "usage: $0 [status] [--force]" ;;
  esac
done

# Not on the server: run it there.
if [ ! -x "$HS_HELPER" ]; then
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$ALIAS" true 2>/dev/null \
    || die "can't reach '$ALIAS'. Is the server awake and on this network? (docs/operate.md)"
  exec ssh -o BatchMode=yes "$ALIAS" "$REPO_PATH/scripts/deploy.sh $*"
fi

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
STATE="$HOME/.home-server/deploy"
mkdir -p "$STATE"
cd "$HS_ROOT"
[ -d .git ] || die "$HS_ROOT is not a git clone. Run scripts/setup-server.sh."

entry() { local i; i="$(service_index "$1")"; printf '%s|%s|%s|%s|%s' "$(cfg "services.$i.dir")" "$(cfg "services.$i.run")" "$(cfg "services.$i.port")" "$(cfg "services.$i.expose.auth")" "$(cfg "services.$i.expose.hostname")"; }
answers() { curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$1/" 2>/dev/null || true; }

if [ "$MODE" = status ]; then
  git fetch -q origin "$BRANCH" || warn "git fetch failed"
  echo "checkout: $(git log -1 --format='%h %s' HEAD)"
  echo "$BRANCH: $(git log -1 --format='%h %cr %s' "origin/$BRANCH")"
  for s in $(service_names); do
    i="$(service_index "$s")"; port="$(cfg "services.$i.port")"
    code="$(answers "$port")"
    printf '%-16s deployed %-9s port %-5s %s\n' "$s" "$(cat "$STATE/$s.rev" 2>/dev/null || echo never)" "$port" \
      "$([ -n "$code" ] && [ "$code" != 000 ] && echo "answers (HTTP $code)" || echo "NOT ANSWERING")"
  done
  exit 0
fi

LOCK="$STATE/lock"
mkdir "$LOCK" 2>/dev/null || die "another deploy is running (remove $LOCK if it's stale)"

RUNLOG="$STATE/last-run.log"
export DEPLOY_STARTED="${DEPLOY_STARTED:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
[ "$NO_PULL" = 1 ] || { : > "$RUNLOG"; exec > >(tee -a "$RUNLOG") 2>&1; }
write_status() {  # write_status <running|ok|failed>, read by anything that asked for the deploy
  [ -w "$HS_STATE_DIR/status.txt" ] || return 0
  [ "$1" = running ] || sleep 1
  {
    echo "result: $1"
    echo "started: $DEPLOY_STARTED"
    [ "$1" = running ] || echo "finished: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "commit: $(git rev-parse --short HEAD)"
    echo "--- last output"
    tail -n 30 "$RUNLOG"
  } > "$HS_STATE_DIR/status.txt"
}
TMPFILES=()
finish() {  # reads the exit status first, before anything else can change $?
  local rc=$?
  rm -f ${TMPFILES[@]+"${TMPFILES[@]}"} 2>/dev/null   # bash 3.2-safe when empty
  if [ "$rc" = 0 ]; then write_status ok; else write_status failed; fi
  rmdir "$LOCK"
  return "$rc"
}
trap finish EXIT
write_status running

if [ "$NO_PULL" = 0 ]; then
  [ "$(git symbolic-ref --short -q HEAD)" = "$BRANCH" ] || die "the server clone isn't on $BRANCH"
  [ -z "$(git status --porcelain)" ] || die "the server clone has local changes; not touching it"
  git fetch -q origin "$BRANCH"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ]; then
    git merge -q --ff-only "origin/$BRANCH"
    say "pulled $(git log -1 --format='%h %s')"
    trap - EXIT; rmdir "$LOCK"
    exec bash "$0" "$@" --no-pull   # run the version of this script that just landed
  fi
fi

# A newer helper in the repo than the one installed needs the password once.
if ! cmp -s "$HS_ROOT/scripts/home-server-helper" "$HS_HELPER"; then
  warn "scripts/home-server-helper changed. Run 'sudo scripts/install-helper.sh' on the server once; until then the installed one keeps working."
fi

HEAD_REV="$(git rev-parse --short HEAD)"
STAGE="$HS_STATE_DIR/stage"
did=0

# 1. Services
for s in $(service_names); do
  valid_name "$s" || die "service name '$s' must be lowercase letters, digits and dashes"
  i="$(service_index "$s")"
  dir="$(cfg "services.$i.dir")"; run="$(cfg "services.$i.run")"; port="$(cfg "services.$i.port")"
  [ -d "$dir" ] || die "$s: folder $dir isn't in the repo"
  [ -n "$run" ] && [[ "$port" =~ ^[0-9]+$ ]] || die "$s: needs run and port"
  last_rev="$(cat "$STATE/$s.rev" 2>/dev/null || true)"
  last_entry="$(cat "$STATE/$s.entry" 2>/dev/null || true)"
  if [ "$FORCE" = 0 ] && [ -n "$last_rev" ] && [ "$last_entry" = "$(entry "$s")" ] && git diff --quiet "$last_rev" HEAD -- "$dir" 2>/dev/null; then
    continue
  fi
  say "$s: deploying $HEAD_REV"
  rm -rf "${STAGE:?}/$s"; mkdir -p "$STAGE/$s/app"
  git archive --format=tar "HEAD:$dir" | tar -xf - -C "$STAGE/$s/app"
  printf 'RUN=%s\nPORT=%s\n' "$run" "$port" > "$STAGE/$s/service.conf"
  sudo -n "$HS_HELPER" service "$s" || die "$s: the helper failed (see above)"
  echo "$HEAD_REV" > "$STATE/$s.rev"; entry "$s" > "$STATE/$s.entry"
  did=1
done

# 2. Services removed from the config
for f in "$STATE"/*.rev; do
  [ -e "$f" ] || continue
  s="$(basename "$f" .rev)"
  [ -n "$(service_index "$s")" ] && continue
  say "$s: no longer in the config; removing it"
  sudo -n "$HS_HELPER" remove "$s" || die "$s: the helper couldn't remove it"
  rm -f "$STATE/$s.rev" "$STATE/$s.entry"
  did=1
done

# 3. Tunnel routes for services exposed with auth public or access
tunnel="$(mktemp)"; TMPFILES+=("$tunnel")
rc=0; "$HS_ROOT/scripts/render-tunnel.sh" > "$tunnel" || rc=$?
if [ "$rc" = 3 ]; then
  warn "tunnel: public services wait until scripts/setup-tunnel.sh has run and exposure.tunnelId is set"
  : > "$tunnel"
elif [ "$rc" != 0 ]; then
  die "tunnel: render-tunnel.sh failed (see above)"
fi
if [ -s "$tunnel" ] && ! cmp -s "$tunnel" "$STATE/tunnel.yml"; then
  say "tunnel: routes changed; installing them"
  mkdir -p "$STAGE/tunnel"; cp "$tunnel" "$STAGE/tunnel/config.yml"
  sudo -n "$HS_HELPER" tunnel || die "tunnel: the helper failed (see above)"
  cp "$tunnel" "$STATE/tunnel.yml"
  did=1
fi

# 4. Tailscale-only services: publish them on the tailnet if Tailscale is installed
for s in $(service_names); do
  i="$(service_index "$s")"
  [ "$(cfg "services.$i.expose.auth")" = tailscale ] || continue
  port="$(cfg "services.$i.port")"
  if command -v tailscale >/dev/null 2>&1; then
    tailscale serve --bg --https="$port" "http://127.0.0.1:$port" >/dev/null 2>&1 \
      && say "$s: on your tailnet at port $port" || warn "$s: 'tailscale serve' failed; is Tailscale signed in?"
  else
    warn "$s: wants Tailscale, which isn't installed (docs/exposure.md)"
  fi
done

[ "$did" = 1 ] || say "nothing new to deploy at $HEAD_REV"
