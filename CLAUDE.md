# hypr-drawer — project notes for Claude

## Stack
AGS v3 (Aylur's GTK Shell) + TypeScript + GTK4 + Astal layer-shell, targeting Hyprland. Entry point: `app/app.ts`. Bundle check: `ags bundle app/app.ts /tmp/out.js`.

## After every change — required checks

After editing any file in this repo, before reporting work as done:

1. **Bundle check** — `ags bundle app/app.ts /tmp/hypr-drawer-bundle.js`. Must exit 0.
2. **Hyprland config check** — if anything under `config/` changed, AND that file is installed (e.g., `~/.config/hypr/drawer.conf` is the deployed copy of `config/drawer.conf`), run:

   ```
   hyprctl configerrors
   ```

   Must report `no errors`. A single bad `layerrule`, `windowrule`, or `decoration` block will silently break the drawer overlay and is invisible in TypeScript bundling. Investigate any line/field flagged and fix at the source (`config/drawer.conf`), not in the installed copy.

3. If `config/drawer.conf` changed, the user must re-run `./install.sh` (or copy the file manually) for `hyprctl configerrors` to see the new content — flag this in the response.

## Layout
- `app/app.ts` — daemon: window lifecycle, Hyprland socket2 listener, special-workspace toggle logic.
- `app/widget/` — UI: `Launcher.tsx` (rail), `AppTile.tsx`, `Shade.ts` (per-monitor blur overlays).
- `app/service/` — `Hypr.ts` (hyprctl wrappers), `Settings.ts` (persisted prefs), `Memory.ts` (saved app geometry), `Spawn.ts` (drop-to-spawn pipeline), `Preview.ts`, `Hotkey.ts`, `Apps.ts`, `Layout.ts`.
- `config/drawer.conf` — Hyprland snippet sourced from `hyprland.conf`. Layerrules, windowrules, decoration.
- `install.sh` — copies app + config into `~/.local/share/hypr-drawer` and `~/.config/hypr/drawer.conf`, reloads Hyprland.

## Hyprland gotchas
- `togglespecialworkspace NAME` operates on the focused monitor; a named special workspace is **single-instance** — toggling it on monitor B can pull it off monitor A. Don't rely on iterating monitors to "open special on all". Use per-monitor shade overlays instead (see `Shade.ts`).
- `layerrule` valid actions include `blur on/off`, `noanim`, `xray`, etc. — not every Hyprland keyword works here. When in doubt, `hyprctl configerrors` is authoritative.
- Coordinates from `hyprctl clients` are in the global layout space; `movewindowpixel` interprets coords in the target monitor's local space. Translate by subtracting the monitor's `x`/`y` (see `Spawn.ts`).
