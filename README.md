# hypr-drawer

A pop-up "drawer desktop" for [Hyprland](https://hyprland.org).

One keybind toggles a translucent, blurred overlay containing a searchable
app launcher on one side and a free-form floating space on the other. Drag an
app from the launcher into the space — it opens there, floating and
resizable. The same keybind hides the whole thing. Apps keep running; their
sizes and positions are remembered per app class.

It's a place to park "background" apps (Spotify, Discord, a notes window, a
chat client) without giving them real estate on your tiled workspaces.

> ⚠️ **Status: experimental.** This is a personal project that's usable but
> rough. The blur overlay can flicker during monitor transitions, some UI
> polish is missing, and edge cases around multi-monitor focus can leave the
> drawer in a weird state. See the latest commit messages for current known
> issues. PRs and bug reports welcome.

## How it works

Under the hood it's a thin layer on top of Hyprland primitives:

- **Special workspace** (`togglespecialworkspace`) provides the show/hide
  scratchpad behavior — Hyprland already remembers windows in there.
- **`windowrule = float, workspace:special:drawer`** keeps every window in
  the drawer floating.
- **Per-monitor blur shades**: a named special workspace is single-instance
  in Hyprland (toggling it on one monitor pulls it off the others), so
  instead of relying on `decoration { blur { special = true } }` alone, the
  daemon paints a transparent GTK4 layer-shell overlay on every monitor and
  uses `layerrule = blur` to get a consistent blurred backdrop everywhere.
- A **GTK4 layer-shell daemon** (built with [AGS v3 / Astal](https://github.com/Aylur/ags))
  draws the launcher rail, settings panel, and handles drag-and-drop.
- **Geometry** is persisted to `~/.local/state/hypr-drawer/positions.json` keyed
  by window class. App usage frequency is tracked separately for ranking.

## Requirements

- **Hyprland** (any recent version).
- **Nix** with flakes enabled. The installer pulls AGS v3 from
  [Aylur's flake](https://github.com/Aylur/ags) — the only source where v3
  is reliably packaged today. Nixpkgs / AUR / COPR all still ship the v2
  line which has an incompatible API.
- `socat` and `jq` (installed by your distro's package manager).
- ~600 MB of disk for the first Nix install (cached after that).

If you don't have Nix yet, install it first:

```bash
# Determinate Systems installer (recommended for non-NixOS):
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install

# …or the upstream multi-user installer:
sh <(curl -L https://nixos.org/nix/install) --daemon
```

Make sure `~/.nix-profile/bin` is on your `PATH` (the Nix installer normally
adds this to your shell rc; open a new shell after installing).

## Install

```bash
git clone <this-repo> hypr-drawer
cd hypr-drawer
./install.sh
```

The installer:

1. Installs `socat` and `jq` via your distro PM (`pacman`/`apt`/`dnf`/`zypper`).
2. Installs **AGS v3** into your Nix profile from
   `github:Aylur/ags#agsFull` (bundles ags, astal4/GTK4, the apps service,
   the Hyprland module). Idempotent: re-running upgrades in place.
3. Verifies `ags --version` ≥ 3.x.
4. Drops `~/.config/hypr/drawer.conf` and adds **one** `source = …` line to
   `hyprland.conf` (idempotent — safe to re-run).
5. Installs the daemon to `~/.local/share/hypr-drawer` and a CLI wrapper to
   `~/.local/bin/hypr-drawer`.
6. Runs `hyprctl reload`.

User-level only. The only `sudo` is whatever your package manager needs for
`socat`/`jq`. Everything else lands under `~/.nix-profile` and `~/.local`.

### Why Nix even on Arch/Fedora?

AGS v3 isn't in any distro repo yet. Aylur's flake is currently the only
place that ships v3 with all the Astal-4.0 (GTK4) typelibs wired up.
Once it lands in nixpkgs/AUR/COPR we'll switch to using those.

## Usage

| Action | Result |
|---|---|
| `SUPER + CTRL + R` (default) | Toggle the drawer (open or hide). |
| Type in search bar | Fuzzy filter apps by name; ranked by usage frequency. |
| **Drag** an app tile onto the workspace | If that app is already running on any workspace, **moves** that window into the drawer. Otherwise launches a new instance at the drop point. |
| **Shift+Drag** (or Ctrl+Drag) | Always launches a new instance into the drawer. |
| Click an app tile | Same as plain drag: move-if-running, otherwise launch. |
| Resize/move a window inside the drawer | Geometry is saved per class — same app reopens at the same spot. |
| Open the settings panel | Edit the toggle shortcut, tweak preferences. |
| `SUPER + CTRL + R` again | Hides the drawer. Apps keep running in the background. |

## Rebind

Two options:

- **In-app**: open the drawer, click the settings cog, and use the keyboard
  shortcut editor (supports F13–F24 and other extended keys).
- **By hand**: edit `~/.config/hypr/drawer.conf` and change the `bind = …`
  line, then `hyprctl reload`.

## State

`~/.local/state/hypr-drawer/positions.json` — one entry per window class:

```json
{
  "spotify":  { "x": 120, "y": 80, "w": 1400, "h": 900 },
  "discord":  { "x": 200, "y": 120, "w": 1200, "h": 800 }
}
```

Delete an entry to forget a window's position; delete the file to forget
everything. Settings and usage stats are stored alongside in the same
`~/.local/state/hypr-drawer/` directory.

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
- **Drawer opens but no blur, or blur flickers.** Confirm
  `decoration { blur { enabled = true } }` isn't overridden later in your
  config. The per-monitor shade relies on the `layerrule = blur, drawer-shade`
  line from `drawer.conf` — run `hyprctl configerrors` and re-run
  `./install.sh` if you edited the snippet.
- **Drag does nothing.** Make sure `socat` is installed — the event watcher
  needs it to talk to Hyprland's socket2.
- **App opens but on the wrong monitor.** `hyprctl clients` coordinates are
  in global layout space; the daemon translates to local monitor space when
  placing windows. If something still lands wrong, check
  `~/.local/state/hypr-drawer/daemon.log` for the computed coordinates.
- **App opens but on the wrong workspace.** Some apps set `StartupWMClass`
  oddly; positions are keyed by lowercased class. Check `hyprctl clients` to
  see the real class and rename the entry in `positions.json`.

## Project layout

```
hypr-drawer/
├── install.sh / uninstall.sh
├── bin/hypr-drawer            # CLI wrapper
├── config/drawer.conf         # hyprland.conf snippet (layerrules, windowrules, blur)
├── packaging/deps.sh          # per-distro dep installer
└── app/                       # AGS v3 daemon (TypeScript)
    ├── app.ts                 # entrypoint, IPC, Hyprland socket2 loop
    ├── style.scss
    ├── service/
    │   ├── Apps.ts            # .desktop discovery
    │   ├── DragState.ts       # in-flight drag bookkeeping
    │   ├── Hotkey.ts          # keybind capture / serialization
    │   ├── Hypr.ts            # hyprctl wrappers
    │   ├── Layout.ts          # window placement math
    │   ├── Memory.ts          # per-class geometry persistence
    │   ├── Preview.ts         # drop-zone preview
    │   ├── Settings.ts        # user preferences
    │   ├── Spawn.ts           # launch / move-into-drawer pipeline
    │   └── Usage.ts           # frequency tracking for ranking
    └── widget/
        ├── AppTile.tsx        # launcher tile + drag source
        ├── Launcher.tsx       # rail, search, settings panel
        └── Shade.ts           # per-monitor blurred backdrop
```
