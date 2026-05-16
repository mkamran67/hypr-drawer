import { execAsync, exec } from "ags/process"
import GLib from "gi://GLib"

// Per-monitor special workspaces: each monitor gets its own
// `special:drawer-<connector>` (e.g. `special:drawer-DP-1`). This sidesteps
// the single-instance migration race of a single global `special:drawer`
// (toggling on monitor B would yank it off monitor A and drag windows
// along). With one special per monitor, toggling drawer open/closed is just
// N independent toggles, and tracked windows are pinned to their monitor's
// workspace by name.
export const SPECIAL_PREFIX = "special:drawer-"

// Workspace dispatcher name (without the `special:` prefix), used in
// togglespecialworkspace and [workspace ...] rules.
export function specialNameFor(monitorName: string): string {
    return `drawer-${monitorName}`
}

// Full workspace name (with `special:` prefix), used in movetoworkspacesilent
// and matchers.
export function fullSpecialNameFor(monitorName: string): string {
    return `special:${specialNameFor(monitorName)}`
}

// Extract the monitor name encoded into a `special:drawer-<name>` workspace
// name. Returns null for any other workspace name.
export function monitorFromSpecial(wsName: string | undefined): string | null {
    if (!wsName || !wsName.startsWith(SPECIAL_PREFIX)) return null
    return wsName.slice(SPECIAL_PREFIX.length)
}

export type Client = {
    address: string
    class: string
    title: string
    pid: number
    workspace: { id: number; name: string }
    at: [number, number]
    size: [number, number]
    monitor: number
}

export type Monitor = {
    id: number
    name: string
    focused: boolean
    activeWorkspace?: { id: number; name: string }
    specialWorkspace?: { id: number; name: string }
    x?: number
    y?: number
    width?: number
    height?: number
}

export function monitors(): Monitor[] {
    try {
        return JSON.parse(exec("hyprctl monitors -j")) as Monitor[]
    } catch {
        return []
    }
}

export function focusedMonitor(): Monitor | undefined {
    return monitors().find((m) => m.focused)
}

export function cursorPos(): { x: number; y: number } | null {
    try {
        return JSON.parse(exec("hyprctl cursorpos -j")) as { x: number; y: number }
    } catch {
        return null
    }
}

export function clients(): Client[] {
    try {
        return JSON.parse(exec("hyprctl clients -j")) as Client[]
    } catch {
        return []
    }
}

export function findByClass(cls: string): Client | undefined {
    const want = cls.toLowerCase()
    return clients().find(
        (c) => c.class?.toLowerCase() === want || c.class?.toLowerCase().includes(want),
    )
}

// Every client that currently lives in any per-monitor drawer special.
export function findInSpecial(): Client[] {
    return clients().filter((c) => c.workspace?.name?.startsWith(SPECIAL_PREFIX))
}

// Single source of truth for "is the drawer overlay currently visible?".
// Reads Hyprland directly rather than trusting an in-process flag — that
// flag would desync if anything else (another keybind, daemon restart,
// session lock cycle) toggled the workspace behind our back. With
// per-monitor specials, "drawer open" means at least one monitor has its
// drawer-<name> special active.
export function isDrawerOpen(): boolean {
    return monitors().some((m) => m.specialWorkspace?.name?.startsWith(SPECIAL_PREFIX))
}

export async function dispatch(args: string): Promise<string> {
    return await execAsync(`hyprctl dispatch ${args}`)
}

// Move a window into the target monitor's drawer special workspace. Used to
// reassign membership after a drag between monitors, or to re-trap an
// orphan into its rightful monitor on adoption.
export async function moveToSpecialOn(address: string, monitorName: string): Promise<void> {
    await dispatch(`movetoworkspacesilent ${fullSpecialNameFor(monitorName)},address:${address}`)
}

// Move a window to the target monitor's currently-active REGULAR (non-special)
// workspace. Retained for completeness; the new model keeps drawer apps in
// per-monitor specials, but evicting back to a regular workspace is still
// useful as an escape hatch.
export async function moveToRegularOn(
    address: string,
    monitorName: string,
): Promise<void> {
    const m = monitors().find((x) => x.name === monitorName)
    const ws = m?.activeWorkspace?.id
    if (ws === undefined) return
    await dispatch(`movetoworkspacesilent ${ws},address:${address}`)
}

