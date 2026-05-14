import { Astal, Gtk, Gdk } from "ags/gtk4"
import { AppEntry } from "./Apps"
import * as Spawn from "./Spawn"
import * as Hypr from "./Hypr"

// Per-monitor overlay layer-shell windows that render a translucent rectangle
// showing where (and how big) a dragged app will land. Driven imperatively
// from AppTile's drag-begin/drag-end signals — no DropTarget anywhere.
//
// One window per monitor (mirrors Shade.ts) so the preview can track the
// cursor across monitors: cursor coordinates from Hyprland are global layout
// space, but each layer-shell window's Gtk.Fixed is local to its monitor, so
// we pick the monitor the cursor is inside and translate to local coords.

type Entry = {
    name: string
    win: Astal.Window
    fixed: Gtk.Fixed
    rect: Gtk.Box
    sizeLabel: Gtk.Label
    width: number
    height: number
}

const ANCHOR =
    Astal.WindowAnchor.TOP |
    Astal.WindowAnchor.BOTTOM |
    Astal.WindowAnchor.LEFT |
    Astal.WindowAnchor.RIGHT

const entries = new Map<any, Entry>()
let currentSize: Spawn.DropSize = Spawn.defaultSize()

function makeEntry(gdkmonitor: any): Entry {
    const geom = gdkmonitor.get_geometry?.()
    const width = geom?.width || 1920
    const height = geom?.height || 1080

    const fixed = new Gtk.Fixed()
    fixed.hexpand = true
    fixed.vexpand = true
    fixed.set_size_request(width, height)

    const rect = new Gtk.Box({
        cssClasses: ["drop-preview"],
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })
    const sizeLabel = new Gtk.Label({ cssClasses: ["drop-preview-size"] })
    rect.append(sizeLabel)
    rect.visible = false
    fixed.put(rect, 0, 0)

    const win = new Astal.Window({
        cssClasses: ["drawer-dropzone"],
        namespace: "hypr-drawer-preview",
        gdkmonitor,
        anchor: ANCHOR,
        layer: Astal.Layer.OVERLAY,
        keymode: Astal.Keymode.NONE,
        exclusivity: Astal.Exclusivity.IGNORE,
        visible: false,
    })
    win.set_child(fixed)

    return {
        name: gdkmonitor.get_connector?.() ?? "",
        win,
        fixed,
        rect,
        sizeLabel,
        width,
        height,
    }
}

export function init(): void {
    if (entries.size > 0) return
    const display = Gdk.Display.get_default()
    const monitors: any = display?.get_monitors?.()
    const count = monitors?.get_n_items?.() ?? 0
    for (let i = 0; i < count; i++) {
        const m: any = monitors.get_item(i)
        if (!m) continue
        entries.set(m, makeEntry(m))
    }
}

export function show(app: AppEntry): void {
    if (entries.size === 0) init()
    currentSize = Spawn.previewSize(app)
    const label = `${currentSize.w} × ${currentSize.h}`
    for (const e of entries.values()) {
        e.rect.set_size_request(currentSize.w, currentSize.h)
        e.sizeLabel.label = label
        e.rect.visible = false
        e.win.visible = true
    }
}

export function move(x: number, y: number): void {
    if (entries.size === 0) return
    const mons = Hypr.monitors()
    const host = mons.find(
        (m) =>
            m.x !== undefined &&
            m.y !== undefined &&
            m.width !== undefined &&
            m.height !== undefined &&
            x >= m.x &&
            x < m.x + m.width &&
            y >= m.y &&
            y < m.y + m.height,
    )

    for (const e of entries.values()) {
        if (!host || e.name !== host.name) {
            e.rect.visible = false
            continue
        }
        const lx = x - (host.x ?? 0)
        const ly = y - (host.y ?? 0)
        const px = Math.max(
            0,
            Math.min(e.width - currentSize.w, Math.round(lx - currentSize.w / 2)),
        )
        const py = Math.max(
            0,
            Math.min(e.height - currentSize.h, Math.round(ly - currentSize.h / 2)),
        )
        e.fixed.move(e.rect, px, py)
        e.rect.visible = true
    }
}

export function hide(): void {
    for (const e of entries.values()) {
        e.rect.visible = false
        e.win.visible = false
    }
}
