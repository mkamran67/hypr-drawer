import { AppEntry } from "./Apps"
import * as Hypr from "./Hypr"
import * as Memory from "./Memory"
import * as Settings from "./Settings"

// Resolve which monitor a drop should land on. Priority order:
//   1. The monitor whose layout rect contains the global drop point.
//   2. The saved monitor from Memory — connector name first, then a legacy
//      numeric id, so existing positions.json files keep working.
//   3. Nearest monitor, for drops into layout dead space.
//   4. The focused monitor, then whatever is first.
//
// The hit-test is deliberately NOT gated on Settings.blurAllMonitors(). Now
// that the drop point is correctly treated as global, a gated drop would move
// the window into special:drawer-<focused> while positioning it at another
// monitor's coordinates — workspace membership and geometry would contradict
// each other. The user-visible consequence is intended: with "blur all
// monitors" off, a drop released over a different monitor lands *there*
// rather than on the focused monitor.
function resolveTargetMonitor(
    dropX: number,
    dropY: number,
    savedMonitor: string | undefined,
): Hypr.Monitor | undefined {
    const mons = Hypr.monitors()
    if (mons.length === 0) return undefined

    const hit = Hypr.monitorAt(dropX, dropY, mons)
    if (hit) return hit

    if (savedMonitor !== undefined) {
        const byName = mons.find((m) => m.name === savedMonitor)
        if (byName) return byName
        const id = parseInt(savedMonitor, 10)
        if (!Number.isNaN(id)) {
            const byId = mons.find((m) => m.id === id)
            if (byId) return byId
        }
    }

    return Hypr.nearestMonitor(dropX, dropY, mons) ?? mons.find((m) => m.focused) ?? mons[0]
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

// `wmClass` is the desktop-derived key this window should be remembered under.
// app.ts records it so its geometry-persist loops write under the same key
// Memory is later read with — see the key-space note in Memory.ts.
function trackDrawerWindow(address: string, wmClass?: string): void {
    const fn = (globalThis as any).__hyprDrawerTrack
    if (typeof fn === "function") {
        try {
            fn(address, wmClass)
        } catch (e) {
            console.error("track:", e)
        }
    }
}

// Centre a window of `size` on a point. Both the point and the result are in
// global layout space; there is no monitor-local step anywhere in the drop
// path (see the invariant in Hypr.ts).
export function centeredGeom(
    dropX: number,
    dropY: number,
    size: DropSize,
): Hypr.Rect {
    return {
        x: Math.round(dropX - size.w / 2),
        y: Math.round(dropY - size.h / 2),
        w: size.w,
        h: size.h,
    }
}

// Keep a window fully on its target monitor. Needed because a hit-test miss
// now falls back to `nearestMonitor`, and because centring on a point near an
// edge otherwise parks half the window off-screen. Size is clamped first so a
// window larger than the monitor is shrunk rather than pushed out of view.
export function clampToMonitor(m: Hypr.Monitor, geom: Hypr.Rect): Hypr.Rect {
    const r = Hypr.rectOf(m)
    if (!r) return geom
    const w = Math.min(geom.w, r.w)
    const h = Math.min(geom.h, r.h)
    return {
        x: Math.max(r.x, Math.min(geom.x, r.x + r.w - w)),
        y: Math.max(r.y, Math.min(geom.y, r.y + r.h - h)),
        w,
        h,
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

    // (dropX, dropY) is global and stays global — every hyprctl dispatcher
    // below consumes global coordinates. No translation step.

    // Move-existing path: reassign the window into the target monitor's
    // drawer special, then reposition.
    if (!forceNew) {
        const existing = Hypr.findByClass(app.wmClass)
        if (existing) {
            const size: DropSize = saved
                ? { w: saved.w, h: saved.h }
                : { w: existing.size[0], h: existing.size[1] }
            trackDrawerWindow(existing.address, app.wmClass)
            await Hypr.moveToSpecialOn(existing.address, target.name)
            await Hypr.setFloating(existing.address)
            await Hypr.applyGeom(
                existing.address,
                clampToMonitor(target, centeredGeom(dropX, dropY, size)),
            )
            forceShadeRefresh()
            return
        }
    }

    // Spawn path: spawn directly into the target monitor's drawer special.
    const before = new Set(Hypr.clients().map((c) => c.address))
    await Hypr.spawnInSpecialOn(app.exec, target.name)
    const fresh = await Hypr.awaitNewWindow(app.wmClass, before)
    if (!fresh) return
    trackDrawerWindow(fresh.address, app.wmClass)

    // If Hyprland spawned the window on a different monitor (rare — usually
    // the [workspace ...] rule wins), pull it onto the intended one.
    if (fresh.monitor !== target.id) {
        await Hypr.moveToSpecialOn(fresh.address, target.name)
    }

    await Hypr.setFloating(fresh.address)

    if (saved) {
        await Hypr.applyGeom(
            fresh.address,
            clampToMonitor(target, centeredGeom(dropX, dropY, { w: saved.w, h: saved.h })),
        )
    } else {
        const cap = defaultSize()
        const naturalW = fresh.size[0]
        const naturalH = fresh.size[1]
        const w = Math.min(naturalW, cap.w)
        const h = Math.min(naturalH, cap.h)
        const geom = clampToMonitor(target, centeredGeom(dropX, dropY, { w, h }))

        // Only skip the resize when the clamp also left the size untouched —
        // otherwise a window larger than the monitor would keep its natural
        // size and only get moved.
        if (w === naturalW && h === naturalH && geom.w === w && geom.h === h) {
            await Hypr.movePixel(fresh.address, geom.x, geom.y)
        } else {
            await Hypr.applyGeom(fresh.address, geom)
        }
    }

    forceShadeRefresh()
}
