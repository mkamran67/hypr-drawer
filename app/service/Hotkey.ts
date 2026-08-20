import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"
import * as Settings from "./Settings"
import { provider } from "./Provider"
import { EXTRACT_COMBO, luaCombo, shortcutFileContent } from "./Shortcuts"

// Hyprland reads the keybind from a tiny file we own, and which file that is
// depends on the config provider the compositor is running:
//
//   legacy (hyprlang)  ~/.config/hypr/drawer-bind.conf   sourced by drawer.conf
//   lua                ~/.config/hypr/drawer-bind.lua    required by drawer.lua
//
// install.sh installs exactly one of the two pairs. Updating the file plus
// reloading Hyprland is enough to persist a hotkey change; at runtime we also
// push the change live so it takes effect without a reload. The live call
// differs per provider too — `hyprctl keyword` is rejected outright under the
// Lua parser with "keyword can't work with non-legacy parsers. Use eval."

const CONF_DIR = `${GLib.get_user_config_dir()}/hypr`

function bindFile(): string {
    return `${CONF_DIR}/drawer-bind.${provider() === "lua" ? "lua" : "conf"}`
}

function toggleCmd(): string {
    // Absolute path — Hyprland's exec env doesn't have ~/.local/bin on PATH.
    return `${GLib.get_home_dir()}/.local/bin/hypr-drawer toggle`
}

function binPath(): string {
    return `${GLib.get_home_dir()}/.local/bin/hypr-drawer`
}

// Settings stores the hyprlang spelling, `SUPER CTRL, R`. Lua wants the mods
// and the key in one plus-separated string, `SUPER + CTRL + R`. Converting at
// the boundary keeps one canonical format on disk, so an existing
// settings.json survives a move between providers untouched.
function fileContent(combo: string): string {
    return shortcutFileContent(provider(), combo, binPath())
}

function writeFile(combo: string): void {
    GLib.mkdir_with_parents(CONF_DIR, 0o755)
    const file = Gio.File.new_for_path(bindFile())
    const data = new TextEncoder().encode(fileContent(combo))
    file.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null)
}

// Ensure the file exists on daemon start so a fresh install (or a settings
// dir wipe) doesn't leave Hyprland with a dangling `source =` / `require`.
export function ensureFile(): void {
    // Rewrite our managed file on startup so upgrades can add new drawer
    // gestures without requiring the user to delete their existing bind file.
    writeFile(Settings.hotkey())
    applyExtractionLive().catch((e) => console.error("Hotkey.ensureFile:", e))
}

async function applyExtractionLive(): Promise<void> {
    if (provider() === "lua") {
        const extract = luaCombo(EXTRACT_COMBO)
        await execAsync(["hyprctl", "eval", `hl.unbind("${extract}")`])
        await execAsync([
            "hyprctl", "eval",
            `hl.bind("${extract}", hl.dsp.exec_cmd("${binPath()} extract"), { mouse = true })`,
        ])
        await execAsync([
            "hyprctl", "eval",
            `hl.bind("${extract}", hl.dsp.window.drag(), { mouse = true })`,
        ])
        return
    }
    await execAsync(`hyprctl keyword unbind ${EXTRACT_COMBO}`)
    await execAsync(`hyprctl keyword bind ${EXTRACT_COMBO}, exec, ${binPath()} extract`)
    await execAsync(`hyprctl keyword bindm ${EXTRACT_COMBO}, movewindow`)
}

// Swap the live keybind AND persist it. Old combo is unbound at runtime so
// it stops responding without needing a Hyprland reload. We also unbind the
// *new* combo first — binding appends rather than replaces, so without this
// any leftover bind from the config file would coexist with our new runtime
// bind and the toggle would fire twice per keypress.
//
// The argv array form of execAsync goes straight to Gio.Subprocess without a
// shell, which matters for the Lua calls: the snippets carry quotes, parens
// and a path, none of which we want re-parsed.
export async function apply(oldCombo: string, newCombo: string): Promise<void> {
    Settings.setHotkey(newCombo)
    writeFile(newCombo)

    const stale = oldCombo && oldCombo !== newCombo ? oldCombo : ""
    try {
        if (provider() === "lua") {
            if (stale) {
                await execAsync(["hyprctl", "eval", `hl.unbind("${luaCombo(stale)}")`])
            }
            await execAsync(["hyprctl", "eval", `hl.unbind("${luaCombo(newCombo)}")`])
            await execAsync([
                "hyprctl",
                "eval",
                `hl.bind("${luaCombo(newCombo)}", hl.dsp.exec_cmd("${toggleCmd()}"))`,
            ])
        } else {
            if (stale) {
                await execAsync(`hyprctl keyword unbind ${stale}`)
            }
            await execAsync(`hyprctl keyword unbind ${newCombo}`)
            await execAsync(`hyprctl keyword bind ${newCombo}, exec, ${toggleCmd()}`)
        }
        await applyExtractionLive()
    } catch (e) {
        console.error("Hotkey.apply:", e)
    }
}
