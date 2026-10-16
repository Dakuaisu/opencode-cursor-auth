#!/usr/bin/env bash
set -u
CLI="$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cli-setup.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
unset OPENCODE_CONFIG
export HOME="$ROOT/home" XDG_CONFIG_HOME="$ROOT/xdg"
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
run() { OUT="$(node "$CLI" "$@" 2>&1)"; CODE=$?; }

echo "== 1. no config -> creates opencode.json"
export OPENCODE_CONFIG_DIR="$ROOT/c1/nested"
run setup
check "exit 0" '[ $CODE -eq 0 ]'
cat >"$ROOT/c1.expected" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@vidit19sharma/opencode-cursor-auth@latest"
  ]
}
EOF
check "file content (exact, trailing newline)" 'cmp -s "$OPENCODE_CONFIG_DIR/opencode.json" "$ROOT/c1.expected"'
check "no .bak" '[ ! -e "$OPENCODE_CONFIG_DIR/opencode.json.bak-cursor-auth" ]'
check "next steps" 'grep -q "opencode auth login" <<<"$OUT"'

echo "== 2. existing opencode.json with other plugins -> appended"
export OPENCODE_CONFIG_DIR="$ROOT/c2"; mkdir -p "$OPENCODE_CONFIG_DIR"; F="$OPENCODE_CONFIG_DIR/opencode.json"
printf '{"theme":"dark","plugin":["foo@1"],"model":"x/y"}' >"$F"
cp "$F" "$ROOT/c2.orig"
echo "-- 4. --dry-run first"
run setup --dry-run
check "dry-run exit 0" '[ $CODE -eq 0 ]'
check "dry-run no write" 'cmp -s "$F" "$ROOT/c2.orig"'
check "dry-run no bak/tmp" '[ ! -e "$F.bak-cursor-auth" ] && [ ! -e "$F.tmp" ]'
check "dry-run shows plan" 'grep -q "Dry run: would update" <<<"$OUT"'
run
check "exit 0 (no args = setup)" '[ $CODE -eq 0 ]'
check "plugins + key order" '[ "$(node -e "const c=require(process.argv[1]);console.log(Object.keys(c).join()+\"|\"+c.plugin.join())" "$F")" = "theme,plugin,model|foo@1,@vidit19sharma/opencode-cursor-auth@latest" ]'
check ".bak is original" 'cmp -s "$F.bak-cursor-auth" "$ROOT/c2.orig"'
check "no .tmp left" '[ ! -e "$F.tmp" ]'

echo "== 3. run again -> already installed, untouched"
cp "$F" "$ROOT/c2.after"; rm "$F.bak-cursor-auth"
run setup
check "exit 0" '[ $CODE -eq 0 ]'
check "says already installed" 'grep -q "Already installed" <<<"$OUT"'
check "byte-identical" 'cmp -s "$F" "$ROOT/c2.after"'
check "no new .bak" '[ ! -e "$F.bak-cursor-auth" ]'

echo "== 5. opencode.jsonc with comment + trailing comma -> exit 2, untouched"
export OPENCODE_CONFIG_DIR="$ROOT/c5"; mkdir -p "$OPENCODE_CONFIG_DIR"; F="$OPENCODE_CONFIG_DIR/opencode.jsonc"
printf '{\n  // my theme\n  "theme": "a//b",\n  "plugin": ["foo@1",],\n}\n' >"$F"; cp "$F" "$ROOT/c5.orig"
printf '{}' >"$OPENCODE_CONFIG_DIR/opencode.json"
run setup
check "exit 2" '[ $CODE -eq 2 ]'
check "picked .jsonc over .json" 'grep -q "opencode.jsonc" <<<"$OUT"'
check "manual instruction" 'grep -q "\"plugin\": \[\"@vidit19sharma/opencode-cursor-auth@latest\"\]" <<<"$OUT"'
check "untouched" 'cmp -s "$F" "$ROOT/c5.orig" && [ ! -e "$F.bak-cursor-auth" ]'
printf '{\n  // c\n  "plugin": ["@vidit19sharma/opencode-cursor-auth@0.3.1",],\n}\n' >"$F"; cp "$F" "$ROOT/c5b.orig"
run setup
check "jsonc already installed -> exit 0" '[ $CODE -eq 0 ] && grep -q "Already installed" <<<"$OUT" && cmp -s "$F" "$ROOT/c5b.orig"'
printf '{ "plugin": [ oops' >"$F"
run setup
check "garbage -> exit 2" '[ $CODE -eq 2 ] && grep -q "Cannot parse" <<<"$OUT"'

echo "== 6. cursor-acp leftovers -> notice, nothing deleted"
export OPENCODE_CONFIG_DIR="$ROOT/c6"; mkdir -p "$OPENCODE_CONFIG_DIR/plugin"; F="$OPENCODE_CONFIG_DIR/opencode.json"
printf '{"provider":{"cursor-acp":{"npm":"x"}}}' >"$F"; touch "$OPENCODE_CONFIG_DIR/plugin/cursor-acp.js"
run setup
check "exit 0" '[ $CODE -eq 0 ]'
check "notice lists all three" 'grep -q "cursor-acp\" block" <<<"$OUT" && grep -q "rm .*cursor-acp.js" <<<"$OUT" && grep -q "npm uninstall -g @rama_nigg/open-cursor" <<<"$OUT"'
check "plugin file kept" '[ -e "$OPENCODE_CONFIG_DIR/plugin/cursor-acp.js" ]'
check "provider block kept" 'node -e "process.exit(require(process.argv[1]).provider[\"cursor-acp\"]?0:1)" "$F"'

echo "== 7. --config <explicit path>"
export OPENCODE_CONFIG_DIR="$ROOT/c7dir"; E="$ROOT/c7/custom.json"; mkdir -p "$ROOT/c7"
printf '{"plugin":[]}' >"$E"
run setup --config "$E"
check "exit 0" '[ $CODE -eq 0 ]'
check "explicit file edited" 'grep -q "opencode-cursor-auth@latest" "$E"'
check "default dir untouched" '[ ! -e "$OPENCODE_CONFIG_DIR" ]'
OPENCODE_CONFIG="$ROOT/c7/env.json" run setup
check "\$OPENCODE_CONFIG honoured" '[ $CODE -eq 0 ] && grep -q "opencode-cursor-auth@latest" "$ROOT/c7/env.json"'

echo "== misc"
run --help; check "--help exit 0" '[ $CODE -eq 0 ] && grep -q "Usage" <<<"$OUT"'
run --bogus; check "unknown arg exit 1" '[ $CODE -eq 1 ]'
check "real HOME/XDG untouched" '[ ! -e "$HOME" ] && [ ! -e "$XDG_CONFIG_HOME" ]'

echo; [ $fails -eq 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
