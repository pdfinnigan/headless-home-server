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
# Started by the watcher: deploy only for a request newer than the last one handled. (launchd
# also starts it once when the watcher is loaded, with nothing new.)
if [ "${HS_TRIGGER:-}" = watch ] && [ "$NO_PULL" = 0 ]; then
  [ "$HS_STATE_DIR/request" -nt "$STATE/request.seen" ] || exit 0
  touch "$STATE/request.seen"
fi
cd "$HS_ROOT"
[ -d .git ] || die "$HS_ROOT is not a git clone. Run scripts/setup-server.sh."

# entry <service>: everything in its config entry that a deploy depends on. Source and jobs are added
# only when set, so an entry recorded before they existed still matches and doesn't redeploy.
entry() {
  local i; i="$(service_index "$1")"
  printf '%s|%s|%s|%s|%s|%s' "$(cfg "services.$i.dir")" "$(cfg "services.$i.run")" "$(cfg "services.$i.port")" "$(cfg "services.$i.expose.auth")" "$(cfg "services.$i.expose.hostname")" "$(cfg "services.$i.user" own)"
  [ -z "$(cfg "services.$i.source.repo")" ] || printf '|%s|%s' "$(cfg "services.$i.source.repo")" "$(cfg "services.$i.source.rev")"
  [ "$(cfg "services.$i.jobs" 0)" = 0 ] || { echo; job_lines "$i"; }
}

