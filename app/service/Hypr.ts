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
