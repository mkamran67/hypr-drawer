#!/usr/bin/env bash
# Sandboxed tests for install.sh / uninstall.sh config hooking.
#
# Exercises the cases that broke real setups: a source line living somewhere
# other than hyprland.conf, a missing marker comment, config files that are
# symlinks into a dotfiles repo, and — the reason this file grew a second half
# — a Hyprland running the Lua config provider, where hyprland.conf is never
# read at all and the whole `source =` mechanism is inert.
#
# Everything happens under a temp dir; the real ~/.config/hypr is never
# touched. Each group seeds the config file that decides the provider rather
# than relying on an empty directory, so detection is deterministic.
#
# Requires SKIP_DEPS support in install.sh so no package manager is invoked.
#
# Usage: ./packaging/test-config-hook.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
H="$T/config/hypr"
FAILED=0

trap 'rm -rf "$T"' EXIT

run_i() {
    SKIP_DEPS=1 XDG_CONFIG_HOME="$T/config" XDG_STATE_HOME="$T/state" \
        PREFIX="$T/local" "$REPO/install.sh" >/dev/null 2>&1
}
run_u() {
    SKIP_DEPS=1 XDG_CONFIG_HOME="$T/config" XDG_STATE_HOME="$T/state" \
        PREFIX="$T/local" "$REPO/uninstall.sh" "$@" >/dev/null 2>&1
}
reset() { rm -rf "$T/config" "$T/state" "$T/local" "$T/real"; mkdir -p "$H"; }

# Seed the file that picks the provider. Hyprland prefers hyprland.lua when
# both exist, and only falls back to hyprland.conf when no .lua is present.
seed_legacy() { : > "$H/hyprland.conf"; }
seed_lua()    { printf -- '-- user config\n' > "$H/hyprland.lua"; }

group() { printf '\n\033[1m%s\033[0m\n' "$*"; }
chk() {
    if [ "$2" = "$3" ]; then
        printf '  \033[1;32mPASS\033[0m %s\n' "$1"
    else
        printf '  \033[1;31mFAIL\033[0m %s (got %s, want %s)\n' "$1" "'$2'" "'$3'"
        FAILED=1
    fi
}
exists() { test -e "$1" && echo yes || echo no; }
refs()   { grep -RlF 'drawer.conf' "$H" --include='*.conf' 2>/dev/null | wc -l; }
# `require("drawer-bind")` inside drawer.lua does not contain the exact string
# `require("drawer")`, so this counts only real hook lines.
lua_refs() { grep -RlF 'require("drawer")' "$H" --include='*.lua' 2>/dev/null | wc -l; }

group "syntax"
bash -n "$REPO/install.sh"   && chk "install.sh parses"   "$?" "0"
bash -n "$REPO/uninstall.sh" && chk "uninstall.sh parses" "$?" "0"

# ---------------------------------------------------------------------------
# Legacy (hyprlang) provider
# ---------------------------------------------------------------------------

group "legacy: baseline install / uninstall"
reset; seed_legacy; run_i
chk "exactly one source line" "$(grep -chF 'drawer.conf' "$H/hyprland.conf")" "1"
chk "drawer.conf installed"   "$(exists "$H/drawer.conf")" "yes"
chk "no lua files emitted"    "$(exists "$H/drawer.lua")" "no"
chk "legacy extract gesture seeded" "$(grep -cF 'SUPER ALT, mouse:272' "$H/drawer-bind.conf")" "3"
run_u
chk "no references remain"    "$(refs)" "0"
chk "drawer.conf removed"     "$(exists "$H/drawer.conf")" "no"
chk "state kept by default"   "$(exists "$T/state/hypr-drawer")" "yes"
chk "no residual blank lines" "$(wc -l < "$H/hyprland.conf")" "0"

group "legacy: source line relocated to userprefs.conf"
reset; seed_legacy; run_i
grep -F 'drawer.conf' "$H/hyprland.conf" > "$H/userprefs.conf"
sed -i '/drawer.conf/d; /Added by hypr-drawer/d' "$H/hyprland.conf"
run_i
chk "reinstall does not duplicate" \
    "$(grep -rhF 'source = ' "$H" --include='*.conf' | grep -cF 'drawer.conf')" "1"
run_u
chk "stripped from userprefs.conf" "$(grep -cF 'drawer.conf' "$H/userprefs.conf")" "0"

group "legacy: marker comment deleted, source line kept"
reset; seed_legacy; run_i
sed -i '/Added by hypr-drawer/d' "$H/hyprland.conf"
run_u
chk "stripped without the marker" "$(grep -cF 'drawer.conf' "$H/hyprland.conf")" "0"

group "legacy: config file is a symlink into a dotfiles repo"
reset; seed_legacy; run_i
mkdir -p "$T/real"
mv "$H/hyprland.conf" "$T/real/hyprland.conf"
ln -s "$T/real/hyprland.conf" "$H/hyprland.conf"
inode_before="$(stat -c %i "$T/real/hyprland.conf")"
run_u
chk "symlink survives"      "$(test -L "$H/hyprland.conf" && echo yes || echo no)" "yes"
chk "target inode unchanged" "$(stat -c %i "$T/real/hyprland.conf")" "$inode_before"
chk "source line stripped"   "$(grep -cF 'drawer.conf' "$T/real/hyprland.conf")" "0"
chk "drawer.conf removed"    "$(exists "$H/drawer.conf")" "no"

group "legacy: --purge"
reset; seed_legacy; run_i; run_u --purge
chk "state dir deleted" "$(exists "$T/state/hypr-drawer")" "no"

group "legacy: surviving reference blocks drawer.conf deletion"
reset; seed_legacy; run_i
echo "# see also: $H/drawer.conf" >> "$H/userprefs.conf"
run_u
chk "drawer.conf preserved" "$(exists "$H/drawer.conf")" "yes"

