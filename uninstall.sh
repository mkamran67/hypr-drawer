#!/usr/bin/env bash
# hypr-drawer uninstaller — reverses install.sh.
#
# Usage: ./uninstall.sh [--purge]
#   --purge   also delete settings, saved window positions and the daemon log.
#             Without it, $STATE_DIR is left alone and its path printed.
set -euo pipefail

PURGE=0
for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=1 ;;
        -h|--help)
            sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            printf '\033[1;31m✗\033[0m unknown option: %s (try --help)\n' "$arg" >&2
            exit 2
            ;;
    esac
done

PREFIX="${PREFIX:-$HOME/.local}"
APP_DIR="$PREFIX/share/hypr-drawer"
BIN="$PREFIX/bin/hypr-drawer"
HYPR_CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/hypr"
HYPR_CONF="$HYPR_CONF_DIR/hyprland.conf"
DRAWER_CONF="$HYPR_CONF_DIR/drawer.conf"
BIND_CONF="$HYPR_CONF_DIR/drawer-bind.conf"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/hypr-drawer"
SOURCE_LINE="source = $DRAWER_CONF"

say()  { printf '\033[1;36m::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# Every .conf under the hypr config dir that mentions drawer.conf.
#
# Searching the whole directory rather than just hyprland.conf is the point:
# HyDE and most dotfile frameworks move user `source` lines into
# userprefs.conf, and the old code only ever looked at hyprland.conf. A source
# line it couldn't see survived the uninstall, and since drawer.conf was
# deleted unconditionally, that left Hyprland with a hard config error on the
# next reload.
# -R, not -r: plain -r skips symlinks found during recursion, and dotfile
# frameworks routinely symlink these files in from a git repo. Missing one
# means the source line survives while drawer.conf gets deleted — exactly the
# broken-config case this is here to prevent.
referencing_files() {
    [ -d "$HYPR_CONF_DIR" ] || return 0
    grep -RlF "$DRAWER_CONF" "$HYPR_CONF_DIR" --include='*.conf' 2>/dev/null || true
}

# Remove our source line from one file, plus the marker comment and blank line
# install.sh wrote above it — but only when the marker really is ours. A marker
# that isn't followed by our source line belongs to the user and is preserved.
strip_source_line() {
    local f="$1" tmp
    tmp="$(mktemp)"
    awk -v line="$SOURCE_LINE" '
        function flush(  i) { for (i = 1; i <= nbuf; i++) print buf[i]; nbuf = 0 }
        BEGIN { nbuf = 0; have_marker = 0 }
        # Buffer blank lines and our marker; we do not yet know whether they
        # precede our source line.
        /^[[:space:]]*$/                        { buf[++nbuf] = $0; next }
        /^# Added by hypr-drawer installer$/    { buf[++nbuf] = $0; have_marker = 1; next }
        {
            t = $0
            sub(/^[[:space:]]+/, "", t)
            sub(/[[:space:]]+$/, "", t)
            if (t == line) {
                # Drop the source line. Drop the buffered marker and blanks
                # with it only if the marker was ours; otherwise those lines
                # belong to the user and get printed.
                # (No apostrophes in here: this block is shell single-quoted.)
                if (have_marker) nbuf = 0; else flush()
                have_marker = 0
                next
            }
            flush(); have_marker = 0
            print
        }
        END { flush() }
    ' "$f" > "$tmp"
    # `cat >` rather than `mv`: mv replaces the inode, which destroys symlinks
    # (dotfile frameworks symlink these files into a git repo) and carries
    # the 0600 permissions of mktemp across filesystems.
    cat "$tmp" > "$f"
    rm -f "$tmp"
}

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

# Remove our source line from every file that carries it, wherever it lives.
refs="$(referencing_files)"
if [ -n "$refs" ]; then
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        say "Removing source line from $f"
        strip_source_line "$f"
    done <<< "$refs"
fi

# Only delete drawer.conf once nothing points at it any more. Deleting it
# while a reference survives is what turns a stale source line into a hard
# Hyprland config error.
remaining="$(referencing_files)"
if [ -n "$remaining" ]; then
    warn "Not removing $DRAWER_CONF — still referenced by:"
    while IFS= read -r f; do
        [ -n "$f" ] && warn "    $f"
    done <<< "$remaining"
    warn "Remove those lines by hand, then delete $DRAWER_CONF."
elif [ -f "$DRAWER_CONF" ]; then
    say "Removing $DRAWER_CONF"; rm -f "$DRAWER_CONF"
fi

[ -f "$BIND_CONF" ] && { say "Removing $BIND_CONF"; rm -f "$BIND_CONF"; }
[ -L "$BIN" ] || [ -f "$BIN" ] && { say "Removing $BIN"; rm -f "$BIN"; }
[ -d "$APP_DIR" ] && { say "Removing $APP_DIR"; rm -rf "$APP_DIR"; }

# State holds settings.json, positions.json and usage.json — user data the
# installer never created and an uninstall has no business destroying by
# default.
if [ -d "$STATE_DIR" ]; then
    if [ "$PURGE" = 1 ]; then
        say "Removing $STATE_DIR (--purge)"
        rm -rf "$STATE_DIR"
    else
        say "Keeping settings and saved window positions in $STATE_DIR"
        say "  (re-run with --purge to delete them)"
    fi
fi

if pgrep -x Hyprland >/dev/null 2>&1; then
    hyprctl reload >/dev/null 2>&1 || true
fi

echo "✓ hypr-drawer uninstalled."
