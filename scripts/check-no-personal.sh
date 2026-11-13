#!/bin/bash
# Fails if anything personal is in the repo: tracked files, and (with --history) every commit
# and author line. Run it before making a copy of this repo public.
#
#   scripts/check-no-personal.sh [--history] [deny-list-file]
#
# The deny list is one string per line (your name, usernames, domains, IPs, account ids);
# lines starting with # are ignored. Keep it OUTSIDE the repo. HOME_SERVER_DENYLIST works too.
# On top of the deny list it flags generic patterns: private IPv4 addresses, email addresses
# outside example.com/example.org, UUIDs, long hex strings, and /Users/<name> paths.
# Allowed on purpose: RFC 5737 documentation addresses (192.0.2.x), the all-zero UUID and hex
# placeholders, 127.0.0.1, and GitHub's published host key fingerprint.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

HISTORY=0 LIST="${HOME_SERVER_DENYLIST:-}"
for a in "$@"; do
  case "$a" in --history) HISTORY=1 ;; *) LIST="$a" ;; esac
done

hits=0
report() { printf '%s\n' "$1"; hits=$((hits + 1)); }

GENERIC='(^|[^0-9.])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9]|$)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|/Users/[a-z][a-z0-9._-]*'
ALLOW='@example\.(com|org)|noreply@anthropic\.com|git@github\.com|00000000-0000-0000-0000-000000000000|\b0{32,}\b|/Users/(\$|svc\b|you\b|Shared\b)|SHA256:\+DiY3wvvV6TuJJhbpZisF'

# Tracked files (the hash file is a checksum of our own script, so it's skipped)
while IFS= read -r line; do
  stripped="$(printf '%s' "$line" | sed -E "s#$ALLOW##g")"
  printf '%s' "$stripped" | grep -Eq "$GENERIC" && report "pattern: $line"
done < <(git grep -nIE "$GENERIC" -- . ':!scripts/home-server-helper.sha256' ':!scripts/check-no-personal.sh' 2>/dev/null)

if [ -n "$LIST" ]; then
  [ -f "$LIST" ] || { echo "deny list not found: $LIST" >&2; exit 2; }
  while IFS= read -r term; do
    [ -z "$term" ] || [ "${term:0:1}" = "#" ] && continue
    while IFS= read -r m; do report "deny-list '$term': $m"; done < <(git grep -nIiF -- "$term" 2>/dev/null)
    if [ "$HISTORY" = 1 ]; then
      git log --all -i -S"$term" --format='%h' 2>/dev/null | while read -r c; do echo "deny-list '$term' in history: commit $c"; done | grep . && hits=$((hits + 1))
      git log --all --format='%an <%ae> | %cn <%ce> | %s%n%b' | grep -iF -- "$term" >/dev/null && report "deny-list '$term' in a commit author or message"
    fi
  done < "$LIST"
else
  echo "note: no deny list given, so only generic patterns were checked" >&2
fi

if [ "$HISTORY" = 1 ]; then
  git log --all --format='%ae%n%ce' | sort -u | grep -vE '^(noreply@anthropic\.com|.*@users\.noreply\.github\.com|noreply@github\.com)$' \
    | while read -r e; do echo "author email in history: $e"; done | grep . && hits=$((hits + 1))
fi

if [ "$hits" = 0 ]; then echo "check-no-personal: clean"; else echo "check-no-personal: $hits finding(s)"; exit 1; fi
