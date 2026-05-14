import { Astal, Gtk, Gdk } from "ags/gtk4"
import { AppEntry } from "./Apps"
import * as Spawn from "./Spawn"

// Singleton overlay layer-shell window that renders a translucent rectangle
// showing where (and how big) a dragged app will land. Driven imperatively
// from AppTile's drag-begin/drag-end signals — no DropTarget anywhere.

let win: Astal.Window | null = null
let fixed: Gtk.Fixed
let rect: Gtk.Box
let sizeLabel: Gtk.Label
let currentSize: Spawn.DropSize = Spawn.defaultSize()
let monitorW = 1920
let monitorH = 1080

function readPrimaryMonitorSize(): void {
    try {
        const display = Gdk.Display.get_default()
        const monitors: any = display?.get_monitors?.()
        const first: any = monitors?.get_item?.(0)
        const g = first?.get_geometry?.()
        if (g) {
            monitorW = g.width || monitorW
            monitorH = g.height || monitorH
        }
    } catch {
        // keep defaults
    }
}

export function init(): void {
    if (win) return
    readPrimaryMonitorSize()

    fixed = new Gtk.Fixed()
    fixed.hexpand = true
    fixed.vexpand = true
    fixed.set_size_request(monitorW, monitorH)

    rect = new Gtk.Box({
        cssClasses: ["drop-preview"],
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
    })
    sizeLabel = new Gtk.Label({ cssClasses: ["drop-preview-size"] })
    rect.append(sizeLabel)
    rect.visible = false
    fixed.put(rect, 0, 0)

    win = new Astal.Window({
        cssClasses: ["drawer-dropzone"],
        namespace: "hypr-drawer-preview",
        anchor:
            Astal.WindowAnchor.TOP |
            Astal.WindowAnchor.BOTTOM |
            Astal.WindowAnchor.LEFT |
            Astal.WindowAnchor.RIGHT,
        layer: Astal.Layer.OVERLAY,
        keymode: Astal.Keymode.NONE,
        exclusivity: Astal.Exclusivity.IGNORE,
        visible: false,
    })
    win.set_child(fixed)
}

export function show(app: AppEntry): void {
    if (!win) init()
    currentSize = Spawn.previewSize(app)
    rect.set_size_request(currentSize.w, currentSize.h)
    sizeLabel.label = `${currentSize.w} × ${currentSize.h}`
    rect.visible = true
    win!.visible = true
}

export function move(x: number, y: number): void {
    if (!win || !rect.visible) return
    const px = Math.max(
        0,
        Math.min(monitorW - currentSize.w, Math.round(x - currentSize.w / 2)),
    )
    const py = Math.max(
        0,
        Math.min(monitorH - currentSize.h, Math.round(y - currentSize.h / 2)),
    )
    fixed.move(rect, px, py)
}

export function hide(): void {
    if (!win) return
    rect.visible = false
    win.visible = false
}
