import { Astal, Gtk, Gdk } from "ags/gtk4"
import * as Hypr from "../service/Hypr"

// Per-monitor full-screen layer-shell windows that exist only to give the
// compositor something to blur on monitors other than the one the rail is
// on. Hyprland's `layerrule = blur on, match:namespace hypr-drawer-shade`
// (in drawer.conf) turns these into the actual blur effect; the windows
// themselves are visually empty (CSS makes them mostly transparent).

const NAMESPACE = "hypr-drawer-shade"
const ANCHOR =
    Astal.WindowAnchor.TOP |
    Astal.WindowAnchor.BOTTOM |
    Astal.WindowAnchor.LEFT |
    Astal.WindowAnchor.RIGHT

const wins = new Map<any, Astal.Window>()

function makeWindow(gdkmonitor: any): Astal.Window {
    const w = new Astal.Window({
        cssClasses: ["drawer-shade"],
        namespace: NAMESPACE,
        gdkmonitor,
        anchor: ANCHOR,
        // TOP — sits above regular application windows so the drawer
        // feels like a modal overlay on every monitor it covers. The
        // monitor currently hosting special:drawer is excluded from
        // shading (see show() below), so drawer-spawned apps living in
        // that workspace are never obscured. The rail itself is on
        // OVERLAY, one layer higher again, so it draws above the shade.
        layer: Astal.Layer.TOP,
        keymode: Astal.Keymode.NONE,
        exclusivity: Astal.Exclusivity.IGNORE,
        visible: false,
    })
    const fill = new Gtk.Box({ cssClasses: ["drawer-shade-fill"], hexpand: true, vexpand: true })
    w.set_child(fill)
    return w
}

// Show a shade on every monitor that ISN'T currently hosting
// special:drawer. Skipping that one avoids double-blurring it on top of
// Hyprland's own `decoration.blur.special` pass.
export function show(): void {
    const display = Gdk.Display.get_default()
    const monitors: any = display?.get_monitors?.()
    const count = monitors?.get_n_items?.() ?? 0

    const specialHostName = Hypr.monitors().find(
        (m) => m.specialWorkspace?.name === "special:drawer",
    )?.name

    const wanted = new Set<any>()
    for (let i = 0; i < count; i++) {
        const m: any = monitors.get_item(i)
        if (!m) continue
        if (specialHostName && m.get_connector?.() === specialHostName) continue
        wanted.add(m)
        let win = wins.get(m)
        if (!win) {
            win = makeWindow(m)
            wins.set(m, win)
        }
        win.visible = true
    }
    // Hide any shades that shouldn't be visible (monitor unplugged, or
    // special:drawer just landed on this monitor).
    for (const [mon, win] of wins) {
        if (!wanted.has(mon)) win.visible = false
    }
}

export function hide(): void {
    for (const win of wins.values()) win.visible = false
}
