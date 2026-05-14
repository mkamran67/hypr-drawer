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
