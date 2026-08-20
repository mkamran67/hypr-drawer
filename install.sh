#!/usr/bin/env bash
# hypr-drawer installer — user-level, idempotent, cross-distro.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${PREFIX:-$HOME/.local}"
APP_DIR="$PREFIX/share/hypr-drawer"
BIN_DIR="$PREFIX/bin"
HYPR_CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/hypr"
HYPR_CONF="$HYPR_CONF_DIR/hyprland.conf"
HYPR_LUA="$HYPR_CONF_DIR/hyprland.lua"
DRAWER_CONF="$HYPR_CONF_DIR/drawer.conf"
DRAWER_LUA="$HYPR_CONF_DIR/drawer.lua"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/hypr-drawer"
SOURCE_LINE="source = $DRAWER_CONF"
REQUIRE_LINE='require("drawer")'

say()  { printf '\033[1;36m::\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Sanity checks
command -v hyprctl >/dev/null 2>&1 \
    || die "hyprctl not found. Install Hyprland first: https://hyprland.org"

# 1b. Which config provider will Hyprland use for this config dir?
#
# Hyprland ships both parsers in one binary — the hyprlang one is namespaced
# `Config::Legacy` internally — so the version number cannot answer this. Only
# the config files can. Resolution order below mirrors Hyprland's own,
# confirmed against 0.56.2 with `--verify-config`:
#
#   hyprland.lua present   -> lua     (wins even when hyprland.conf exists)
#   only hyprland.conf     -> legacy
#   neither                -> whatever a fresh Hyprland would generate
#
# Getting this wrong is silent: the installer writes a perfectly valid config
# into a file the compositor never opens, and the hotkey simply does nothing.
detect_provider() {
    case "${HYPR_PROVIDER:-}" in
        lua|legacy) printf '%s' "$HYPR_PROVIDER"; return ;;
        "")         ;;
        *)          die "HYPR_PROVIDER must be 'lua' or 'legacy' (got '$HYPR_PROVIDER')" ;;
    esac

    [ -f "$HYPR_LUA" ]  && { printf 'lua';    return; }
    [ -f "$HYPR_CONF" ] && { printf 'legacy'; return; }

    # No config in this directory. A running compositor knows for certain.
    local live
    live="$(hyprctl systeminfo 2>/dev/null \
        | sed -n 's/^configProvider:[[:space:]]*\([a-z]*\).*/\1/p' | head -1)"
    case "$live" in
        lua|legacy) printf '%s' "$live"; return ;;
    esac

    # Nothing running either. Ask the binary what it would do with an empty
    # config dir, in a throwaway HOME so the answer cannot depend on — or
    # disturb — the real one. Hyprland versions predating the Lua provider
    # print no such line and correctly fall through to legacy.
    local probe result
    probe="$(mktemp -d)"
    mkdir -p "$probe/hypr"
    result=legacy
    if command -v Hyprland >/dev/null 2>&1 \
        && env HOME="$probe" XDG_CONFIG_HOME="$probe" Hyprland --verify-config 2>&1 \
            | grep -qF 'Using lua config found at'; then
        result=lua
    fi
    rm -rf "$probe"
    printf '%s' "$result"
}

PROVIDER="$(detect_provider)"
say "Hyprland config provider: $PROVIDER"

# 2. Install runtime deps
# SKIP_DEPS=1 bypasses the whole step. Needed to exercise the config-hooking
# logic in a sandbox (see the verification matrix in fix-plan.md) without sudo
# or network — install_deps shells out to the system package manager.
if [ "${SKIP_DEPS:-0}" != 1 ]; then
    say "Installing runtime dependencies"
    # shellcheck source=packaging/deps.sh
    source "$SCRIPT_DIR/packaging/deps.sh"
    # Fatal on purpose: without ags v3 the daemon cannot start, and continuing
    # would leave a keybind that fails silently with a "daemon failed to start".
    install_deps || die "Dependency step failed — review messages above and re-run."
else
    warn "SKIP_DEPS=1 — not installing or verifying runtime dependencies."
fi

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

# 6. Install the hyprland snippet for the detected provider, and only that
#    one — a stray drawer.conf next to a Lua config is dead weight that reads
#    like a working install.
if [ "$PROVIDER" = lua ]; then
    say "Installing $DRAWER_LUA"
    # @BIN@ carries the real prefix, so a non-default PREFIX still gets a
    # working absolute path rather than a hardcoded ~/.local/bin.
    sed "s|@BIN@|$BIN_DIR|g" "$SCRIPT_DIR/config/drawer.lua" > "$DRAWER_LUA"
    chmod 644 "$DRAWER_LUA"
    DRAWER_BIND_FILE="$HYPR_CONF_DIR/drawer-bind.lua"
    HOOK_FILE="$HYPR_LUA"
    HOOK_LINE="$REQUIRE_LINE"
    HOOK_GLOB='*.lua'
    HOOK_MARKER='-- Added by hypr-drawer installer'
    HOOK_DESC='drawer.lua is already required'
