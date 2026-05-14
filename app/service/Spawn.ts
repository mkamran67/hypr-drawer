import GLib from "gi://GLib"
import { AppEntry } from "./Apps"
import * as Hypr from "./Hypr"
import * as Memory from "./Memory"
import * as Settings from "./Settings"

export type DropSize = { w: number; h: number }

// User-configurable "small default" size. Read from Settings every call so a
// change in the settings UI takes effect immediately on the next drop —
// no daemon restart, no cached value.
export function defaultSize(): DropSize {
    return { w: Settings.defaultW(), h: Settings.defaultH() }
}

// What the drop preview should display for a given app. Saved geometry wins
// over the small default — that's how a user trains the drawer to remember
// "this app likes to be this size".
export function previewSize(app: AppEntry): DropSize {
    const saved = Memory.get(app.wmClass)
    if (saved && saved.w > 0 && saved.h > 0) {
        return { w: saved.w, h: saved.h }
    }
    return defaultSize()
}

function matchClient(cls: string, c: Hypr.Client): boolean {
    const want = cls.toLowerCase()
    const have = (c.class || "").toLowerCase()
    return have === want || have.includes(want) || want.includes(have)
}

// Poll hyprctl until a window with the expected class appears and isn't in
// the pre-spawn snapshot. We poll because the daemon's socket2 listener in
// app.ts is decoupled from this service; if responsiveness becomes a problem
// the obvious next step is a tiny pub/sub on top of that listener.
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

// Single entry point used by DropZone. Owns the move-vs-spawn branch plus the
// "small by default, don't inflate naturally-small apps" sizing rule.
export async function dropApp(
    app: AppEntry,
    dropX: number,
    dropY: number,
    forceNew: boolean,
): Promise<void> {
    const saved = Memory.get(app.wmClass)

    // Move-existing path: same target as the old handleDrop, but now drops
    // the window at the cursor instead of restoring saved x/y.
    if (!forceNew) {
        const existing = Hypr.findByClass(app.wmClass)
        if (existing) {
            const size: DropSize = saved
                ? { w: saved.w, h: saved.h }
                : { w: existing.size[0], h: existing.size[1] }
            await Hypr.moveToSpecial(existing.address)
            await Hypr.applyGeom(existing.address, centeredGeom(dropX, dropY, size))
            return
        }
    }

    // Spawn path: remember which addresses already existed so awaitNewWindow
    // can distinguish the newly-created one.
    const before = new Set(Hypr.clients().map((c) => c.address))
    await Hypr.spawnInSpecial(app.exec)
    const fresh = await awaitNewWindow(app.wmClass, before)
    if (!fresh) return

    if (saved) {
        await Hypr.applyGeom(
            fresh.address,
            centeredGeom(dropX, dropY, { w: saved.w, h: saved.h }),
        )
        return
    }

    // No memory: cap to the user's default size but leave naturally-smaller
    // apps alone.
    const cap = defaultSize()
    const naturalW = fresh.size[0]
    const naturalH = fresh.size[1]
    const w = Math.min(naturalW, cap.w)
    const h = Math.min(naturalH, cap.h)
    const geom = centeredGeom(dropX, dropY, { w, h })

    if (w === naturalW && h === naturalH) {
        // Already small enough — just position it; skip the resize call.
        await Hypr.movePixel(fresh.address, geom.x, geom.y)
    } else {
        await Hypr.applyGeom(fresh.address, geom)
    }
}
