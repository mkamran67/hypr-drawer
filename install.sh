#!/usr/bin/env bash
# hypr-drawer installer — user-level, idempotent, cross-distro.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"
APP_DIR="$PREFIX/share/hypr-drawer"
BIN_DIR="$PREFIX/bin"
HYPR_CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/hypr"
HYPR_CONF="$HYPR_CONF_DIR/hyprland.conf"
DRAWER_CONF="$HYPR_CONF_DIR/drawer.conf"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/hypr-drawer"
SOURCE_LINE="source = $DRAWER_CONF"

say()  { printf '\033[1;36m::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Sanity checks
command -v hyprctl >/dev/null 2>&1 \
    || die "hyprctl not found. Install Hyprland first: https://hyprland.org"

# 2. Install runtime deps
say "Installing runtime dependencies"
# shellcheck source=packaging/deps.sh
source "$SCRIPT_DIR/packaging/deps.sh"
# Fatal on purpose: without ags v3 the daemon cannot start, and continuing
# would leave a keybind that fails silently with a "daemon failed to start".
install_deps || die "Dependency step failed — review messages above and re-run."

# 3. Lay out directories
say "Creating directories"
mkdir -p "$APP_DIR" "$BIN_DIR" "$HYPR_CONF_DIR" "$STATE_DIR"

# 4. Copy app source
say "Installing app to $APP_DIR"
rm -rf "$APP_DIR"/{app,bin,config,packaging}
cp -r "$SCRIPT_DIR/app"        "$APP_DIR/"
cp -r "$SCRIPT_DIR/bin"        "$APP_DIR/"
cp -r "$SCRIPT_DIR/config"     "$APP_DIR/"
cp -r "$SCRIPT_DIR/packaging"  "$APP_DIR/"
# The wrapper expects `app.ts` at $APP_DIR/app.ts — flatten symlink.
ln -sf "$APP_DIR/app/app.ts" "$APP_DIR/app.ts"

# 5. Install CLI wrapper
say "Linking CLI → $BIN_DIR/hypr-drawer"
install -Dm755 "$SCRIPT_DIR/bin/hypr-drawer" "$BIN_DIR/hypr-drawer"

# 6. Install hyprland snippet
say "Installing $DRAWER_CONF"
install -Dm644 "$SCRIPT_DIR/config/drawer.conf" "$DRAWER_CONF"

# 6b. Seed the managed keybind file so Hyprland's `source = ...drawer-bind.conf`
#     resolves on first load. The daemon rewrites this file whenever the user
#     changes the hotkey from the settings UI.
DRAWER_BIND_CONF="$HYPR_CONF_DIR/drawer-bind.conf"
if [ ! -f "$DRAWER_BIND_CONF" ]; then
    say "Seeding default keybind → $DRAWER_BIND_CONF"
    cat > "$DRAWER_BIND_CONF" <<EOF
# Managed by hypr-drawer — edit via the in-app settings, not here.
unbind = SUPER CTRL, R
bind = SUPER CTRL, R, exec, $BIN_DIR/hypr-drawer toggle
EOF
fi

# 7. Idempotently hook into hyprland.conf
touch "$HYPR_CONF"
if grep -Fxq "$SOURCE_LINE" "$HYPR_CONF"; then
    say "hyprland.conf already sources drawer.conf — skipping."
else
    say "Appending source line to $HYPR_CONF"
    {
        echo ""
        echo "# Added by hypr-drawer installer"
        echo "$SOURCE_LINE"
    } >> "$HYPR_CONF"
fi

# 8. Reload Hyprland if it's running
if pgrep -x Hyprland >/dev/null 2>&1; then
    say "Reloading Hyprland"
    hyprctl reload >/dev/null || warn "hyprctl reload failed — reload manually."
fi

# 9. PATH hint
if ! printf '%s' "$PATH" | tr ':' '\n' | grep -Fxq "$BIN_DIR"; then
    warn "$BIN_DIR is not on \$PATH. Add it to your shell rc:"
    warn "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# Report the keybind that is actually live, not the default. Step 6b leaves an
# existing drawer-bind.conf alone, so on a re-install the real hotkey may be
# whatever the daemon last wrote from the settings UI.
current_hotkey() {
    local line mods key
    line="$(grep -m1 -E '^[[:space:]]*bind[[:space:]]*=' "$DRAWER_BIND_CONF" 2>/dev/null || true)"
    if [ -z "$line" ]; then
        printf 'not set — see %s' "$DRAWER_BIND_CONF"
        return
    fi
    # `bind = SUPER CTRL, R, exec, …` → mods="SUPER CTRL", key="R"
    line="${line#*=}"
    mods="$(printf '%s' "$line" | cut -d, -f1 \
        | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/[[:space:]]\{1,\}/ + /g')"
    key="$(printf '%s' "$line" | cut -d, -f2 \
        | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    if [ -n "$mods" ]; then
        printf '%s + %s' "$mods" "$key"
    else
        printf '%s' "$key"
    fi
}

cat <<EOF

✓ hypr-drawer installed.

  Toggle:        $(current_hotkey)
                 (rebind from the drawer's settings page — the file it
                  writes is $DRAWER_BIND_CONF)
  ags version:   $(ags --version 2>&1 | head -1)
  State file:    $STATE_DIR/positions.json
  Uninstall:     $SCRIPT_DIR/uninstall.sh

EOF
