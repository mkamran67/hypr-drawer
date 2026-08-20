export type ShortcutProvider = "legacy" | "lua"

export const EXTRACT_COMBO = "SUPER ALT, mouse:272"

export function luaCombo(combo: string): string {
    const [mods = "", key = ""] = combo.split(",")
    return [...mods.trim().split(/\s+/), key.trim()].filter(Boolean).join(" + ")
}

export function shortcutFileContent(
    provider: ShortcutProvider,
    toggleCombo: string,
    bin: string,
): string {
    const toggleCmd = `${bin} toggle`
    const extractCmd = `${bin} extract`
    if (provider === "lua") {
        const toggle = luaCombo(toggleCombo)
        const extract = luaCombo(EXTRACT_COMBO)
        return [
            "-- Managed by hypr-drawer - edit via the in-app settings, not here.",
            "-- Rewritten whenever the user changes the toggle hotkey.",
            `hl.unbind("${toggle}")`,
            `hl.bind("${toggle}", hl.dsp.exec_cmd("${toggleCmd}"))`,
            `hl.unbind("${extract}")`,
            `hl.bind("${extract}", hl.dsp.exec_cmd("${extractCmd}"), { mouse = true })`,
            `hl.bind("${extract}", hl.dsp.window.drag(), { mouse = true })`,
            "",
        ].join("\n")
    }
    return [
        "# Managed by hypr-drawer - edit via the in-app settings, not here.",
        "# Rewritten whenever the user changes the toggle hotkey.",
        `unbind = ${toggleCombo}`,
        `bind = ${toggleCombo}, exec, ${toggleCmd}`,
        `unbind = ${EXTRACT_COMBO}`,
        `bind = ${EXTRACT_COMBO}, exec, ${extractCmd}`,
        `bindm = ${EXTRACT_COMBO}, movewindow`,
        "",
    ].join("\n")
}

// --- display layer ----------------------------------------------------------
// Everything above serializes for Hyprland; everything below renders for the
// human reading the drawer's shortcut tooltip.

const MOD_NAMES: Record<string, string> = {
    SUPER: "Super",
    CTRL: "Ctrl",
    CONTROL: "Ctrl",
    ALT: "Alt",
    SHIFT: "Shift",
    META: "Meta",
}

// Hyprland spells mouse buttons by their evdev code. 272 is BTN_LEFT, and
// every combo we bind it in is a drag, so that is what the tooltip says.
const MOUSE_NAMES: Record<string, string> = {
    "mouse:272": "drag",
    "mouse:273": "right-drag",
    "mouse:274": "middle-drag",
}

// "SUPER CTRL, R" -> "Super + Ctrl + R". The stored spelling is Hyprland's;
// it only becomes title case at the point it is shown.
export function humanCombo(combo: string): string {
    if (!combo.trim()) return "not set"
    const [mods = "", key = ""] = combo.split(",")
    const parts = mods
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((m) => MOD_NAMES[m.toUpperCase()] ?? m)
    const k = key.trim()
    if (k) parts.push(MOUSE_NAMES[k.toLowerCase()] ?? k)
    return parts.join(" + ")
}

export type ShortcutRow = { keys: string; action: string }

// The drawer's full shortcut list, with the user's live toggle hotkey first
// because it is the one they are most likely to have forgotten. Mouse-only
// gestures are included: from the user's side they are shortcuts too.
export function shortcutHelp(toggleCombo: string): ShortcutRow[] {
    return [
        { keys: humanCombo(toggleCombo), action: "toggle the drawer" },
        { keys: "Esc", action: "close the drawer" },
        { keys: "Enter", action: "launch the top search result" },
        { keys: "Click a tile", action: "launch, or pull a running window in" },
        { keys: "Drag a tile out", action: "place the window where you drop it" },
        { keys: "Shift + drag", action: "force a new instance" },
        { keys: humanCombo(EXTRACT_COMBO), action: "pull a window back out of the drawer" },
        { keys: "Click the star", action: "toggle favorite" },
    ]
}

export function shortcutTooltip(toggleCombo: string): string {
    return shortcutHelp(toggleCombo)
        .map((r) => `${r.keys} - ${r.action}`)
        .join("\n")
}
