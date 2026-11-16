#!/bin/bash
# Exercises scripts/deploy.sh end to end on Linux (CI) with a stand-in for the root helper: staging
# a local service, a service whose code comes from another repo (source), and scheduled jobs.
#
#   scripts/test/deploy-test.sh
#
# Needs git, jq and passwordless sudo (to put the stand-in helper at /usr/local/sbin). It refuses to
# run on macOS or where a real helper is installed, so it can't touch a real server.

set -euo pipefail
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER=/usr/local/sbin/home-server-helper
STATE_DIR=/usr/local/var/home-server
MARK="deploy-test stand-in"

[ "$(uname -s)" != Darwin ] || { echo "deploy-test: Linux only (it replaces the root helper)" >&2; exit 1; }
if [ -e "$HELPER" ] && ! grep -q "$MARK" "$HELPER"; then
  echo "deploy-test: a real helper is installed at $HELPER; not touching it" >&2; exit 1
fi

W="$(mktemp -d)"
cleanup() { sudo rm -f "$HELPER"; sudo rm -rf "$STATE_DIR"; rm -rf "$W"; }
trap cleanup EXIT
fails=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1" >&2; fails=$((fails + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
git_q() { git -c user.name=test -c user.email=test@example.com -c init.defaultBranch=main "$@"; }

# The stand-in helper records each call and keeps a copy of what was staged.
sudo mkdir -p "$STATE_DIR/stage" "$STATE_DIR/out"
sudo chown -R "$(id -u)" "$STATE_DIR"
sudo tee "$HELPER" >/dev/null <<EOF
#!/bin/sh
# $MARK
echo "\$*" >> $STATE_DIR/out/calls
[ "\$1" = service ] && { rm -rf "$STATE_DIR/out/\$2"; cp -R "$STATE_DIR/stage/\$2" "$STATE_DIR/out/\$2"; }
# It runs as root under sudo: hand what it wrote back to the test's user.
chown -R "\${SUDO_UID:-0}" "$STATE_DIR/out"
exit 0
EOF
sudo chmod 755 "$HELPER"

# Another repo that holds an app in backend/.
git_q init -q "$W/app"
mkdir -p "$W/app/backend"; echo v1 > "$W/app/backend/version.txt"; echo other > "$W/app/README.md"
git_q -C "$W/app" add -A; git_q -C "$W/app" commit -qm v1
REV1="$(git -C "$W/app" rev-parse HEAD)"

# A server clone of this repo with a config using both kinds of service.
git_q init -q --bare "$W/origin.git"
mkdir -p "$W/server/config"
cp -R "$HERE/scripts" "$HERE/services" "$W/server/"
write_config() {  # write_config <app rev>
  jq -n --arg repo "file://$W/app" --arg rev "$1" '{
    server: {name: "t", adminUser: "t", serviceUser: "svc", branch: "main"},
    services: [
      {name: "py", dir: "services/examples/python-api", run: ".venv/bin/python server.py", port: 18082,
       expose: {auth: "local"},
       jobs: [{name: "stamp", run: ".venv/bin/python job.py", at: ["03:00", "15:00"], runAtLoad: true}]},
      {name: "app", dir: "backend", run: "true", port: 18083, expose: {auth: "local"},
       source: {repo: $repo, rev: $rev}}
    ]}' > "$W/server/config/home-server.json"
}
write_config "$REV1"
git_q -C "$W/server" init -q
git_q -C "$W/server" add -A; git_q -C "$W/server" commit -qm init
git -C "$W/server" remote add origin "$W/origin.git"; git -C "$W/server" push -q -u origin main

deploy() { (cd "$W/server" && HOME="$W/home" scripts/deploy.sh "$@" 2>&1) > "$W/last.log"; }
calls() { cat "$STATE_DIR/out/calls" 2>/dev/null; }
commit_config() { git_q -C "$W/server" commit -qam "$1"; git -C "$W/server" push -q; }
mkdir -p "$W/home"

# 1. First deploy stages both services.
deploy || { cat "$W/last.log"; fail "first deploy runs"; }
check "both services deployed" '[ "$(calls)" = "$(printf "service py\nservice app")" ]'
check "local service staged from this repo" '[ -f "$STATE_DIR/out/py/app/server.py" ]'
check "job line written" 'grep -qx "JOB=stamp|1|03:00,15:00|.venv/bin/python job.py" "$STATE_DIR/out/py/service.conf"'
check "source service staged from its folder only" '[ "$(cat "$STATE_DIR/out/app/app/version.txt")" = v1 ] && [ ! -e "$STATE_DIR/out/app/app/README.md" ]'
check "source service has no job lines" '! grep -q "^JOB=" "$STATE_DIR/out/app/service.conf"'

# 2. Nothing changed: nothing deploys.
: > "$STATE_DIR/out/calls"
deploy || fail "second deploy runs"
check "unchanged config deploys nothing" '[ -z "$(calls)" ] && grep -q "nothing new to deploy" "$W/last.log"'

# 3. A new commit in the other repo alone does nothing until the pin moves.
echo v2 > "$W/app/backend/version.txt"; git_q -C "$W/app" commit -qam v2
REV2="$(git -C "$W/app" rev-parse HEAD)"
deploy || fail "deploy after upstream commit runs"
check "unpinned upstream commit deploys nothing" '[ -z "$(calls)" ]'
write_config "$REV2"; commit_config "bump app"
deploy || { cat "$W/last.log"; fail "deploy after bump runs"; }
check "moving the pin redeploys only that service" '[ "$(calls)" = "service app" ]'
check "new version staged" '[ "$(cat "$STATE_DIR/out/app/app/version.txt")" = v2 ]'

# 4. Changing a job redeploys its service.
: > "$STATE_DIR/out/calls"
jq '.services[0].jobs[0].at = ["04:30"]' "$W/server/config/home-server.json" > "$W/c.json"
mv "$W/c.json" "$W/server/config/home-server.json"; commit_config "job time"
deploy || fail "deploy after job change runs"
check "job change redeploys its service" '[ "$(calls)" = "service py" ] && grep -qx "JOB=stamp|1|04:30|.venv/bin/python job.py" "$STATE_DIR/out/py/service.conf"'

# 5. Bad values stop the deploy before the helper runs.
bad() {  # bad <name> <jq filter> <expected message>
  : > "$STATE_DIR/out/calls"
  jq "$2" "$W/server/config/home-server.json" > "$W/c.json"; cp "$W/server/config/home-server.json" "$W/good.json"
  mv "$W/c.json" "$W/server/config/home-server.json"; commit_config "$1"
  if deploy; then fail "$1 is refused"; elif grep -q "$3" "$W/last.log"; then pass "$1 is refused"; else cat "$W/last.log"; fail "$1 says why"; fi
  check "$1 never reaches the helper" '[ -z "$(calls)" ]'
  cp "$W/good.json" "$W/server/config/home-server.json"; commit_config "undo $1"
}
bad "a branch name as rev" '.services[1].source.rev = "main"' "full 40-character commit hash"
bad "a repo that is an option" '.services[1].source.repo = "--upload-pack=x"' "source.repo must be"
bad "a bad job time" '.services[0].jobs[0].at = ["25:00"]' "must be HH:MM"
bad "a job with no time" '.services[0].jobs[0].at = []' "needs at least one time"
bad "a commit missing upstream" '.services[1].source.rev = "1111111111111111111111111111111111111111"' "couldn't fetch"

echo
[ "$fails" = 0 ] && echo "deploy-test: all passed" || { echo "deploy-test: $fails failed" >&2; exit 1; }
