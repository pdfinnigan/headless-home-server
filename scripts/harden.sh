#!/bin/bash
# One-time, on the server, with sudo. Makes this Mac a headless server that is safe by default.
# Read it before running. Safe to run again: every step checks before it changes anything.
#
#   sudo scripts/harden.sh
#
# What it does:
#   1. Service user: creates the hidden, non-admin account that runs every service and the tunnel.
#   2. Root-owned folders: /usr/local/sbin (where the deploy helper lives) owned by root, so
#      nothing running as you can swap the helper; state and config folders for the helper.
#   3. Firewall: on, with stealth mode (no answer to pings or probes on closed ports).
#   4. SSH: Remote Login on, and keys only, but only once your admin account has a key in
#      ~/.ssh/authorized_keys, so this can never lock you out.
#   5. Power: never sleeps, wakes for network access, restarts after power loss where supported.
#   6. Updates: security responses and data files install automatically; macOS upgrades wait
#      for you, so a surprise restart never takes the server down.
# It never turns FileVault off. scripts/doctor.sh reports it; docs/headless.md explains the tradeoff.

set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
. "$(dirname "$0")/lib/common.sh"

on_macos || die "macOS only for now."
[ "$(id -u)" = 0 ] || die "run with sudo."
need_config
ADMIN="$(cfg server.adminUser)"
SVC="$(cfg server.serviceUser svc)"
[ -n "$ADMIN" ] && id "$ADMIN" >/dev/null 2>&1 || die "server.adminUser '$ADMIN' isn't an account on this Mac."
dseditgroup -o checkmember -m "$ADMIN" admin >/dev/null 2>&1 || die "server.adminUser '$ADMIN' isn't an admin."
[[ "$SVC" =~ ^[a-z_][a-z0-9_]{0,30}$ ]] || die "server.serviceUser '$SVC' isn't a valid account name."

# 1. Service user
if id "$SVC" >/dev/null 2>&1; then
  dseditgroup -o checkmember -m "$SVC" admin >/dev/null 2>&1 && die "'$SVC' is an admin. The service user must be a standard account."
  say "service user $SVC exists"
else
  uid=""
  for c in $(seq 401 499); do dscl . -search /Users UniqueID "$c" | grep -q . || { uid="$c"; break; }; done
  [ -n "$uid" ] || die "no free UID between 401 and 499"
  dscl . -create "/Users/$SVC"
  dscl . -create "/Users/$SVC" UniqueID "$uid"
  dscl . -create "/Users/$SVC" PrimaryGroupID 20
  dscl . -create "/Users/$SVC" UserShell /usr/bin/false
  dscl . -create "/Users/$SVC" RealName "Home server services"
  dscl . -create "/Users/$SVC" NFSHomeDirectory "/Users/$SVC"
  dscl . -create "/Users/$SVC" IsHidden 1
  dscl . -create "/Users/$SVC" Password '*'
  createhomedir -c -u "$SVC" >/dev/null
  say "created hidden service user $SVC (uid $uid, no password, no login shell)"
fi
# Its own primary group and a home only it can open: in the default group (staff) it could read
# every 750 home on the Mac, yours included. scripts/home-server-helper does the same per service.
SVC_HOME="$(user_home "$SVC")"
gid="$(dscl . -read "/Groups/$SVC" PrimaryGroupID 2>/dev/null | awk '{print $2}')"
if [ -z "$gid" ]; then
  for c in $(id -u "$SVC") $(seq 401 499); do dscl . -search /Groups PrimaryGroupID "$c" | grep -q . || { gid="$c"; break; }; done
  [ -n "$gid" ] || die "no free group id for $SVC"
  dseditgroup -o create -i "$gid" -r "Home server services" "$SVC"
fi
[ "$(id -g "$SVC")" = "$gid" ] || dscl . -create "/Users/$SVC" PrimaryGroupID "$gid"
chgrp "$gid" "$SVC_HOME"; chmod 700 "$SVC_HOME"
install -d -o "$SVC" -m 755 "$SVC_HOME/services" "$SVC_HOME/Library/Logs"
install -d -o "$SVC" -m 700 "$SVC_HOME/.cloudflared"

# 2. Root-owned folders
install -d -o root -g wheel -m 755 /usr/local/sbin /usr/local/etc/home-server
if [ "$(stat -f %u /usr/local/sbin)" != 0 ] || [ "$(stat -f %Lp /usr/local/sbin)" != 755 ]; then
  chown root:wheel /usr/local/sbin; chmod 755 /usr/local/sbin
  say "fixed /usr/local/sbin: now root:wheel 755"
fi
printf 'SERVICE_USER=%s\nADMIN_USER=%s\n' "$SVC" "$ADMIN" > /usr/local/etc/home-server/helper.conf
chown root:wheel /usr/local/etc/home-server/helper.conf; chmod 644 /usr/local/etc/home-server/helper.conf
install -d -o root -g wheel -m 755 "$HS_STATE_DIR"
install -d -o "$ADMIN" -m 755 "$HS_STATE_DIR/stage"
say "root-owned folders ready"

# 3. Firewall
FW=/usr/libexec/ApplicationFirewall/socketfilterfw
"$FW" --setglobalstate on >/dev/null
"$FW" --setstealthmode on >/dev/null
say "firewall on, stealth mode on"

# 4. SSH
systemsetup -f -setremotelogin on >/dev/null 2>&1 \
  || warn "couldn't turn on Remote Login here. Turn it on in System Settings > General > Sharing."
ADMIN_HOME="$(user_home "$ADMIN")"
if [ -s "$ADMIN_HOME/.ssh/authorized_keys" ]; then
  install -d -m 755 /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/100-keys-only.conf <<'EOF'
# Written by headless-home-server scripts/harden.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
  sshd -t || { rm -f /etc/ssh/sshd_config.d/100-keys-only.conf; die "sshd rejected the keys-only config; removed it"; }
  launchctl kickstart -k system/com.openssh.sshd >/dev/null 2>&1 || true
  say "SSH: keys only"
else
  warn "SSH still accepts passwords: $ADMIN has no ~/.ssh/authorized_keys yet. Add your laptop's key (docs/HUMAN_CHECKLIST.md) and run this again."
fi

# 5. Power
pmset -a sleep 0 disksleep 0 womp 1 >/dev/null
pmset -a displaysleep 10 >/dev/null
pmset -a disablesleep 1 >/dev/null 2>&1 || true
pmset -a autorestart 1 >/dev/null 2>&1 || warn "this Mac can't restart itself after a power loss (most laptops can't); keep it on a UPS or plugged in."
say "power: never sleeps, wakes for network"

# 6. Updates
SU=/Library/Preferences/com.apple.SoftwareUpdate
defaults write "$SU" AutomaticCheckEnabled -bool true
defaults write "$SU" AutomaticDownload -bool true
defaults write "$SU" CriticalUpdateInstall -bool true
defaults write "$SU" ConfigDataInstall -bool true
defaults write "$SU" AutomaticallyInstallMacOSUpdates -bool false
say "updates: security responses install themselves; macOS upgrades wait for you"

echo
say "done. Check everything with: scripts/doctor.sh"
