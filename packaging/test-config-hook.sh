#!/usr/bin/env bash
# Sandboxed tests for install.sh / uninstall.sh config hooking.
#
# Exercises the cases that broke real setups: a source line living somewhere
# other than hyprland.conf, a missing marker comment, and config files that are
# symlinks into a dotfiles repo. Everything happens under a temp dir — the real
# ~/.config/hypr is never touched.
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
reset() { rm -rf "$T/config" "$T/state" "$T/local" "$T/real"; }

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

group "syntax"
bash -n "$REPO/install.sh"   && chk "install.sh parses"   "$?" "0"
bash -n "$REPO/uninstall.sh" && chk "uninstall.sh parses" "$?" "0"

group "baseline install / uninstall"
reset; run_i
chk "exactly one source line" "$(grep -chF 'drawer.conf' "$H/hyprland.conf")" "1"
chk "drawer.conf installed"   "$(exists "$H/drawer.conf")" "yes"
run_u
chk "no references remain"    "$(refs)" "0"
chk "drawer.conf removed"     "$(exists "$H/drawer.conf")" "no"
chk "state kept by default"   "$(exists "$T/state/hypr-drawer")" "yes"
chk "no residual blank lines" "$(wc -l < "$H/hyprland.conf")" "0"

group "source line relocated to userprefs.conf"
reset; run_i
grep -F 'drawer.conf' "$H/hyprland.conf" > "$H/userprefs.conf"
sed -i '/drawer.conf/d; /Added by hypr-drawer/d' "$H/hyprland.conf"
run_i
chk "reinstall does not duplicate" \
    "$(grep -rhF 'source = ' "$H" --include='*.conf' | grep -cF 'drawer.conf')" "1"
run_u
chk "stripped from userprefs.conf" "$(grep -cF 'drawer.conf' "$H/userprefs.conf")" "0"

group "marker comment deleted, source line kept"
reset; run_i
sed -i '/Added by hypr-drawer/d' "$H/hyprland.conf"
run_u
chk "stripped without the marker" "$(grep -cF 'drawer.conf' "$H/hyprland.conf")" "0"

group "config file is a symlink into a dotfiles repo"
reset; run_i
mkdir -p "$T/real"
mv "$H/hyprland.conf" "$T/real/hyprland.conf"
ln -s "$T/real/hyprland.conf" "$H/hyprland.conf"
inode_before="$(stat -c %i "$T/real/hyprland.conf")"
run_u
chk "symlink survives"      "$(test -L "$H/hyprland.conf" && echo yes || echo no)" "yes"
chk "target inode unchanged" "$(stat -c %i "$T/real/hyprland.conf")" "$inode_before"
chk "source line stripped"   "$(grep -cF 'drawer.conf' "$T/real/hyprland.conf")" "0"
chk "drawer.conf removed"    "$(exists "$H/drawer.conf")" "no"

group "--purge"
reset; run_i; run_u --purge
chk "state dir deleted" "$(exists "$T/state/hypr-drawer")" "no"

group "surviving reference blocks drawer.conf deletion"
reset; run_i
echo "# see also: $H/drawer.conf" >> "$H/userprefs.conf"
run_u
chk "drawer.conf preserved" "$(exists "$H/drawer.conf")" "yes"

group "a marker comment that is not ours is preserved"
reset; run_i
printf '# Added by hypr-drawer installer\nsource = /some/other/file.conf\n' >> "$H/userprefs.conf"
run_u
chk "unrelated source line kept" "$(grep -cF '/some/other/file.conf' "$H/userprefs.conf")" "1"
chk "orphan marker kept"         "$(grep -cF 'Added by hypr-drawer installer' "$H/userprefs.conf")" "1"

group "idempotence"
reset; run_i; run_u
run_u
chk "second uninstall succeeds" "$?" "0"
run_i; run_i
chk "second install does not duplicate" \
    "$(grep -rhF 'source = ' "$H" --include='*.conf' | grep -cF 'drawer.conf')" "1"

if [ "$FAILED" = 0 ]; then
    printf '\n\033[1;32m✓ all config-hook tests passed\033[0m\n'
else
    printf '\n\033[1;31m✗ config-hook tests failed\033[0m\n'
fi
exit "$FAILED"
