import GLib from "gi://GLib"
import { AppEntry } from "./Apps"
import * as Hypr from "./Hypr"
import * as Memory from "./Memory"
import * as Settings from "./Settings"

// Resolve which monitor a drop should land on. Priority order:
//   1. The monitor whose layout bounding rect contains (dropX, dropY).
//   2. The saved monitor id from Memory, if one was recorded.
//   3. Final fallback: the focused monitor.
function resolveTargetMonitor(
    dropX: number,
    dropY: number,
    savedMonitor: string | undefined,
): Hypr.Monitor | undefined {
    const mons = Hypr.monitors()
    if (mons.length === 0) return undefined

    if (Settings.blurAllMonitors()) {
        const hit = mons.find((m) => {
            if (m.x === undefined || m.y === undefined || !m.width || !m.height) return false
            return dropX >= m.x && dropX < m.x + m.width && dropY >= m.y && dropY < m.y + m.height
        })
        if (hit) return hit
    }

    if (savedMonitor !== undefined) {
        const id = parseInt(savedMonitor, 10)
        if (!Number.isNaN(id)) {
            const byId = mons.find((m) => m.id === id)
            if (byId) return byId
        }
    }

    return mons.find((m) => m.focused) ?? mons[0]
}

export type DropSize = { w: number; h: number }

export function defaultSize(): DropSize {
    return { w: Settings.defaultW(), h: Settings.defaultH() }
}

export function previewSize(app: AppEntry): DropSize {
    const saved = Memory.get(app.wmClass)
    if (saved && saved.w > 0 && saved.h > 0) {
        return { w: saved.w, h: saved.h }
    }
    return defaultSize()
}

// Drive the daemon's shade refresh directly so spawn/move actions instantly
// redraw the shades without waiting for socket2 round-trip.
function forceShadeRefresh(): void {
    const fn = (globalThis as any).__hyprDrawerRefresh
    if (typeof fn === "function") {
        try {
            fn()
        } catch (e) {
            console.error("shade refresh:", e)
        }
    }
}

function trackDrawerWindow(address: string): void {
    const fn = (globalThis as any).__hyprDrawerTrack
    if (typeof fn === "function") {
        try {
            fn(address)
        } catch (e) {
            console.error("track:", e)
        }
    }
}

function matchClient(cls: string, c: Hypr.Client): boolean {
    const want = cls.toLowerCase()
    const have = (c.class || "").toLowerCase()
    return have === want || have.includes(want) || want.includes(have)
}

async function awaitNewWindow(
    cls: string,
    knownAddrs: Set<string>,
    timeoutMs = 4000,
): Promise<Hypr.Client | null> {
    const intervalMs = 120
    const tries = Math.ceil(timeoutMs / intervalMs)
    for (let i = 0; i < tries; i++) {
        const fresh = Hypr.clients().find(
            (c) => !knownAddrs.has(c.address) && matchClient(cls, c),
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

function centeredGeom(
    dropX: number,
    dropY: number,
    size: DropSize,
): { x: number; y: number; w: number; h: number } {
    return {
        x: Math.round(dropX - size.w / 2),
        y: Math.round(dropY - size.h / 2),
        w: size.w,
        h: size.h,
    }
}

// Single entry point used by DropZone. Owns the move-vs-spawn branch plus
// the "small by default, don't inflate naturally-small apps" sizing rule.
// Per-monitor special workspaces: the target monitor's drawer-special is
// the spawn target directly, no migration or post-spawn eviction needed.
export async function dropApp(
    app: AppEntry,
    dropX: number,
    dropY: number,
    forceNew: boolean,
): Promise<void> {
    const saved = Memory.get(app.wmClass)
    const target = resolveTargetMonitor(dropX, dropY, saved?.monitor)
    if (!target) return

    // Drop coords are in the source overlay monitor's local space. Translate
    // to the target monitor's local space (which is also what
    // movewindowpixel expects).
    const localX = target.x !== undefined ? dropX - target.x : dropX
    const localY = target.y !== undefined ? dropY - target.y : dropY

    // Move-existing path: reassign the window into the target monitor's
    // drawer special, then reposition.
    if (!forceNew) {
        const existing = Hypr.findByClass(app.wmClass)
        if (existing) {
            const size: DropSize = saved
                ? { w: saved.w, h: saved.h }
                : { w: existing.size[0], h: existing.size[1] }
            trackDrawerWindow(existing.address)
            await Hypr.moveToSpecialOn(existing.address, target.name)
            await Hypr.applyGeom(existing.address, centeredGeom(localX, localY, size))
            forceShadeRefresh()
            return
        }
    }

    // Spawn path: spawn directly into the target monitor's drawer special.
    const before = new Set(Hypr.clients().map((c) => c.address))
    await Hypr.spawnInSpecialOn(app.exec, target.name)
    const fresh = await awaitNewWindow(app.wmClass, before)
    if (!fresh) return
    trackDrawerWindow(fresh.address)

    // If Hyprland spawned the window on a different monitor (rare — usually
    // the [workspace ...] rule wins), pull it onto the intended one.
    if (fresh.monitor !== target.id) {
        await Hypr.moveToSpecialOn(fresh.address, target.name)
    }

    if (saved) {
        await Hypr.applyGeom(
            fresh.address,
            centeredGeom(localX, localY, { w: saved.w, h: saved.h }),
        )
    } else {
        const cap = defaultSize()
        const naturalW = fresh.size[0]
        const naturalH = fresh.size[1]
        const w = Math.min(naturalW, cap.w)
        const h = Math.min(naturalH, cap.h)
        const geom = centeredGeom(localX, localY, { w, h })

        if (w === naturalW && h === naturalH) {
            await Hypr.movePixel(fresh.address, geom.x, geom.y)
        } else {
            await Hypr.applyGeom(fresh.address, geom)
        }
    }

    forceShadeRefresh()
}
