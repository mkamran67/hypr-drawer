-- hypr-drawer — required from hyprland.lua
--
-- The Lua counterpart of drawer.conf, used when Hyprland runs the Lua config
-- provider. Hyprland picks the provider by config file: hyprland.lua wins if
-- present, hyprland.conf is the legacy fallback, and a machine with neither
-- gets a generated hyprland.lua. install.sh detects which one applies and
-- installs this file or drawer.conf accordingly — never both.
--
-- @BIN@ is substituted with the install prefix's bin directory at install
-- time. Absolute paths matter here: Hyprland is often started with a minimal
-- PATH that does not include ~/.local/bin, which would silently break the
-- toggle with a "command not found" nothing surfaces.

local bin = "@BIN@/hypr-drawer"

-- Daemon: keeps the launcher widget warm and listens for `toggle` IPC.
-- `hyprland.start` fires once per compositor start, matching `exec-once`
-- rather than `exec` — a config reload must not spawn a second daemon.
hl.on("hyprland.start", function()
    hl.exec_cmd(bin .. " daemon")
end)

-- Keybind — managed by the in-app settings, which rewrites drawer-bind.lua
-- and applies the change live via `hyprctl eval`. Change it from the
-- drawer's settings page, not by editing that file.
require("drawer-bind")

-- All windows in any per-monitor drawer special float + are resizable.
-- Per-monitor specials are named `special:drawer-<connector>` (e.g.
-- `special:drawer-DP-1`), so we match by regex on the workspace name.
hl.window_rule({ match = { workspace = "r:^special:drawer-" }, float = true })

-- Blur the special workspace background so the drawer feels like an overlay.
--
-- Only `special` is set here, deliberately. drawer.conf also pins size,
-- passes, new_optimizations and xray, which overrides whatever blur the user
-- already configured — on CachyOS, decorations.lua sets size = 5, passes = 4
-- and this file is required after it. The drawer needs special-workspace
-- blur turned on; it has no business dictating the rest of the look.
hl.config({ decoration = { blur = { enabled = true, special = true } } })

-- Blur the launcher rail itself (layer-shell namespace = "hypr-drawer").
hl.layer_rule({ match = { namespace = "hypr-drawer" }, blur = true })

-- Blur the per-monitor shade overlays used by "blur all monitors" mode.
-- The shade windows are nearly transparent — the blur is what gives them
-- their visual effect.
hl.layer_rule({ match = { namespace = "hypr-drawer-shade" }, blur = true })