else
    say "Installing $DRAWER_CONF"
    install -Dm644 "$SCRIPT_DIR/config/drawer.conf" "$DRAWER_CONF"
    DRAWER_BIND_FILE="$HYPR_CONF_DIR/drawer-bind.conf"
    HOOK_FILE="$HYPR_CONF"
    HOOK_LINE="$SOURCE_LINE"
    HOOK_GLOB='*.conf'
    HOOK_MARKER='# Added by hypr-drawer installer'
    HOOK_DESC='drawer.conf is already sourced'
fi

# 6b. Seed the managed keybind file so the hook file's `source =` / `require`
#     resolves on first load. The daemon rewrites this file whenever the user
#     changes the hotkey from the settings UI, so an existing one is left
#     alone.
if [ ! -f "$DRAWER_BIND_FILE" ]; then
    say "Seeding default keybind → $DRAWER_BIND_FILE"
    if [ "$PROVIDER" = lua ]; then
        cat > "$DRAWER_BIND_FILE" <<EOF
-- Managed by hypr-drawer — edit via the in-app settings, not here.
hl.unbind("SUPER + CTRL + R")
hl.bind("SUPER + CTRL + R", hl.dsp.exec_cmd("$BIN_DIR/hypr-drawer toggle"))
hl.unbind("SUPER + ALT + mouse:272")
hl.bind("SUPER + ALT + mouse:272", hl.dsp.exec_cmd("$BIN_DIR/hypr-drawer extract"), { mouse = true })
hl.bind("SUPER + ALT + mouse:272", hl.dsp.window.drag(), { mouse = true })
EOF
    else
        cat > "$DRAWER_BIND_FILE" <<EOF
# Managed by hypr-drawer — edit via the in-app settings, not here.
unbind = SUPER CTRL, R
bind = SUPER CTRL, R, exec, $BIN_DIR/hypr-drawer toggle
unbind = SUPER ALT, mouse:272
bind = SUPER ALT, mouse:272, exec, $BIN_DIR/hypr-drawer extract
bindm = SUPER ALT, mouse:272, movewindow
EOF
    fi
fi

# 7. Idempotently hook into the hypr config
#
# Search every config file under the config dir, not just the top-level one.
# HyDE and most dotfile frameworks move user `source` lines into
# userprefs.conf, and a user who has done that would otherwise get a duplicate
# on every reinstall. uninstall.sh uses the same repo-wide search to remove
# them again.
#
# The hook file is never created if absent. Writing an empty hyprland.conf is
# what silently flipped Lua users onto the legacy provider; writing an empty
# hyprland.lua is worse still, because it suppresses the default config
# Hyprland would otherwise generate and leaves the user with a bare desktop.
if [ ! -f "$HOOK_FILE" ]; then
    warn "$HOOK_FILE does not exist — not creating it."
    warn "Start Hyprland once so it writes its config, then re-run this"
    warn "installer, or add this line to your config yourself:"
    warn "    $HOOK_LINE"
else
    # -R, not -r: plain -r skips symlinks found during recursion, and these
    # files are commonly symlinked in from a dotfiles repo. uninstall.sh
    # matches.
    existing_ref="$(grep -RlF "$HOOK_LINE" "$HYPR_CONF_DIR" --include="$HOOK_GLOB" 2>/dev/null || true)"
    if [ -n "$existing_ref" ]; then
        say "$HOOK_DESC — skipping. Referenced by:"
        while IFS= read -r f; do
            [ -n "$f" ] && say "    $f"
        done <<< "$existing_ref"
    else
        say "Appending hook line to $HOOK_FILE"
        {
            echo ""
            echo "$HOOK_MARKER"
            echo "$HOOK_LINE"
        } >> "$HOOK_FILE"
    fi
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
# existing bind file alone, so on a re-install the real hotkey may be whatever
# the daemon last wrote from the settings UI.
current_hotkey() {
    local line mods key
    if [ "$PROVIDER" = lua ]; then
        # `hl.bind("SUPER + CTRL + R", …)` → the first quoted argument is
        # already in display form, so print it as-is.
        line="$(sed -n 's/^[[:space:]]*hl\.bind([[:space:]]*"\([^"]*\)".*/\1/p' \
            "$DRAWER_BIND_FILE" 2>/dev/null | head -1)"
        if [ -z "$line" ]; then
            printf 'not set — see %s' "$DRAWER_BIND_FILE"
        else
            printf '%s' "$line"
        fi
        return
    fi
    line="$(grep -m1 -E '^[[:space:]]*bind[[:space:]]*=' "$DRAWER_BIND_FILE" 2>/dev/null || true)"
    if [ -z "$line" ]; then
        printf 'not set — see %s' "$DRAWER_BIND_FILE"
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

# Not guaranteed present: SKIP_DEPS installs skip the whole dependency step,
# and reporting "command not found" as a version is worse than saying so.
ags_version() {
    if command -v ags >/dev/null 2>&1; then
        ags --version 2>&1 | head -1
    else
        printf 'not installed'
    fi
}

cat <<EOF

✓ hypr-drawer installed.

  Toggle:        $(current_hotkey)
                 (rebind from the drawer's settings page — the file it
                  writes is $DRAWER_BIND_FILE)
  Config:        $PROVIDER provider, hooked into $HOOK_FILE
  ags version:   $(ags_version)
  State file:    $STATE_DIR/positions.json
  Uninstall:     $SCRIPT_DIR/uninstall.sh  (add --purge to also drop state)

EOF
