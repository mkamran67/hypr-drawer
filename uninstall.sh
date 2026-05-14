#!/usr/bin/env bash
# hypr-drawer uninstaller — reverses install.sh.
set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local}"
APP_DIR="$PREFIX/share/hypr-drawer"
BIN="$PREFIX/bin/hypr-drawer"
HYPR_CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/hypr"
HYPR_CONF="$HYPR_CONF_DIR/hyprland.conf"
DRAWER_CONF="$HYPR_CONF_DIR/drawer.conf"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/hypr-drawer"
SOURCE_LINE="source = $DRAWER_CONF"

say() { printf '\033[1;36m::\033[0m %s\n' "$*"; }

# Stop the daemon
if command -v ags >/dev/null 2>&1; then
    ags request -i hypr-drawer quit >/dev/null 2>&1 || true
fi

# Remove the source line + marker comment from hyprland.conf
if [ -f "$HYPR_CONF" ] && grep -Fq "$SOURCE_LINE" "$HYPR_CONF"; then
    say "Removing source line from $HYPR_CONF"
    tmp="$(mktemp)"
    # Strip our marker comment + the source line, preserving everything else.
    awk -v line="$SOURCE_LINE" '
        /^# Added by hypr-drawer installer$/ { skip = 1; next }
        skip && $0 == line { skip = 0; next }
        { print }
    ' "$HYPR_CONF" > "$tmp"
    mv "$tmp" "$HYPR_CONF"
fi

[ -f "$DRAWER_CONF" ] && { say "Removing $DRAWER_CONF"; rm -f "$DRAWER_CONF"; }
[ -L "$BIN" ] || [ -f "$BIN" ] && { say "Removing $BIN"; rm -f "$BIN"; }
[ -d "$APP_DIR" ] && { say "Removing $APP_DIR"; rm -rf "$APP_DIR"; }

# Ask before nuking saved positions.
if [ -d "$STATE_DIR" ]; then
    read -r -p "Also delete saved positions in $STATE_DIR? [y/N] " ans
    case "$ans" in
        y|Y) rm -rf "$STATE_DIR"; say "Removed $STATE_DIR" ;;
        *)   say "Kept $STATE_DIR" ;;
    esac
fi

if pgrep -x Hyprland >/dev/null 2>&1; then
    hyprctl reload >/dev/null 2>&1 || true
fi

echo "✓ hypr-drawer uninstalled."
