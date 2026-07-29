import * as Settings from "./Settings"
import * as Hypr from "./Hypr"
import * as RailState from "./RailState"

// True when (x, y) — GLOBAL compositor coords, see the invariant in Hypr.ts —
// falls inside the launcher rail strip. Used to short-circuit drops that
// release back over the rail.
//
// This previously tested against GDK monitor index 0 with its origin thrown
// away, which is only correct when the rail happens to be on a monitor at
// (0, 0). On a layout with non-zero origins it went wrong in both directions:
// `side: left` compared a global x (never below 3510 here) against a bare
// width, so it was always false and drops landed *under* the rail; `right` and
// `bottom` were always true, silently swallowing 100% of drops.
//
// Fails OPEN — an unknown rail monitor returns false, so the drop proceeds.
// Failing closed is what made those swallowed drops invisible.
export function isOverRail(x: number, y: number): boolean {
    const name = RailState.railMonitorName()
    if (!name) return false

    const mon = Hypr.monitors().find((m) => m.name === name)
    if (!mon) return false

    const r = Hypr.rectOf(mon)
    if (!r) return false

    // A point on a different monitor is never over the rail, regardless of
    // where it sits within that monitor.
    if (!Hypr.containsPoint(r, x, y)) return false

    const t = RailState.thickness()
    switch (Settings.side()) {
        case "left":   return x < r.x + t
        case "right":  return x >= r.x + r.w - t
        case "top":    return y < r.y + t
        case "bottom": return y >= r.y + r.h - t
    }
    return false
}
