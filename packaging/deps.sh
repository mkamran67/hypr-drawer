#!/usr/bin/env bash
# Per-distro dependency installer for hypr-drawer.
# Sourced by install.sh; never run directly.
set -euo pipefail

# What we need at runtime:
#   - hyprctl  (provided by Hyprland itself)
#   - ags v2 (Astal) or v3 (ags 3.x)
#   - socat    (for reading Hyprland's socket2 event stream)
#   - jq       (handy for shell-side debugging; optional but installed)

detect_pm() {
    if command -v pacman    >/dev/null 2>&1; then echo pacman; return; fi
    if command -v apt-get   >/dev/null 2>&1; then echo apt;    return; fi
    if command -v dnf       >/dev/null 2>&1; then echo dnf;    return; fi
    if command -v zypper    >/dev/null 2>&1; then echo zypper; return; fi
    if command -v nix-env   >/dev/null 2>&1; then echo nix;    return; fi
    echo unknown
}

verify_ags() {
    if ! command -v ags >/dev/null 2>&1; then
        echo "✗ ags not found on PATH after dependency install." >&2
        return 1
    fi
    local path version major
    path="$(command -v ags)"
    version="$(ags --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    major="${version%%.*}"
    if [[ -z "$major" ]] || (( major < 2 )); then
        echo "✗ Found ags ${version:-unknown} at $path." >&2
        echo "  hypr-drawer needs AGS v2 (Astal) or v3 (ags 3.x)." >&2
        echo "  Remove the old binary (often /usr/local/bin/ags from a manual" >&2
        echo "  install) or put a newer ags ahead of it on PATH, then re-run." >&2
        return 1
    fi
    echo "→ Detected ags $version at $path"
}

install_deps() {
    local pm
    pm="$(detect_pm)"
    echo "→ Detected package manager: $pm"

    case "$pm" in
        pacman)
            sudo pacman -S --needed --noconfirm socat jq || true
            if ! command -v ags >/dev/null 2>&1; then
                if command -v paru >/dev/null 2>&1; then
                    paru -S --needed --noconfirm aylurs-gtk-shell-git
                elif command -v yay >/dev/null 2>&1; then
                    yay  -S --needed --noconfirm aylurs-gtk-shell-git
                else
                    echo "!! AGS not in official repos. Install an AUR helper (paru/yay) or"
                    echo "   build manually: https://github.com/Aylur/ags"
                    return 1
                fi
            fi
            ;;
        apt)
            sudo apt-get update
            sudo apt-get install -y socat jq
            if ! command -v ags >/dev/null 2>&1; then
                echo "!! AGS v2 has no official .deb. Options:"
                echo "   1. Install via Nix:  nix profile install nixpkgs#ags"
                echo "   2. Build from source: https://github.com/Aylur/ags#installation"
                return 1
            fi
            ;;
        dnf)
            sudo dnf install -y socat jq
            if ! command -v ags >/dev/null 2>&1; then
                sudo dnf copr enable -y errornointernet/packages || true
                sudo dnf install -y aylurs-gtk-shell || {
                    echo "!! COPR install failed. Try Nix or build from source."
                    return 1
                }
            fi
            ;;
        zypper)
            sudo zypper install -y socat jq
            if ! command -v ags >/dev/null 2>&1; then
                echo "!! No openSUSE pkg for AGS. Install via Nix or build from source."
                return 1
            fi
            ;;
        nix)
            nix-env -iA nixpkgs.ags nixpkgs.socat nixpkgs.jq
            ;;
        *)
            echo "!! Unknown package manager. Install these manually:"
            echo "     - ags (v2 Astal or v3)"
            echo "     - socat"
            echo "     - jq"
            return 1
            ;;
    esac

    verify_ags
}
