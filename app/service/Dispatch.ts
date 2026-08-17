// Serializing compositor actions for both Hyprland config providers.
//
// Hyprland reads `hyprctl dispatch` through whichever config parser is
// active. Under the Lua provider the argument is wrapped as
// `return hl.dispatch(<arg>)` and parsed as Lua, so a legacy dispatcher
// string is a syntax error rather than a command:
//
//   $ hyprctl dispatch togglespecialworkspace drawer-DP-2
//   error: [string "return hl.dispatch(togglespecialworkspace dra..."]:1:
//   ')' expected near 'drawer'
//
// Modelling each action as data and serializing it per provider keeps the two
// spellings side by side and unit-testable without a compositor. This module
// deliberately imports nothing from gi:// so `packaging/test-dispatch.ts` can
// run it under plain node.

export type Provider = "lua" | "legacy"

export type Action =
    | { kind: "focusMonitor"; monitor: string }
    // Bare workspace name, without the "special:" prefix — that is what
    // togglespecialworkspace and toggle_special both expect.
    | { kind: "toggleSpecial"; workspace: string }
    // `workspace` is a name or a numeric id; both go out as a Lua string,
    // which Hyprland accepts for either.
    | { kind: "moveToWorkspaceSilent"; workspace: string; address: string }
    | { kind: "setFloating"; address: string }
    | { kind: "resizeExact"; w: number; h: number; address: string }
    | { kind: "moveExact"; x: number; y: number; address: string }
    | { kind: "moveToMonitor"; monitor: string; address: string }
    // `workspace` is the full name including "special:"; the serializer adds
    // the silent/float rules.
    | { kind: "spawnWithRules"; exec: string; workspace: string }
    // Spawn floating on the current workspace, no workspace rule.
    | { kind: "spawnFloating"; exec: string }

// A .desktop Exec line is arbitrary user data and routinely contains quotes.
// Interpolated raw into a Lua string it would close the literal early, which
// at best breaks the spawn and at worst injects Lua into the compositor.
function luaStr(s: string): string {
    const escaped = s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")
    return `"${escaped}"`
}

function win(address: string): string {
    return `window = ${luaStr(`address:${address}`)}`
}

export function serialize(a: Action, provider: Provider): string {
    if (provider === "lua") {
        switch (a.kind) {
            case "focusMonitor":
                return `hl.dsp.focus({ monitor = ${luaStr(a.monitor)} })`
            case "toggleSpecial":
                return `hl.dsp.workspace.toggle_special(${luaStr(a.workspace)})`
            case "moveToWorkspaceSilent":
                return `hl.dsp.window.move({ workspace = ${luaStr(a.workspace)}, silent = true, ${win(a.address)} })`
            case "setFloating":
                return `hl.dsp.window.float({ action = "enable", ${win(a.address)} })`
            case "resizeExact":
                return `hl.dsp.window.resize({ exact = true, x = ${a.w}, y = ${a.h}, ${win(a.address)} })`
            case "moveExact":
                return `hl.dsp.window.move({ exact = true, x = ${a.x}, y = ${a.y}, ${win(a.address)} })`
            case "moveToMonitor":
                return `hl.dsp.window.move({ monitor = ${luaStr(a.monitor)}, ${win(a.address)} })`
            case "spawnWithRules":
                return `hl.dsp.exec_cmd(${luaStr(a.exec)}, { workspace = ${luaStr(`${a.workspace} silent`)}, float = true })`
            case "spawnFloating":
                return `hl.dsp.exec_cmd(${luaStr(a.exec)}, { float = true })`
        }
    }
    switch (a.kind) {
        case "focusMonitor":
            return `focusmonitor ${a.monitor}`
        case "toggleSpecial":
            return `togglespecialworkspace ${a.workspace}`
        case "moveToWorkspaceSilent":
            return `movetoworkspacesilent ${a.workspace},address:${a.address}`
        case "setFloating":
            return `setfloating enable,address:${a.address}`
        case "resizeExact":
            return `resizewindowpixel exact ${a.w} ${a.h},address:${a.address}`
        case "moveExact":
            return `movewindowpixel exact ${a.x} ${a.y},address:${a.address}`
        case "moveToMonitor":
            return `movewindow mon:${a.monitor},address:${a.address}`
        case "spawnWithRules":
            return `exec [workspace ${a.workspace} silent; float] ${a.exec}`
        case "spawnFloating":
            return `exec [float] ${a.exec}`
    }
}
