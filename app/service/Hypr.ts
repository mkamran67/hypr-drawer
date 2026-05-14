import { execAsync, exec } from "ags/process"

export const SPECIAL = "special:drawer"

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

export function findInSpecial(): Client[] {
    return clients().filter((c) => c.workspace?.name === SPECIAL)
}

// Single source of truth for "is the drawer overlay currently visible?".
// Reads Hyprland directly rather than trusting an in-process flag — that
// flag would desync if anything else (another keybind, daemon restart,
// session lock cycle) toggled the special workspace behind our back.
export function isDrawerOpen(): boolean {
    try {
        const monitors = JSON.parse(exec("hyprctl monitors -j")) as Array<{
            specialWorkspace?: { name: string }
        }>
        return monitors.some((m) => m.specialWorkspace?.name === SPECIAL)
    } catch {
        return false
    }
}

export async function dispatch(args: string): Promise<string> {
    return await execAsync(`hyprctl dispatch ${args}`)
}

export async function toggleSpecial(): Promise<void> {
    await dispatch(`togglespecialworkspace drawer`)
}

export async function moveToSpecial(address: string): Promise<void> {
    await dispatch(`movetoworkspacesilent ${SPECIAL},address:${address}`)
}

export async function spawnInSpecial(exec: string): Promise<void> {
    // [workspace] rule: launch directly into the special workspace, floating.
    await dispatch(`exec [workspace ${SPECIAL} silent; float] ${exec}`)
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

// Migrate special:drawer from its current host monitor to a new one. In
// Hyprland 0.55+ a single `togglespecialworkspace` on a NON-host monitor
// atomically migrates the workspace (and the windows trapped inside it)
// from its current host to the focused monitor — no close-then-open dance
// required. Toggling on the host instead would close special globally and
// risks losing the workspace's window list, so we only call this when the
// target is verified to be a non-host monitor.
export async function migrateSpecialToMonitor(targetName: string): Promise<void> {
    const mons = monitors()
    const target = mons.find((m) => m.name === targetName)
    const specialHost = mons.find((m) => m.specialWorkspace?.name === SPECIAL)
    if (!target) return
    if (!specialHost || specialHost.name === target.name) return
    await dispatch(`focusmonitor ${target.name}`)
    await dispatch(`togglespecialworkspace drawer`)
}

// Place a window on a specific monitor. If special:drawer already lives on
// the target, just move the window between monitors normally. If special
// is elsewhere, migrate it to the target so the window stays inside the
// drawer workspace and is visible on the target monitor.
export async function placeWindowOnMonitor(address: string, targetId: number): Promise<void> {
    const mons = monitors()
    const target = mons.find((m) => m.id === targetId)
    if (!target) return
    const specialHost = mons.find((m) => m.specialWorkspace?.name === SPECIAL)
    if (specialHost && specialHost.id !== target.id) {
        await migrateSpecialToMonitor(target.name)
        return
    }
    await dispatch(`movewindow mon:${target.name},address:${address}`)
}

// Open the special:drawer workspace on every monitor that doesn't already
// have it open. Hyprland's `togglespecialworkspace` always targets the
// focused monitor, so we walk monitors, focusmonitor on each, toggle if
// needed, then restore focus to the original monitor.
export async function openSpecialOnAllMonitors(): Promise<void> {
    const mons = monitors()
    if (mons.length === 0) return
    const originalFocus = mons.find((m) => m.focused)?.name
    for (const m of mons) {
        if (m.specialWorkspace?.name === SPECIAL) continue
        await dispatch(`focusmonitor ${m.name}`)
        await dispatch(`togglespecialworkspace drawer`)
    }
    if (originalFocus) await dispatch(`focusmonitor ${originalFocus}`)
}

// Close the special:drawer workspace on every monitor that currently has it
// open. Mirrors openSpecialOnAllMonitors and is safe to call regardless of
// which mode the drawer was opened in.
export async function closeSpecialOnAllMonitors(): Promise<void> {
    const mons = monitors()
    if (mons.length === 0) return
    const originalFocus = mons.find((m) => m.focused)?.name
    for (const m of mons) {
        if (m.specialWorkspace?.name !== SPECIAL) continue
        await dispatch(`focusmonitor ${m.name}`)
        await dispatch(`togglespecialworkspace drawer`)
    }
    if (originalFocus) await dispatch(`focusmonitor ${originalFocus}`)
}

// Move every special-workspace client that lives on a non-focused monitor
// onto that monitor's currently-active regular workspace, so the window
// survives the "blur all → focused only" mode switch instead of vanishing
// into a hidden special workspace.
export async function evictSpecialFromNonFocused(): Promise<void> {
    const mons = monitors()
    const focused = mons.find((m) => m.focused)
    if (!focused) return
    const wsByMonitor = new Map<number, number>()
    for (const m of mons) {
        if (m.activeWorkspace) wsByMonitor.set(m.id, m.activeWorkspace.id)
    }
    for (const c of findInSpecial()) {
        if (c.monitor === focused.id) continue
        const targetWs = wsByMonitor.get(c.monitor)
        if (targetWs === undefined) continue
        await dispatch(`movetoworkspacesilent ${targetWs},address:${c.address}`)
    }
}
