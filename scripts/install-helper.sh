#!/bin/bash
# One-time, on the server, with sudo, after scripts/harden.sh. Run it again whenever
# scripts/home-server-helper changes (deploy.sh tells you when).
#
#   sudo scripts/install-helper.sh            install the helper, its sudo rule and the deploy watcher
#   sudo scripts/install-helper.sh --remove   remove all three
#
# Installs:
#   /usr/local/sbin/home-server-helper       root:wheel 755, checked against scripts/home-server-helper.sha256
#   /etc/sudoers.d/home-server-helper        lets the admin user run that one file as root, no password
#   LaunchDaemon local.home-server.deploy    runs scripts/deploy.sh as the admin user whenever
#                                            /usr/local/var/home-server/request is touched (deploy on request)
#   LaunchDaemon local.home-server.logs      runs 'home-server-helper logs' as root every 15 min: rotates
#                                            the logs in /usr/local/var/log/home-server and writes the
#                                            summary that server_status shows

set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
. "$(dirname "$0")/lib/common.sh"

on_macos || die "macOS only for now."
[ "$(id -u)" = 0 ] || die "run with sudo."
SUDOERS=/etc/sudoers.d/home-server-helper
WATCH_LABEL="$HS_LABEL_PREFIX.deploy"
WATCH_PLIST="/Library/LaunchDaemons/$WATCH_LABEL.plist"
LOGS_LABEL="$HS_LABEL_PREFIX.logs"
LOGS_PLIST="/Library/LaunchDaemons/$LOGS_LABEL.plist"
LOGDIR=/usr/local/var/log/home-server

if [ "${1:-}" = --remove ]; then
  launchctl bootout "system/$WATCH_LABEL" >/dev/null 2>&1 || true
  launchctl bootout "system/$LOGS_LABEL" >/dev/null 2>&1 || true
  rm -f "$WATCH_PLIST" "$LOGS_PLIST" "$SUDOERS" "$HS_HELPER"
  say "removed the helper, its sudo rule, the deploy watcher and the log job. Services keep running."
  exit 0
fi

need_config
[ -f /usr/local/etc/home-server/helper.conf ] || die "run scripts/harden.sh first."
ADMIN="$(cfg server.adminUser)"
id "$ADMIN" >/dev/null 2>&1 || die "server.adminUser '$ADMIN' isn't an account on this Mac."
[ "$(stat -f %u /usr/local/sbin)" = 0 ] || die "/usr/local/sbin isn't owned by root. Run scripts/harden.sh first."

# 1. Helper, only if it matches the reviewed hash
(cd "$HS_ROOT/scripts" && shasum -a 256 -c home-server-helper.sha256 >/dev/null) \
  || die "scripts/home-server-helper doesn't match scripts/home-server-helper.sha256. Review the change, update the hash, then run this again."
install -o root -g wheel -m 755 "$HS_ROOT/scripts/home-server-helper" "$HS_HELPER"
say "installed $HS_HELPER"

# 2. Sudo rule for exactly that file
tmp="$(mktemp)"
echo "$ADMIN ALL=(root) NOPASSWD: $HS_HELPER" > "$tmp"
visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "visudo rejected the rule"; }
install -o root -g wheel -m 440 "$tmp" "$SUDOERS"; rm -f "$tmp"
say "sudo rule: $ADMIN may run $HS_HELPER without a password, nothing else"

# 3. Deploy watcher
ADMIN_HOME="$(user_home "$ADMIN")"
touch "$HS_STATE_DIR/request" "$HS_STATE_DIR/status.txt"
# The request file belongs to the service user, so a service (say, an MCP deploy tool) can ask
# for a deploy; the admin user can just run scripts/deploy.sh. The status file belongs to the
# admin user, who runs deploys. Neither holds secrets.
SVC="$(cfg server.serviceUser svc)"
chown "$SVC:staff" "$HS_STATE_DIR/request"; chmod 664 "$HS_STATE_DIR/request"
chown "$ADMIN" "$HS_STATE_DIR/status.txt"; chmod 644 "$HS_STATE_DIR/status.txt"
install -d -o root -g wheel -m 755 "$LOGDIR"
[ -f "$LOGDIR/deploy.log" ] && [ ! -L "$LOGDIR/deploy.log" ] || { rm -f "$LOGDIR/deploy.log"; : > "$LOGDIR/deploy.log"; }
chown "$ADMIN:admin" "$LOGDIR/deploy.log"; chmod 640 "$LOGDIR/deploy.log"
tmp="$(mktemp)"
cat > "$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$WATCH_LABEL</string>
  <key>UserName</key><string>$ADMIN</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HS_ROOT/scripts/deploy.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$ADMIN_HOME</string>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME_SERVER_CONFIG</key><string>$HS_CONFIG</string>
    <key>HS_TRIGGER</key><string>watch</string>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>WatchPaths</key><array><string>$HS_STATE_DIR/request</string></array>
  <key>StandardOutPath</key><string>$LOGDIR/deploy.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/deploy.log</string>
</dict>
</plist>
EOF
plutil -lint "$tmp" >/dev/null || die "rendered watcher plist is invalid: $tmp"
install -o root -g wheel -m 644 "$tmp" "$WATCH_PLIST"; rm -f "$tmp"
launchctl bootout "system/$WATCH_LABEL" >/dev/null 2>&1 || true
# launchd fires a WatchPaths job when it loads it. Mark the current request as handled, so that
# first run exits without deploying anything (deploy.sh compares the two).
sudo -u "$ADMIN" mkdir -p "$ADMIN_HOME/.home-server/deploy"
sudo -u "$ADMIN" touch "$ADMIN_HOME/.home-server/deploy/request.seen"
launchctl bootstrap system "$WATCH_PLIST"
say "deploy watcher installed: touch $HS_STATE_DIR/request to deploy"

# 4. Log job: rotation and the summary server_status reads
tmp="$(mktemp)"
cat > "$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LOGS_LABEL</string>
  <key>ProgramArguments</key><array><string>$HS_HELPER</string><string>logs</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/var/log/home-server-logs.log</string>
  <key>StandardErrorPath</key><string>/var/log/home-server-logs.log</string>
</dict>
</plist>
EOF
plutil -lint "$tmp" >/dev/null || die "rendered log job plist is invalid: $tmp"
install -o root -g wheel -m 644 "$tmp" "$LOGS_PLIST"; rm -f "$tmp"
launchctl bootout "system/$LOGS_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap system "$LOGS_PLIST"
say "log job installed: logs live in $LOGDIR (the admin group can read them), rotated at 1 MB"
say "services move their logs there on their next deploy; run scripts/deploy.sh --force once to move them all"