group "legacy: a marker comment that is not ours is preserved"
reset; seed_legacy; run_i
printf '# Added by hypr-drawer installer\nsource = /some/other/file.conf\n' >> "$H/userprefs.conf"
run_u
chk "unrelated source line kept" "$(grep -cF '/some/other/file.conf' "$H/userprefs.conf")" "1"
chk "orphan marker kept"         "$(grep -cF 'Added by hypr-drawer installer' "$H/userprefs.conf")" "1"

group "legacy: idempotence"
reset; seed_legacy; run_i; run_u
run_u
chk "second uninstall succeeds" "$?" "0"
run_i; run_i
chk "second install does not duplicate" \
    "$(grep -rhF 'source = ' "$H" --include='*.conf' | grep -cF 'drawer.conf')" "1"

# ---------------------------------------------------------------------------
# Lua provider
# ---------------------------------------------------------------------------

group "lua: baseline install / uninstall"
reset; seed_lua; run_i
chk "exactly one require line" "$(grep -chF 'require("drawer")' "$H/hyprland.lua")" "1"
chk "drawer.lua installed"     "$(exists "$H/drawer.lua")" "yes"
chk "drawer-bind.lua seeded"   "$(exists "$H/drawer-bind.lua")" "yes"
chk "lua extract gesture seeded" "$(grep -cF 'SUPER + ALT + mouse:272' "$H/drawer-bind.lua")" "3"
chk "no drawer.conf emitted"   "$(exists "$H/drawer.conf")" "no"
chk "user config preserved"    "$(grep -cF -- '-- user config' "$H/hyprland.lua")" "1"
run_u
chk "no require lines remain"  "$(lua_refs)" "0"
chk "drawer.lua removed"       "$(exists "$H/drawer.lua")" "no"
chk "drawer-bind.lua removed"  "$(exists "$H/drawer-bind.lua")" "no"
chk "user config still there"  "$(grep -cF -- '-- user config' "$H/hyprland.lua")" "1"

# The bug that started all this: install.sh unconditionally touched
# hyprland.conf. On a machine whose config is Lua (or which has no config yet
# and would generate one), an empty hyprland.conf is at best dead weight and
# at worst flips the user onto the legacy provider at next startup.
group "lua: installer does not create hyprland.conf"
reset; seed_lua; run_i
chk "hyprland.conf not created" "$(exists "$H/hyprland.conf")" "no"

group "lua: wins when both config files exist"
reset; seed_legacy; seed_lua; run_i
chk "hooked the lua config"    "$(grep -chF 'require("drawer")' "$H/hyprland.lua")" "1"
chk "conf left untouched"      "$(grep -cF 'drawer.conf' "$H/hyprland.conf")" "0"
chk "drawer.lua installed"     "$(exists "$H/drawer.lua")" "yes"

group "lua: hook relocated to another required file"
reset; seed_lua; run_i
grep -F 'require("drawer")' "$H/hyprland.lua" > "$H/userprefs.lua"
sed -i '/require("drawer")/d; /Added by hypr-drawer/d' "$H/hyprland.lua"
run_i
chk "reinstall does not duplicate" \
    "$(grep -rhF 'require("drawer")' "$H" --include='*.lua' | wc -l)" "1"
run_u
chk "stripped from userprefs.lua" "$(grep -cF 'require("drawer")' "$H/userprefs.lua")" "0"

group "lua: idempotence"
reset; seed_lua; run_i; run_u
run_u
chk "second uninstall succeeds" "$?" "0"
run_i; run_i
chk "second install does not duplicate" \
    "$(grep -rhF 'require("drawer")' "$H" --include='*.lua' | wc -l)" "1"

group "lua: existing drawer-bind.lua is not clobbered"
reset; seed_lua; run_i
printf 'hl.bind("SUPER + G", hl.dsp.exec_cmd("true"))\n' > "$H/drawer-bind.lua"
run_i
chk "user hotkey survives reinstall" "$(grep -cF 'SUPER + G' "$H/drawer-bind.lua")" "1"

group "lua: HYPR_PROVIDER override"
reset; seed_lua
HYPR_PROVIDER=legacy run_i
chk "forced legacy emits drawer.conf" "$(exists "$H/drawer.conf")" "yes"
chk "forced legacy skips drawer.lua"  "$(exists "$H/drawer.lua")" "no"
HYPR_PROVIDER=legacy run_u
reset; seed_legacy
HYPR_PROVIDER=lua run_i
chk "forced lua emits drawer.lua"     "$(exists "$H/drawer.lua")" "yes"
chk "forced lua skips drawer.conf"    "$(exists "$H/drawer.conf")" "no"

# The generated Lua has to actually parse. --verify-config runs the real
# parser without starting a compositor, so this catches a template typo that
# every string assertion above would happily pass.
group "lua: generated config parses"
if command -v Hyprland >/dev/null 2>&1; then
    reset; seed_lua; run_i
    verify_out="$(env HOME="$T" XDG_CONFIG_HOME="$T/config" \
        Hyprland --verify-config 2>&1)"
    chk "provider resolved to lua" \
        "$(printf '%s' "$verify_out" | grep -cF 'Using lua config found at')" "1"
    chk "config parses clean" \
        "$(printf '%s' "$verify_out" | grep -cF 'config ok')" "1"
else
    printf '  \033[1;33mSKIP\033[0m Hyprland binary not on PATH\n'
fi

if [ "$FAILED" = 0 ]; then
    printf '\n\033[1;32m✓ all config-hook tests passed\033[0m\n'
else
    printf '\n\033[1;31m✗ config-hook tests failed\033[0m\n'
fi
exit "$FAILED"
