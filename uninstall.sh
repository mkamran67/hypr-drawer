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
DRAWER_LUA="$HYPR_CONF_DIR/drawer.lua"
BIND_CONF="$HYPR_CONF_DIR/drawer-bind.conf"
BIND_LUA="$HYPR_CONF_DIR/drawer-bind.lua"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/hypr-drawer"
SOURCE_LINE="source = $DRAWER_CONF"
REQUIRE_LINE='require("drawer")'

say()  { printf '\033[1;36m::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

# Every config file under the hypr config dir that carries one of our hook
# lines. Both providers are always swept, whichever one is active now: a user
# who migrated hyprland.conf to hyprland.lua between install and uninstall
# would otherwise be left with a stale hook pointing at a deleted file.
#
# Searching the whole directory rather than just the top-level config is the
# point: HyDE and most dotfile frameworks move user `source` lines into
# userprefs.conf, and the old code only ever looked at hyprland.conf. A source
# line it couldn't see survived the uninstall, and since drawer.conf was
# deleted unconditionally, that left Hyprland with a hard config error on the
# next reload.
# -R, not -r: plain -r skips symlinks found during recursion, and dotfile
# frameworks routinely symlink these files in from a git repo. Missing one
# means the hook survives while its target gets deleted — exactly the
# broken-config case this is here to prevent.
#
# `require("drawer-bind")` inside drawer.lua does not contain the exact string
# `require("drawer")`, so drawer.lua never matches itself.
referencing_conf() {
    [ -d "$HYPR_CONF_DIR" ] || return 0
    grep -RlF "$DRAWER_CONF" "$HYPR_CONF_DIR" --include='*.conf' 2>/dev/null || true
}
referencing_lua() {
    [ -d "$HYPR_CONF_DIR" ] || return 0
    grep -RlF "$REQUIRE_LINE" "$HYPR_CONF_DIR" --include='*.lua' 2>/dev/null || true
}

# Remove one hook line from one file, plus the marker comment and blank line
# install.sh wrote above it — but only when the marker really is ours. A marker
# that isn't followed by our hook line belongs to the user and is preserved.
strip_hook_line() {
    local f="$1" line="$2" marker="$3" tmp
    tmp="$(mktemp)"
    awk -v line="$line" -v marker="$marker" '
        function flush(  i) { for (i = 1; i <= nbuf; i++) print buf[i]; nbuf = 0 }
        BEGIN { nbuf = 0; have_marker = 0 }
        # Buffer blank lines and our marker; we do not yet know whether they
        # precede our hook line.
        /^[[:space:]]*$/ { buf[++nbuf] = $0; next }
        $0 == marker     { buf[++nbuf] = $0; have_marker = 1; next }
        {
            t = $0
            sub(/^[[:space:]]+/, "", t)
            sub(/[[:space:]]+$/, "", t)
            if (t == line) {
                # Drop the hook line. Drop the buffered marker and blanks
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
        # Under the Lua config provider `hyprctl dispatch X Y` is wrapped as
        # `return hl.dispatch(X Y)` and parsed as Lua, so the legacy dispatcher
        # string below is a syntax error rather than a command — the eviction
        # would silently no-op and leave windows stranded in a special
        # workspace with no daemon left to reveal it.
        live_provider="$(hyprctl systeminfo 2>/dev/null \
            | sed -n 's/^configProvider:[[:space:]]*\([a-z]*\).*/\1/p' | head -1)"
        if [ -n "$trapped" ]; then
            say "Evicting drawer-special windows back to regular workspaces"
            while IFS=' ' read -r addr monid; do
                [ -z "$addr" ] && continue
                wsid=$(echo "$mon_ws" | awk -v m="$monid" '$1 == m { print $2 }')
                [ -z "$wsid" ] && continue
                if [ "$live_provider" = lua ]; then
                    hyprctl dispatch \
                        "hl.dsp.window.move({ workspace = \"$wsid\", silent = true, window = \"address:$addr\" })" \
                        >/dev/null 2>&1 || true
                else
                    hyprctl dispatch movetoworkspacesilent "$wsid,address:$addr" >/dev/null 2>&1 || true
                fi
            done <<< "$trapped"
        fi
    else
        say "jq not found — skipping drawer-special window eviction (windows may remain hidden)"
    fi
fi

# Remove our hook lines from every file that carries them, wherever they live.
refs="$(referencing_conf)"
if [ -n "$refs" ]; then
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        say "Removing source line from $f"
        strip_hook_line "$f" "$SOURCE_LINE" '# Added by hypr-drawer installer'
    done <<< "$refs"
fi
refs="$(referencing_lua)"
if [ -n "$refs" ]; then
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        say "Removing require line from $f"
        strip_hook_line "$f" "$REQUIRE_LINE" '-- Added by hypr-drawer installer'
    done <<< "$refs"
fi

# Only delete a snippet once nothing points at it any more. Deleting one while
# a reference survives is what turns a stale hook into a hard Hyprland config
# error on the next reload.
remaining="$(referencing_conf)"
if [ -n "$remaining" ]; then
    warn "Not removing $DRAWER_CONF — still referenced by:"
    while IFS= read -r f; do
        [ -n "$f" ] && warn "    $f"
    done <<< "$remaining"
    warn "Remove those lines by hand, then delete $DRAWER_CONF."
elif [ -f "$DRAWER_CONF" ]; then
    say "Removing $DRAWER_CONF"; rm -f "$DRAWER_CONF"
fi

remaining="$(referencing_lua)"
if [ -n "$remaining" ]; then
    warn "Not removing $DRAWER_LUA — still required by:"
    while IFS= read -r f; do
        [ -n "$f" ] && warn "    $f"
    done <<< "$remaining"
    warn "Remove those lines by hand, then delete $DRAWER_LUA."
elif [ -f "$DRAWER_LUA" ]; then
    say "Removing $DRAWER_LUA"; rm -f "$DRAWER_LUA"
fi

[ -f "$BIND_CONF" ] && { say "Removing $BIND_CONF"; rm -f "$BIND_CONF"; }
[ -f "$BIND_LUA" ]  && { say "Removing $BIND_LUA";  rm -f "$BIND_LUA"; }
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
