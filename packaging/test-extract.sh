#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"

cat >"$TMP/bin/ags" <<'EOF'
#!/usr/bin/env bash
printf 'ags %s\n' "$*" >>"$CALLS"
EOF
chmod +x "$TMP/bin/ags"

export CALLS="$TMP/calls"
export PATH="$TMP/bin:$PATH"
export XDG_STATE_HOME="$TMP/state"
"$ROOT/bin/hypr-drawer" extract

[[ "$(<"$CALLS")" == "ags request -i hypr-drawer extract" ]]

echo "ok - Super+Alt drag extraction pipeline"