# job_lines <service index>: one JOB=<name>|<runAtLoad 0/1>|<HH:MM,...>|<run> line per scheduled job.
job_lines() {
  local i="$1" n j k nt name run at load times
  n="$(cfg "services.$i.jobs" 0)"
  for ((j = 0; j < n; j++)); do
    name="$(cfg "services.$i.jobs.$j.name")"; run="$(cfg "services.$i.jobs.$j.run")"
    valid_name "$name" || die "$(cfg "services.$i.name"): job name '$name' must be lowercase letters, digits and dashes"
    [ -n "$run" ] || die "$(cfg "services.$i.name"): job $name needs run"
    [[ "$run" != *$'\n'* ]] || die "$(cfg "services.$i.name"): job $name's run must be one line"
    times=""; nt="$(cfg "services.$i.jobs.$j.at" 0)"
    for ((k = 0; k < nt; k++)); do
      at="$(cfg "services.$i.jobs.$j.at.$k")"
      [[ "$at" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die "$(cfg "services.$i.name"): job $name time '$at' must be HH:MM"
      times="${times:+$times,}$at"
    done
    [ -n "$times" ] || die "$(cfg "services.$i.name"): job $name needs at least one time in at"
    load=0; [ "$(cfg "services.$i.jobs.$j.runAtLoad" false)" = true ] && load=1
    printf 'JOB=%s|%s|%s|%s\n' "$name" "$load" "$times" "$run"
  done
}

# stage_source <service> <repo> <rev> <dir> <dest>: copy <dir> at commit <rev> of another git repo,
# for services whose code lives outside this one. Fetches only that commit, into a cache per service.
stage_source() {
  local cache="$STATE/sources/$1.git" tree="$3"
  [ -d "$cache" ] || git init -q --bare "$cache"
  if ! git -C "$cache" cat-file -e "$3^{commit}" 2>/dev/null; then
    git -C "$cache" fetch -q --depth 1 "$2" "$3" \
      || die "$1: couldn't fetch $3 from $2. Can this account read that repo? (docs/operate.md)"
  fi
  [ -z "$4" ] || [ "$4" = . ] || tree="$3:$4"
  [ "$(git -C "$cache" cat-file -t "$tree" 2>/dev/null)" = tree ] || die "$1: $4 isn't a folder at $3 in $2"
  git -C "$cache" archive --format=tar "$tree" | tar -xf - -C "$5"
}
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
    if [ -s "$STATE/history.log" ]; then echo "--- recent deploys"; tail -n 10 "$STATE/history.log"; fi
    echo "--- last output"
    tail -n 30 "$RUNLOG"
  } > "$HS_STATE_DIR/status.txt"
}
TMPFILES=()
finish() {  # reads the exit status first, before anything else can change $?
  local rc=$?
  rm -f ${TMPFILES[@]+"${TMPFILES[@]}"} 2>/dev/null   # bash 3.2-safe when empty
  local result=failed; [ "$rc" = 0 ] && result=ok
  # One line per finished deploy, oldest first, for deploy_status and server_status: "<started> <result> <commit>".
  { echo "$DEPLOY_STARTED $result $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"; tail -n 49 "$STATE/history.log" 2>/dev/null || true; } \
    | sort > "$STATE/history.log.new" && mv "$STATE/history.log.new" "$STATE/history.log"
  write_status "$result"
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
  src_repo="$(cfg "services.$i.source.repo")"; src_rev="$(cfg "services.$i.source.rev")"
  if [ -n "$src_repo" ]; then
    [[ "$src_repo" =~ ^(https://|ssh://|git@|file://)[^[:space:]]+$ ]] || die "$s: source.repo must be an https://, ssh://, git@ or file:// URL"
    [[ "$src_rev" =~ ^[0-9a-f]{40}$ ]] || die "$s: source.rev must be a full 40-character commit hash"
  else
    [ -d "$dir" ] || die "$s: folder $dir isn't in the repo"
  fi
  [ -n "$run" ] && [[ "$port" =~ ^[0-9]+$ ]] || die "$s: needs run and port"
  isolation="$(cfg "services.$i.user" own)"
  [ "$isolation" = own ] || [ "$isolation" = shared ] || die "$s: user must be \"own\" or \"shared\""
  mcp_path=/mcp; [ "$(cfg "services.$i.expose.auth")" = gateway ] && mcp_path="/$s/mcp"
  last_rev="$(cat "$STATE/$s.rev" 2>/dev/null || true)"
  last_entry="$(cat "$STATE/$s.entry" 2>/dev/null || true)"
  this_entry="$(entry "$s")"
  # A source service changes only through its entry (the pinned rev); a local one also through its folder.
  if [ "$FORCE" = 0 ] && [ -n "$last_rev" ] && [ "$last_entry" = "$this_entry" ] \
    && { [ -n "$src_repo" ] || git diff --quiet "$last_rev" HEAD -- "$dir" 2>/dev/null; }; then
    continue
  fi
  say "$s: deploying $HEAD_REV${src_repo:+ (code: ${src_rev:0:7} of $src_repo)}"
  rm -rf "${STAGE:?}/$s"; mkdir -p "$STAGE/$s/app"
  if [ -n "$src_repo" ]; then
    stage_source "$s" "$src_repo" "$src_rev" "$dir" "$STAGE/$s/app"
  else
    git archive --format=tar "HEAD:$dir" | tar -xf - -C "$STAGE/$s/app"
  fi
  {
    printf 'RUN=%s\nPORT=%s\nISOLATION=%s\nMCP_PATH=%s\n' "$run" "$port" "$isolation" "$mcp_path"
    job_lines "$i"
  } > "$STAGE/$s/service.conf"
  sudo -n "$HS_HELPER" service "$s" || die "$s: the helper failed (see above)"
  echo "$HEAD_REV" > "$STATE/$s.rev"; printf '%s\n' "$this_entry" > "$STATE/$s.entry"
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
# --force reinstalls the tunnel too, so its LaunchDaemon picks up helper changes (its log path, say).
if [ -s "$tunnel" ] && { [ "$FORCE" = 1 ] || ! cmp -s "$tunnel" "$STATE/tunnel.yml"; }; then
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

# 5. The OAuth gateway (a Cloudflare Worker) for services exposed with auth "gateway"
if [ -n "$(cfg gateway.hostname)" ] && [ -d "$HS_ROOT/gateway" ]; then
  gw="$(mktemp)"; TMPFILES+=("$gw")
  rc=0; node "$HS_ROOT/gateway/scripts/render-config.mjs" "$HS_CONFIG" > "$gw" || rc=$?
  if [ "$rc" = 3 ]; then
    warn "gateway: not set up yet, so MCP services aren't reachable from hosted apps (docs/gateway.md)"
  elif [ "$rc" != 0 ]; then
    die "gateway: the config doesn't render (see above)"
  else
    tree="$(git rev-parse HEAD:gateway)"
    if [ "$FORCE" = 1 ] || [ "$tree" != "$(cat "$STATE/gateway.tree" 2>/dev/null)" ] || ! cmp -s "$gw" "$STATE/gateway.jsonc"; then
      say "gateway: deploying the Worker"
      build="$STATE/gateway-build"
      rm -rf "$build"; mkdir -p "$build"
      git archive --format=tar HEAD:gateway | tar -xf - -C "$build"
      cp "$gw" "$build/wrangler.jsonc"
      wrc=0; node "$HS_ROOT/gateway/scripts/render-config.mjs" --watcher "$HS_CONFIG" > "$build/wrangler.watcher.jsonc" || wrc=$?
      # A Workers-only API token, if you'd rather not keep wrangler signed in on the server.
      cf_env="$HOME/.home-server/secrets/cloudflare.env"
      (
        cd "$build"
        if [ -f "$cf_env" ]; then set -a; . "$cf_env"; set +a; fi
        npm ci --no-audit --no-fund --silent || exit 1
        # The gateway is the front door: a failing test stops the deploy and the live Worker stays as it was.
        npm test --silent || { echo "gateway: tests failed; not deploying" >&2; exit 1; }
        npx wrangler deploy
        # The watcher (gateway/src/watcher.ts): a separate Worker that alerts if the health checks stop.
        if [ "$wrc" = 0 ]; then npx wrangler deploy -c wrangler.watcher.jsonc
        elif [ "$wrc" != 3 ]; then exit 1; fi
      ) || die "gateway: deploy failed (see above). If it was wrangler: is wrangler signed in on the server (npx wrangler login), or is $cf_env set? (docs/gateway.md)"
      echo "$tree" > "$STATE/gateway.tree"; cp "$gw" "$STATE/gateway.jsonc"
      did=1
    fi
  fi
fi

[ "$did" = 1 ] || say "nothing new to deploy at $HEAD_REV"