// Spawn an app directly into the given monitor's drawer special workspace,
// floating. Per-monitor specials make this trivial — no migration, no
// post-spawn eviction; the workspace name itself carries the monitor.
export async function spawnInSpecialOn(execStr: string, monitorName: string): Promise<void> {
    await dispatch(`exec [workspace ${fullSpecialNameFor(monitorName)} silent; float] ${execStr}`)
}

function matchClass(cls: string, c: Client): boolean {
    const want = cls.toLowerCase()
    const have = (c.class || "").toLowerCase()
    return have === want || have.includes(want) || want.includes(have)
}

// Poll hyprctl for a newly-mapped window matching `cls` that wasn't in the
// pre-spawn address set. Used to attach floating/geom rules to apps whose
// own startup is too slow for the spawn-time [float] dispatcher to stick.
export async function awaitNewWindow(
    cls: string,
    knownAddrs: Set<string>,
    timeoutMs = 4000,
): Promise<Client | null> {
    const intervalMs = 120
    const tries = Math.ceil(timeoutMs / intervalMs)
    for (let i = 0; i < tries; i++) {
        const fresh = clients().find(
            (c) => !knownAddrs.has(c.address) && matchClass(cls, c),
        )
        if (fresh) return fresh
        await new Promise<void>((resolve) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
                resolve()
                return false
            })
        })
    }
    return null
}

// Force a window into the floating state. Belt-and-suspenders for the
// `[float]` spawn dispatcher and the `float on` workspace windowrule, both
// of which silently miss for some apps (notably Rust/Tauri windows like
// verbatim) — the window ends up tiled in the drawer special, where
// `resizewindowpixel` is a no-op and the user can't drag-resize.
export async function setFloating(address: string): Promise<void> {
    await dispatch(`setfloating enable,address:${address}`)
}

export async function applyGeom(
    address: string,
    geom: { x: number; y: number; w: number; h: number },
): Promise<void> {
    await dispatch(`resizewindowpixel exact ${geom.w} ${geom.h},address:${address}`)
    await dispatch(`movewindowpixel exact ${geom.x} ${geom.y},address:${address}`)
}

export async function movePixel(address: string, x: number, y: number): Promise<void> {
    await dispatch(`movewindowpixel exact ${x} ${y},address:${address}`)
}

export async function moveWindowToMonitor(address: string, monitorName: string): Promise<void> {
    await dispatch(`movewindow mon:${monitorName},address:${address}`)
}

// Open the drawer special workspace on every monitor that doesn't already
// have it open. Hyprland's `togglespecialworkspace` always targets the
// focused monitor, so we walk monitors, focusmonitor on each, toggle if
// needed, then restore focus to the original monitor. Per-monitor specials
// mean each toggle is independent — no migration of a shared workspace.
export async function openAllDrawerSpecials(): Promise<void> {
    const mons = monitors()
    if (mons.length === 0) return
    const originalFocus = mons.find((m) => m.focused)?.name
    for (const m of mons) {
        const want = specialNameFor(m.name)
        if (m.specialWorkspace?.name === `special:${want}`) continue
        await dispatch(`focusmonitor ${m.name}`)
        await dispatch(`togglespecialworkspace ${want}`)
    }
    if (originalFocus) await dispatch(`focusmonitor ${originalFocus}`)
}

// Close every drawer special that's currently open. Mirrors
// openAllDrawerSpecials. Tracked windows stay assigned to their workspace —
// Hyprland persists special-workspace membership across toggles, so the
// next open re-reveals them in place.
export async function closeAllDrawerSpecials(): Promise<void> {
    const mons = monitors()
    if (mons.length === 0) return
    const originalFocus = mons.find((m) => m.focused)?.name
    for (const m of mons) {
        const name = m.specialWorkspace?.name
        if (!name || !name.startsWith(SPECIAL_PREFIX)) continue
        // Toggle on the monitor that currently hosts this special, which
        // will close it. Usually that's m itself, but we trust the data.
        await dispatch(`focusmonitor ${m.name}`)
        await dispatch(`togglespecialworkspace ${name.slice("special:".length)}`)
    }
    if (originalFocus) await dispatch(`focusmonitor ${originalFocus}`)
}
