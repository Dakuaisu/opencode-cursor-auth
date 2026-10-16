#!/usr/bin/env bash
set -euo pipefail

command -v opencode >/dev/null || { echo "opencode not on PATH"; exit 1; }
BUN=$(command -v bun || echo /opt/homebrew/bin/bun)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/ocsmoke.XXXXXX")
TMP=$(cd "$TMP" && pwd -P)
tmp_pids() { ps -Eww -axo pid=,command= | awk -v t="$TMP" -v me=$$ 'index($0, t) && $1 != me && $2 !~ /^(ps|awk|bash|sh|sleep|grep|-?zsh)$/ {print $1}'; }
killtmp() { local p; p=$(tmp_pids); [ -n "$p" ] && kill $p 2>/dev/null; sleep 1; p=$(tmp_pids); [ -n "$p" ] && kill -9 $p 2>/dev/null; return 0; }
cleanup() { killtmp; rm -rf "$TMP"; }
trap cleanup EXIT

H="$TMP/home"
mkdir -p "$TMP/pkg" "$H/.config/opencode" "$H/.local/share" "$H/.cache"
oc_env=(env HOME="$H" XDG_CONFIG_HOME="$H/.config" XDG_DATA_HOME="$H/.local/share" XDG_CACHE_HOME="$H/.cache")
with_timeout() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV' "$s" "$@"; }

cd "$ROOT"
npx tsc
TARBALL="$TMP/$(npm pack --silent --pack-destination "$TMP" | tail -1)"
(cd "$TMP/pkg" && echo '{}' > package.json && "$BUN" add "$TARBALL" >/dev/null)
DIST="$TMP/pkg/node_modules/@vidit19sharma/opencode-cursor-auth/dist/index.js"
[ -f "$DIST" ] || { echo "installed dist missing: $DIST"; exit 1; }
printf '{"$schema":"https://opencode.ai/config.json","plugin":["file://%s"]}\n' "$DIST" > "$H/.config/opencode/opencode.json"

declare -a SUMMARY=()
FAILED=0
record() { SUMMARY+=("$1 $2"); [ "$1" = FAIL ] && FAILED=1; return 0; }

cd "$TMP"
echo "--- step 1: opencode models"
out=$(with_timeout 90 "${oc_env[@]}" opencode models 2>&1 || true)
echo "$out" | grep -E 'cursor/|rror' | head -5 || true
if ! grep -q "Unexpected error" <<<"$out" && grep -q "cursor/auto" <<<"$out"; then record PASS "1 models lists cursor/auto"; else echo "$out" | tail -20; record FAIL "1 models"; fi

echo "--- step 2: opencode auth login"
if command -v expect >/dev/null; then
  out=$(with_timeout 40 "${oc_env[@]}" expect -c '
    set timeout 25
    spawn opencode auth login
    expect { -re "Select provider|Add credential" { exit 0 } timeout { exit 2 } eof { exit 3 } }' 2>&1) && rc=0 || rc=$?
  if [ $rc -eq 0 ] && ! grep -q "Unexpected" <<<"$out"; then record PASS "2 auth login prompt shown"; else echo "$out" | tail -20; record FAIL "2 auth login (rc=$rc)"; fi
else
  record SKIP "2 auth login (no expect)"
fi
killtmp
rm -f "$H/.local/share/opencode/auth.json"
rm -rf "$H/.cursor"

echo "--- step 3: first request before auth login"
start=$(date +%s)
out=$(with_timeout 60 "${oc_env[@]}" opencode run -m cursor/auto "say ok" 2>&1) && rc=0 || rc=$?
echo "$out" | tail -5
echo "(exit $rc after $(( $(date +%s) - start ))s)"
if [ $rc -ne 142 ] && grep -q "opencode auth login" <<<"$out"; then record PASS "3 first request returns 'run opencode auth login'"; else record FAIL "3 first request (rc=$rc)"; fi

echo "=== summary"
printf '%s\n' "${SUMMARY[@]}"
exit $FAILED
