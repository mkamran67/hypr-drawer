import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { execAsync } from "ags/process"
import * as Settings from "./Settings"

// Hyprland sources the keybind from a tiny file we own:
//   ~/.config/hypr/drawer-bind.conf
// drawer.conf already has `source = …/drawer-bind.conf`, so updating this
// file + reloading Hyprland is enough to persist a hotkey change. At runtime
// we also call `hyprctl keyword` so the change is live without reload.

const CONF_DIR = `${GLib.get_user_config_dir()}/hypr`
const BIND_FILE = `${CONF_DIR}/drawer-bind.conf`

function toggleCmd(): string {
    // Absolute path — Hyprland's exec env doesn't have ~/.local/bin on PATH.
    return `${GLib.get_home_dir()}/.local/bin/hypr-drawer toggle`
}

function fileContent(combo: string): string {
    const cmd = toggleCmd()
    return [
        "# Managed by hypr-drawer — edit via the in-app settings, not here.",
        "# Rewritten whenever the user changes the toggle hotkey.",
        `unbind = ${combo}`,
        `bind = ${combo}, exec, ${cmd}`,
        "",
    ].join("\n")
}

function writeFile(combo: string): void {
    GLib.mkdir_with_parents(CONF_DIR, 0o755)
    const file = Gio.File.new_for_path(BIND_FILE)
    const data = new TextEncoder().encode(fileContent(combo))
    file.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null)
}

// Ensure the file exists on daemon start so a fresh install (or a settings
// dir wipe) doesn't leave Hyprland with a dangling `source =`.
export function ensureFile(): void {
    const file = Gio.File.new_for_path(BIND_FILE)
    if (file.query_exists(null)) return
    writeFile(Settings.hotkey())
}

// Swap the live keybind AND persist it. Old combo is unbound at runtime so
// it stops responding without needing a Hyprland reload.
export async function apply(oldCombo: string, newCombo: string): Promise<void> {
    Settings.setHotkey(newCombo)
    writeFile(newCombo)
    try {
        if (oldCombo && oldCombo !== newCombo) {
            await execAsync(`hyprctl keyword unbind ${oldCombo}`)
        }
        await execAsync(`hyprctl keyword bind ${newCombo}, exec, ${toggleCmd()}`)
    } catch (e) {
        console.error("Hotkey.apply:", e)
    }
}
