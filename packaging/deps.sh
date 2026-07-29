#!/usr/bin/env bash
# Per-distro dependency installer for hypr-drawer.
# Sourced by install.sh; never run directly.
set -euo pipefail

# What we need at runtime:
#   - hyprctl    (provided by Hyprland itself)
#   - ags v3     (Aylur's Gtk Shell, v3 line — v2 is API-incompatible)
#   - socat      (app.ts reads Hyprland's socket2 event stream through it)
#   - dart-sass  (app.ts does `import style from "./style.scss"`; ags shells
#                 out to `sass` to compile it)
#   - jq         (handy for shell-side debugging; optional but installed)
#
# AGS v3 packaging status (verified 2026-07):
#
#   Arch/AUR      aylurs-gtk-shell 3.1.2      → native, no Nix needed
#   Fedora/Terra  3.1.1 (F41), 3.1.2 (rawhide) → native if Terra is enabled
#   nixpkgs       2.3.0                        → too old, use Aylur's flake
#   Debian/Ubuntu not packaged                 → Nix required
#   openSUSE      not packaged                 → Nix required
#
# So Nix is a *fallback*, not a universal requirement. We try the distro's
# own packaging first and only fall back to `github:Aylur/ags#agsFull` where
# no v3 package exists. Set AGS_FORCE_NIX=1 to skip native packages entirely.

AGS_FLAKE_REF="${AGS_FLAKE_REF:-github:Aylur/ags#agsFull}"
AGS_FORCE_NIX="${AGS_FORCE_NIX:-0}"
NIX_FLAGS=(--extra-experimental-features "nix-command flakes")

# ---------------------------------------------------------------- detection

# Distro *family*, derived from /etc/os-release rather than from which binary
# happens to be on PATH. ID_LIKE is what makes derivatives work: CachyOS,
# EndeavourOS and Manjaro all report ID_LIKE=arch; Mint/Pop report debian.
detect_family() {
    local id="" id_like=""
    if [[ -r /etc/os-release ]]; then
        # shellcheck disable=SC1091
        id="$(. /etc/os-release && printf '%s' "${ID:-}")"
        id_like="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
    fi

    case " $id $id_like " in
        *" arch "*|*" archlinux "*|*" cachyos "*) echo arch;   return ;;
        *" debian "*|*" ubuntu "*)                echo debian; return ;;
        *" fedora "*|*" rhel "*|*" centos "*)     echo fedora; return ;;
        *" suse "*|*" opensuse "*)                echo suse;   return ;;
        *" nixos "*)                              echo nixos;  return ;;
    esac

    # os-release was missing or unrecognised — fall back to package managers.
    if command -v pacman  >/dev/null 2>&1; then echo arch;   return; fi
    if command -v apt-get >/dev/null 2>&1; then echo debian; return; fi
    if command -v dnf     >/dev/null 2>&1; then echo fedora; return; fi
    if command -v zypper  >/dev/null 2>&1; then echo suse;   return; fi
    echo unknown
}

# Pretty name for logging only.
distro_name() {
    if [[ -r /etc/os-release ]]; then
        # shellcheck disable=SC1091
        (. /etc/os-release && printf '%s' "${PRETTY_NAME:-${NAME:-unknown}}")
    else
        printf 'unknown'
    fi
}

aur_helper() {
    local h
    for h in paru yay pikaur trizen; do
        command -v "$h" >/dev/null 2>&1 && { echo "$h"; return 0; }
    done
    return 1
}

# ------------------------------------------------------------- base packages

# socat, jq and dart-sass. All three are stable across releases and packaged
# everywhere except dart-sass on Debian/Ubuntu (apt ships `sassc`, which is
# libsass — a different, unmaintained implementation that ags does not use).
install_base_deps() {
    local family="$1"
    case "$family" in
        arch)
            sudo pacman -S --needed --noconfirm socat jq dart-sass
            ;;
        debian)
            sudo apt-get update
            sudo apt-get install -y socat jq
            # No dart-sass in apt. The Nix agsFull bundle is the ags source
            # on this family anyway, and it carries its own sass.
            ;;
        fedora)
            sudo dnf install -y socat jq dart-sass || sudo dnf install -y socat jq
            ;;
        suse)
            sudo zypper install -y socat jq
            ;;
        nixos)
            echo "!! NixOS detected — add socat, jq and dart-sass to your"
            echo "   system or home-manager configuration; this script will"
            echo "   not mutate /etc/nixos."
            ;;
        *)
            echo "!! Unknown distro — install 'socat', 'jq' and 'dart-sass' manually."
            ;;
    esac
}

# ----------------------------------------------------------------- ags v3

# Arch: aylurs-gtk-shell is 3.x in the AUR, and mirrored by chaotic-aur.
# Prefer a configured binary repo (no compile), then an AUR helper.
install_ags_arch() {
    if pacman -Si aylurs-gtk-shell >/dev/null 2>&1; then
        echo "→ Installing ags v3 from a configured pacman repo"
        sudo pacman -S --needed --noconfirm aylurs-gtk-shell
        return 0
    fi

    local helper
    if helper="$(aur_helper)"; then
        echo "→ Installing ags v3 from the AUR via $helper"
        "$helper" -S --needed --noconfirm aylurs-gtk-shell
        return 0
    fi

    echo "!! No AUR helper (paru/yay) found and aylurs-gtk-shell is not in a" >&2
    echo "   configured repo. Install an AUR helper, or enable chaotic-aur." >&2
    return 1
}

