#!/usr/bin/env bash
# hypr-drawer uninstaller — reverses install.sh.
set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local}"
APP_DIR="$PREFIX/share/hypr-drawer"
BIN="$PREFIX/bin/hypr-drawer"
HYPR_CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/hypr"
HYPR_CONF="$HYPR_CONF_DIR/hyprland.conf"
DRAWER_CONF="$HYPR_CONF_DIR/drawer.conf"
BIND_CONF="$HYPR_CONF_DIR/drawer-bind.conf"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/hypr-drawer"
SOURCE_LINE="source = $DRAWER_CONF"

say() { printf '\033[1;36m::\033[0m %s\n' "$*"; }

# Stop the daemon
if command -v ags >/dev/null 2>&1; then
    ags request -i hypr-drawer quit >/dev/null 2>&1 || true
fi

# Evict any windows still trapped in a per-monitor drawer special back to
# their host monitor's active regular workspace, so they remain reachable
# after the daemon is gone. Requires jq (Hyprland's -j output is JSON);
# skip with a warning if missing.
if pgrep -x Hyprland >/dev/null 2>&1; then
    if command -v jq >/dev/null 2>&1; then
        # Map: monitor_id -> active regular workspace id.
        mon_ws=$(hyprctl -j monitors 2>/dev/null \
            | jq -r '.[] | "\(.id) \(.activeWorkspace.id)"')
        # Each line: address monitor_id
        trapped=$(hyprctl -j clients 2>/dev/null \
            | jq -r '.[] | select(.workspace.name | startswith("special:drawer-")) | "\(.address) \(.monitor)"')
        if [ -n "$trapped" ]; then
            say "Evicting drawer-special windows back to regular workspaces"
            while IFS=' ' read -r addr monid; do
                [ -z "$addr" ] && continue
                wsid=$(echo "$mon_ws" | awk -v m="$monid" '$1 == m { print $2 }')
                [ -z "$wsid" ] && continue
                hyprctl dispatch movetoworkspacesilent "$wsid,address:$addr" >/dev/null 2>&1 || true
            done <<< "$trapped"
        fi
    else
        say "jq not found — skipping drawer-special window eviction (windows may remain hidden)"
    fi
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
[ -f "$BIND_CONF" ] && { say "Removing $BIND_CONF"; rm -f "$BIND_CONF"; }
[ -L "$BIN" ] || [ -f "$BIN" ] && { say "Removing $BIN"; rm -f "$BIN"; }
[ -d "$APP_DIR" ] && { say "Removing $APP_DIR"; rm -rf "$APP_DIR"; }

[ -d "$STATE_DIR" ] && { say "Removing $STATE_DIR"; rm -rf "$STATE_DIR"; }

if pgrep -x Hyprland >/dev/null 2>&1; then
    hyprctl reload >/dev/null 2>&1 || true
fi

echo "✓ hypr-drawer uninstalled."
