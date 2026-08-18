// Unit tests for the dispatcher serializer.
//
// Under the Lua config provider, `hyprctl dispatch X Y` is wrapped as
// `return hl.dispatch(X Y)` and parsed as Lua, so every legacy dispatcher
// string is a syntax error. That broke the drawer completely on CachyOS: the
// rail rendered, but the special workspace never opened and every window
// operation silently failed into console.error.
//
// Every `lua` expectation below was executed against a real Hyprland 0.56.2
// (a nested instance, isolated from the dev session) and confirmed to return
// `ok` with the intended effect. Treat them as recorded observations, not
// guesses — if one needs changing, re-run it against a live compositor first.
//
// Usage: node packaging/test-dispatch.ts   (node >= 22, native type stripping)

import { serialize, type Action } from "../app/service/Dispatch.ts"

let failed = 0

function group(name: string): void {
    console.log(`\n\x1b[1m${name}\x1b[0m`)
}

function chk(label: string, got: string, want: string): void {
    if (got === want) {
        console.log(`  \x1b[1;32mPASS\x1b[0m ${label}`)
    } else {
        console.log(`  \x1b[1;31mFAIL\x1b[0m ${label}`)
        console.log(`       got  ${got}`)
        console.log(`       want ${want}`)
        failed = 1
    }
}

const ADDR = "0x55d9adeeb8e0"

const cases: Array<{ label: string; action: Action; legacy: string; lua: string }> = [
    {
        label: "focusMonitor",
        action: { kind: "focusMonitor", monitor: "DP-2" },
        legacy: "focusmonitor DP-2",
        lua: 'hl.dsp.focus({ monitor = "DP-2" })',
    },
    {
        label: "toggleSpecial",
        action: { kind: "toggleSpecial", workspace: "drawer-DP-2" },
        legacy: "togglespecialworkspace drawer-DP-2",
        lua: 'hl.dsp.workspace.toggle_special("drawer-DP-2")',
    },
    {
        label: "moveToWorkspaceSilent (special)",
        action: {
            kind: "moveToWorkspaceSilent",
            workspace: "special:drawer-DP-2",
            address: ADDR,
        },
        legacy: `movetoworkspacesilent special:drawer-DP-2,address:${ADDR}`,
        lua:
            'hl.dsp.window.move({ workspace = "special:drawer-DP-2", ' +
            `silent = true, window = "address:${ADDR}" })`,
    },
    {
        // moveToRegularOn passes a numeric workspace id. Hyprland accepts it
        // as a Lua string, so the serializer never emits a bare number.
        label: "moveToWorkspaceSilent (numeric id)",
        action: { kind: "moveToWorkspaceSilent", workspace: "5", address: ADDR },
        legacy: `movetoworkspacesilent 5,address:${ADDR}`,
        lua: `hl.dsp.window.move({ workspace = "5", silent = true, window = "address:${ADDR}" })`,
    },
    {
        label: "setFloating",
        action: { kind: "setFloating", address: ADDR },
        legacy: `setfloating enable,address:${ADDR}`,
        lua: `hl.dsp.window.float({ action = "enable", window = "address:${ADDR}" })`,
    },
    {
        label: "resizeExact",
        action: { kind: "resizeExact", w: 500, h: 400, address: ADDR },
        legacy: `resizewindowpixel exact 500 400,address:${ADDR}`,
        lua: `hl.dsp.window.resize({ exact = true, x = 500, y = 400, window = "address:${ADDR}" })`,
    },
    {
        label: "moveExact",
        action: { kind: "moveExact", x: 60, y: 70, address: ADDR },
        legacy: `movewindowpixel exact 60 70,address:${ADDR}`,
        lua: `hl.dsp.window.move({ exact = true, x = 60, y = 70, window = "address:${ADDR}" })`,
    },
    {
        // Used when the app's only window is already sitting in the drawer:
        // re-issuing movetoworkspacesilent there is invisible, so focus it
        // instead and the click stops looking like a no-op. The lua form was
        // dispatched against the live compositor (0.56.2, lua provider) and
        // returned `ok`; the legacy string is the stock dispatcher name.
        label: "focusWindow",
        action: { kind: "focusWindow", address: ADDR },
        legacy: `focuswindow address:${ADDR}`,
        lua: `hl.dsp.focus({ window = "address:${ADDR}" })`,
    },
    {
        label: "moveToMonitor",
        action: { kind: "moveToMonitor", monitor: "DP-2", address: ADDR },
        legacy: `movewindow mon:DP-2,address:${ADDR}`,
        lua: `hl.dsp.window.move({ monitor = "DP-2", window = "address:${ADDR}" })`,
    },
    {
        label: "spawnWithRules",
        action: {
            kind: "spawnWithRules",
            exec: "alacritty",
            workspace: "special:drawer-DP-2",
        },
        legacy: "exec [workspace special:drawer-DP-2 silent; float] alacritty",
        lua:
            'hl.dsp.exec_cmd("alacritty", { workspace = ' +
            '"special:drawer-DP-2 silent", float = true })',
    },
    {
        // Launcher.tsx spawns into the current workspace with only the float
        // rule, for the "launch outside the drawer" path.
        label: "spawnFloating",
        action: { kind: "spawnFloating", exec: "alacritty" },
        legacy: "exec [float] alacritty",
        lua: 'hl.dsp.exec_cmd("alacritty", { float = true })',
    },
]

group("serializer: legacy")
for (const c of cases) chk(c.label, serialize(c.action, "legacy"), c.legacy)

group("serializer: lua")
for (const c of cases) chk(c.label, serialize(c.action, "lua"), c.lua)

// A .desktop Exec line is arbitrary user data — Discord's is a good example of
// one carrying quotes. Unescaped, it would terminate the Lua string early and
// turn a spawn into a parse error, or worse, into injected Lua.
group("lua string escaping")
chk(
    "double quotes in exec",
    serialize(
        { kind: "spawnWithRules", exec: 'sh -c "echo hi"', workspace: "special:d" },
        "lua",
    ),
    'hl.dsp.exec_cmd("sh -c \\"echo hi\\"", { workspace = "special:d silent", float = true })',
)
chk(
    "backslash in exec",
    serialize(
        { kind: "spawnWithRules", exec: "wine C:\\\\app.exe", workspace: "special:d" },
        "lua",
    ),
    'hl.dsp.exec_cmd("wine C:\\\\\\\\app.exe", { workspace = "special:d silent", float = true })',
)
chk(
    "newline in exec",
    serialize(
        { kind: "spawnWithRules", exec: "a\nb", workspace: "special:d" },
        "lua",
    ),
    'hl.dsp.exec_cmd("a\\nb", { workspace = "special:d silent", float = true })',
)

if (failed === 0) {
    console.log("\n\x1b[1;32m✓ all dispatch serializer tests passed\x1b[0m")
} else {
    console.log("\n\x1b[1;31m✗ dispatch serializer tests failed\x1b[0m")
}
process.exit(failed)
