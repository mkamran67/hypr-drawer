import { Gdk } from "ags/gtk4"
import * as Settings from "./Settings"

function primaryMonitor(): { w: number; h: number } {
    try {
        const display = Gdk.Display.get_default()
        const monitors: any = display?.get_monitors?.()
        const first: any = monitors?.get_item?.(0)
        const g = first?.get_geometry?.()
        if (g) return { w: g.width || 1920, h: g.height || 1080 }
    } catch {}
    return { w: 1920, h: 1080 }
}

// True when (x, y) — global compositor coords — falls inside the launcher
// rail strip. Used to short-circuit drops that release back over the rail.
export function isOverRail(x: number, y: number): boolean {
    const side = Settings.side()
    const w = Settings.width()
    const mon = primaryMonitor()
    switch (side) {
        case "left":   return x < w
        case "right":  return x > mon.w - w
        case "top":    return y < w
        case "bottom": return y > mon.h - w
    }
}
