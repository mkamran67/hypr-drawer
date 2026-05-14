# hypr-drawer

A pop-up "drawer desktop" for [Hyprland](https://hyprland.org).

One keybind toggles a translucent, blurred overlay containing a searchable
app launcher on one side and a free-form floating space on the other. Drag an
app from the launcher into the space — it opens there, floating and
resizable. The same keybind hides the whole thing. Apps keep running; their
sizes and positions are remembered per app class.

It's a place to park "background" apps (Spotify, Discord, a notes window, a
chat client) without giving them real estate on your tiled workspaces.

## How it works

Under the hood it's a thin layer on top of Hyprland primitives:

- **Special workspaces** (`togglespecialworkspace`) provide the show/hide
  scratchpad behavior — Hyprland already remembers windows in there.
- **`windowrulev2 = float, workspace:special:drawer`** keeps every window in
  the drawer floating.
- **Blur** is enabled for the special workspace via `decoration { blur { special = true } }`.
- A small **GTK4 layer-shell daemon** (built with [AGS v2 / Astal](https://github.com/Aylur/ags))
  draws the launcher rail and handles drag-and-drop.
- **Geometry** is persisted to `~/.local/state/hypr-drawer/positions.json` keyed
  by window class.

## Install

Requires **AGS v2 (Astal)** or **AGS v3 (ags 3.x)**. If a stray v1 `ags`
exists at `/usr/local/bin/ags` (from an older manual install), remove it or
put a newer ags earlier on PATH first — the installer will refuse to proceed
otherwise.

```bash
git clone <this-repo> hypr-drawer
cd hypr-drawer
./install.sh
```

The installer:

1. Detects your distro (`pacman` / `apt` / `dnf` / `zypper` / `nix`).
2. Installs runtime deps (`ags`, `socat`, `jq`) and verifies the `ags`
   version on PATH is ≥ 2.x.
3. Drops `~/.config/hypr/drawer.conf` and adds **one** `source = …` line to
   `hyprland.conf` (idempotent — safe to re-run).
4. Installs the daemon to `~/.local/share/hypr-drawer` and a CLI wrapper to
   `~/.local/bin/hypr-drawer`.
5. Runs `hyprctl reload`.

User-level only. The only `sudo` is whatever your package manager needs for
runtime deps.

### Notes per distro

- **Arch**: AGS comes from the AUR (`aylurs-gtk-shell-git`). Installer uses
  `paru`/`yay` if present; otherwise tells you how to build it.
- **Fedora**: AGS via COPR `errornointernet/packages`.
- **Debian/Ubuntu/openSUSE**: no official AGS package. Use Nix
  (`nix profile install nixpkgs#ags`) or build from source.
- **NixOS**: just `nix-env -iA nixpkgs.ags`.

## Usage

| Action | Result |
|---|---|
| `SUPER + HOME` | Toggle the drawer (open or hide). |
| Type in search bar | Fuzzy filter apps by name. |
| **Drag** an app tile onto the workspace | If that app is already running on any workspace, **moves** that window into the drawer. Otherwise launches a new instance. |
| **Shift+Drag** (or Ctrl+Drag) | Always launches a new instance into the drawer. |
| Click an app tile | Same as plain drag: move-if-running, otherwise launch. |
| Resize/move a window inside the drawer | Geometry is saved per class — same app reopens at the same spot. |
| `SUPER + HOME` again | Hides the drawer. Apps keep running in the background. |

## Rebind

Edit `~/.config/hypr/drawer.conf` and change the `bind = …` line.

## State

`~/.local/state/hypr-drawer/positions.json` — one entry per window class:

```json
{
  "spotify":  { "x": 120, "y": 80, "w": 1400, "h": 900 },
  "discord":  { "x": 200, "y": 120, "w": 1200, "h": 800 }
}
```

Delete an entry to forget a window's position; delete the file to forget
everything.

## Uninstall

```bash
./uninstall.sh
```

Removes the source line from `hyprland.conf`, the snippet, the binary, and the
app directory. Prompts before deleting saved positions.

## CLI

```
hypr-drawer toggle   # open or close
hypr-drawer show
hypr-drawer hide
hypr-drawer daemon   # explicit daemon start (started via exec-once normally)
hypr-drawer quit
```

## Troubleshooting

- **Nothing happens on keybind.** Check `pgrep -af 'ags.*hypr-drawer'`. If
  empty, look at `~/.local/state/hypr-drawer/daemon.log` for the last failed
  start, or run `hypr-drawer daemon` in a terminal to see errors live.
- **Drawer opens but no blur.** Confirm `decoration { blur { enabled = true } }`
  isn't overridden later in your config.
- **Drag does nothing.** Make sure `socat` is installed — the event watcher
  needs it to talk to Hyprland's socket2.
- **App opens but on the wrong workspace.** Some apps set `StartupWMClass`
  oddly; positions are keyed by lowercased class. Check `hyprctl clients` to
  see the real class and rename the entry in `positions.json`.

## Project layout

```
hypr-drawer/
├── install.sh / uninstall.sh
├── bin/hypr-drawer            # CLI wrapper
├── config/drawer.conf         # hyprland.conf snippet
├── packaging/deps.sh          # per-distro dep installer
└── app/                       # AGS v2 daemon (TypeScript)
    ├── app.ts                 # entrypoint + IPC + event loop
    ├── style.scss
    ├── service/{Apps,Hypr,Memory}.ts
    └── widget/{Launcher,AppTile,DropZone}.tsx
```