# Fedora: Terra carries 3.x. Only usable if the user already enabled it —
# we don't add third-party repos behind the user's back.
install_ags_fedora() {
    if dnf list --available aylurs-gtk-shell >/dev/null 2>&1; then
        echo "→ Installing ags v3 from dnf (Terra or equivalent)"
        sudo dnf install -y aylurs-gtk-shell
        return 0
    fi
    echo "→ ags v3 not in a configured dnf repo (enable Terra: https://terra.fyralabs.com)"
    return 1
}

# Ensure nix CLI is present. We don't auto-install Nix because the official
# installer needs interactive confirmation and root; we just point the user.
require_nix() {
    if command -v nix >/dev/null 2>&1; then
        return 0
    fi
    cat >&2 <<'EOF'
✗ `nix` is not installed.

On this distro AGS v3 is not packaged, so hypr-drawer falls back to
Aylur's flake, which needs Nix.

Install Nix (Determinate Systems installer — recommended for non-NixOS):

    curl --proto '=https' --tlsv1.2 -sSf -L \
        https://install.determinate.systems/nix | sh -s -- install

…or the upstream installer:

    sh <(curl -L https://nixos.org/nix/install) --daemon

Then re-run ./install.sh.
EOF
    return 1
}

# Install ags v3 (agsFull bundle: ags + astal4 + apps + hyprland modules)
# into the user's nix profile. Idempotent: if already at the requested rev,
# this is a no-op.
install_ags_nix() {
    require_nix
    echo "→ Installing AGS v3 from $AGS_FLAKE_REF (can take a few minutes on first run)"
    # If a previous `ags` entry exists in the profile (commonly the v2 from
    # nixpkgs), it will collide on bin/ags. Try to remove it first; ignore
    # errors so a fresh profile (no entry) still proceeds.
    nix "${NIX_FLAGS[@]}" profile remove ags >/dev/null 2>&1 || true
    nix "${NIX_FLAGS[@]}" profile add "$AGS_FLAKE_REF"
}

# Try the distro's own v3 package, fall back to the flake.
install_ags_v3() {
    local family="$1"

    if [[ "$AGS_FORCE_NIX" == "1" ]]; then
        echo "→ AGS_FORCE_NIX=1 — skipping native packages"
        install_ags_nix
        return
    fi

    # Already have a v3? Nothing to do.
    if ags_major_at_least_3 2>/dev/null; then
        echo "→ ags v3 already present at $(command -v ags) — skipping install"
        return 0
    fi

    case "$family" in
        arch)   install_ags_arch   && return 0 ;;
        fedora) install_ags_fedora && return 0 ;;
        nixos)
            echo "!! NixOS detected — add Aylur's ags flake to your system or"
            echo "   home-manager configuration rather than using nix profile."
            echo "   Flake ref: $AGS_FLAKE_REF"
            return 1
            ;;
    esac

    echo "→ Falling back to Nix for ags v3"
    install_ags_nix
}

# ------------------------------------------------------------------ verify

ags_major_at_least_3() {
    command -v ags >/dev/null 2>&1 || return 1
    local version major
    version="$(ags --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    major="${version%%.*}"
    [[ -n "$major" ]] && (( major >= 3 ))
}

verify_ags() {
    if ! command -v ags >/dev/null 2>&1; then
        echo "✗ ags not found on PATH after install." >&2
        echo "  If it was installed via Nix, add ~/.nix-profile/bin to PATH." >&2
        return 1
    fi
    local path version
    path="$(command -v ags)"
    version="$(ags --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    if ! ags_major_at_least_3; then
        echo "✗ Found ags ${version:-unknown} at $path." >&2
        echo "  hypr-drawer requires AGS v3.x — the v2 line is API-incompatible." >&2
        echo "  nixpkgs still ships 2.3.0; make sure the v3 binary comes first" >&2
        echo "  on PATH (check /usr/local/bin and ~/.nix-profile/bin)." >&2
        return 1
    fi
    echo "→ Verified ags $version at $path"
}

# app.ts imports style.scss; ags invokes `sass` to compile it. Missing sass
# is a runtime failure at daemon start, not install time — so warn loudly.
verify_sass() {
    if command -v sass >/dev/null 2>&1; then
        echo "→ Verified sass at $(command -v sass)"
        return 0
    fi
    echo "!! 'sass' (dart-sass) not on PATH. app/style.scss cannot be compiled" >&2
    echo "   and the daemon will fail to start. Install dart-sass for your" >&2
    echo "   distro, or use the Nix-provided ags bundle which includes it." >&2
    return 0
}

install_deps() {
    local family
    family="$(detect_family)"
    echo "→ Detected: $(distro_name) (family: $family)"

    # install_deps is called as `install_deps || die`, which suspends errexit
    # for this whole call tree — so failures must be captured explicitly or
    # they get masked by the last command's (successful) status.
    install_base_deps "$family" || echo "!! base package step had issues — continuing."

    install_ags_v3 "$family" || return 1
    verify_ags                || return 1

    # Advisory only: a missing sass is a clear, actionable warning rather than
    # a hard stop, since the rest of the install is still worth completing.
    verify_sass
    return 0
}
