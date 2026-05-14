#!/usr/bin/env bash
# Per-distro dependency installer for hypr-drawer.
# Sourced by install.sh; never run directly.
set -euo pipefail

# What we need at runtime:
#   - hyprctl  (provided by Hyprland itself)
#   - ags v3   (Aylur's Gtk Shell, v3 line — installed via Aylur's flake; only
#              source where v3.x is reliably available across distros)
#   - socat    (for reading Hyprland's socket2 event stream)
#   - jq       (handy for shell-side debugging; optional but installed)
#
# AGS v3 isn't yet in nixpkgs/AUR/COPR (those still ship v2.x), so we install
# it from `github:Aylur/ags#agsFull` via `nix profile install`. That means
# Nix is a hard requirement on every distro, including Arch/Fedora/Debian.

AGS_FLAKE_REF="${AGS_FLAKE_REF:-github:Aylur/ags#agsFull}"
NIX_FLAGS=(--extra-experimental-features "nix-command flakes")

detect_pm() {
    if command -v pacman    >/dev/null 2>&1; then echo pacman; return; fi
    if command -v apt-get   >/dev/null 2>&1; then echo apt;    return; fi
    if command -v dnf       >/dev/null 2>&1; then echo dnf;    return; fi
    if command -v zypper    >/dev/null 2>&1; then echo zypper; return; fi
    echo unknown
}

# Install socat + jq from the distro package manager. These two are stable
# across versions and don't need a flake.
install_socat_jq() {
    local pm
    pm="$(detect_pm)"
    echo "→ Detected package manager: $pm"
    case "$pm" in
        pacman)
            sudo pacman -S --needed --noconfirm socat jq
            ;;
        apt)
            sudo apt-get update
            sudo apt-get install -y socat jq
            ;;
        dnf)
            sudo dnf install -y socat jq
            ;;
        zypper)
            sudo zypper install -y socat jq
            ;;
        unknown)
            echo "!! Unknown package manager — install 'socat' and 'jq' manually."
            ;;
    esac
}

# Ensure nix CLI is present. We don't auto-install Nix because the official
# installer needs interactive confirmation and root; we just point the user.
require_nix() {
    if ! command -v nix >/dev/null 2>&1; then
        cat >&2 <<'EOF'
✗ `nix` is not installed.

hypr-drawer needs AGS v3, which is only reliably available via Aylur's
flake. That requires Nix on your system.

Install Nix (Determinate Systems installer — recommended for non-NixOS):

    curl --proto '=https' --tlsv1.2 -sSf -L \
        https://install.determinate.systems/nix | sh -s -- install

…or the upstream installer:

    sh <(curl -L https://nixos.org/nix/install) --daemon

Then re-run ./install.sh.
EOF
        return 1
    fi
}

# Install ags v3 (agsFull bundle: ags + astal4 + apps + hyprland modules)
# into the user's nix profile. Idempotent: if already at the requested rev,
# this is a no-op.
install_ags_v3() {
    echo "→ Installing AGS v3 from $AGS_FLAKE_REF (this can take a few minutes on first run)"
    # If a previous `ags` entry exists in the profile (commonly the v2 from
    # nixpkgs), it will collide on bin/ags. Try to remove it first; ignore
    # errors so a fresh profile (no entry) still proceeds.
    nix "${NIX_FLAGS[@]}" profile remove ags >/dev/null 2>&1 || true
    nix "${NIX_FLAGS[@]}" profile add "$AGS_FLAKE_REF"
}

verify_ags() {
    if ! command -v ags >/dev/null 2>&1; then
        echo "✗ ags not found on PATH after install." >&2
        echo "  Add ~/.nix-profile/bin to your PATH and re-run." >&2
        return 1
    fi
    local path version major
    path="$(command -v ags)"
    version="$(ags --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
    major="${version%%.*}"
    if [[ -z "$major" ]] || (( major < 3 )); then
        echo "✗ Found ags ${version:-unknown} at $path." >&2
        echo "  hypr-drawer requires AGS v3.x. The v2 line shipped by nixpkgs/" >&2
        echo "  AUR/COPR is not compatible. Make sure ~/.nix-profile/bin is" >&2
        echo "  ahead of any older 'ags' binary on PATH (often /usr/local/bin)." >&2
        return 1
    fi
    echo "→ Verified ags $version at $path"
}

install_deps() {
    install_socat_jq || echo "!! socat/jq step had issues — continuing."
    require_nix
    install_ags_v3
    verify_ags
}
