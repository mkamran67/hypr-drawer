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
