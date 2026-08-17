import GLib from "gi://GLib"
import Gio from "gi://Gio"
import type { Provider } from "./Dispatch"

// Which config provider the running Hyprland uses. This decides far more than
// which file the keybind lives in: under the Lua provider both
// `hyprctl keyword` and `hyprctl dispatch` take Lua rather than the legacy
// syntax, so nearly every compositor call the daemon makes has two spellings.
//
// Detected once and cached — the compositor cannot switch providers without
// restarting, which takes the daemon down with it.

const CONF_DIR = `${GLib.get_user_config_dir()}/hypr`

let cached: Provider | null = null

function detect(): Provider {
    // A running compositor is authoritative, and the daemon always has one.
    try {
        const [ok, stdout] = GLib.spawn_command_line_sync("hyprctl systeminfo")
        if (ok && stdout) {
            const text = new TextDecoder().decode(stdout)
            const found = /^configProvider:\s*(\w+)/m.exec(text)?.[1]
            if (found === "lua" || found === "legacy") return found
        }
    } catch (e) {
        console.error("Provider.detect:", e)
    }
    // Fall back to the same file-based rule install.sh uses: Hyprland prefers
    // hyprland.lua whenever it exists, whatever hyprland.conf says.
    const lua = Gio.File.new_for_path(`${CONF_DIR}/hyprland.lua`)
    return lua.query_exists(null) ? "lua" : "legacy"
}

export function provider(): Provider {
    return (cached ??= detect())
}

export function configDir(): string {
    return CONF_DIR
}
