import { Astal, Gtk, Gdk } from "ags/gtk4"

// Per-monitor full-screen layer-shell windows that provide a blurred
// backdrop on every monitor while the drawer is open. Hyprland's
// `layerrule = blur on, match:namespace hypr-drawer-shade` (drawer.conf)
// is what actually turns these into blur; the windows themselves are
// visually empty.
//
// Layer choice: BOTTOM. The shade sits below regular windows AND below
// special-workspace contents. With per-monitor `special:drawer-<name>`
// workspaces open, tracked apps render in the special workspace ABOVE
// regular content, ABOVE the shade — which gives us "blur everywhere,
// apps above blur" without needing to destroy/restack the shade when an
// app appears on a monitor (which previously caused a ghost-surface bug
// when a window migrated between monitors).

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
        layer: Astal.Layer.BOTTOM,
        keymode: Astal.Keymode.NONE,
        exclusivity: Astal.Exclusivity.IGNORE,
        visible: true,
    })
    const fill = new Gtk.Box({ cssClasses: ["drawer-shade-fill"], hexpand: true, vexpand: true })
    w.set_child(fill)
    return w
}

function destroyShade(mon: any): void {
    const w = wins.get(mon)
    if (!w) return
    try {
        ;(w as any).destroy?.()
    } catch (e) {
        console.error("shade destroy:", e)
    }
    wins.delete(mon)
}

// Show a shade on every monitor. No occupied-monitor exclusion — the shade
// is BOTTOM, so tracked apps in per-monitor specials always render above
// it. Argument retained for API compatibility.
export function show(_trackedAddrs: Set<string> = new Set()): void {
    const display = Gdk.Display.get_default()
    const monitors: any = display?.get_monitors?.()
    const count = monitors?.get_n_items?.() ?? 0

    const wanted = new Set<any>()
    for (let i = 0; i < count; i++) {
        const m: any = monitors.get_item(i)
        if (!m) continue
        wanted.add(m)
        if (!wins.has(m)) {
            wins.set(m, makeWindow(m))
        } else {
            const w = wins.get(m)!
            ;(w as any).visible = true
        }
    }
    // Destroy stale entries (e.g. monitor unplugged).
    for (const [mon] of wins) {
        if (!wanted.has(mon)) destroyShade(mon)
    }
}

// Fully unrealize every shade so the layer-shell surface is unregistered
// with the compositor on close. Avoids ghost surfaces.
export function hide(): void {
    for (const mon of [...wins.keys()]) destroyShade(mon)
}
