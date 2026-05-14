import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { AppEntry } from "../service/Apps"
import { setActiveDrag, clearActiveDrag } from "../service/DragState"
import * as Preview from "../service/Preview"
import * as Spawn from "../service/Spawn"
import * as Hypr from "../service/Hypr"
import * as Layout from "../service/Layout"

type Props = {
    app: AppEntry
    onLaunch: (app: AppEntry, modifiers: number) => void
}

// Each tile is a click-to-launch button AND a Wayland drag source. The drag
// source provides the icon ghost; we drive the preview rectangle + drop
// dispatch ourselves on drag-begin/drag-end, because cross-surface DnD into
// our layer-shell overlay doesn't deliver events on this stack.
export default function AppTile({ app, onLaunch }: Props) {
    const drag = new Gtk.DragSource({ actions: Gdk.DragAction.COPY })
    drag.propagationPhase = Gtk.PropagationPhase.CAPTURE

    drag.connect("prepare", () => {
        const payload = JSON.stringify(app)
        const value = new GObject.Value()
        value.init(GObject.TYPE_STRING)
        value.set_string(payload)
        return Gdk.ContentProvider.new_for_value(value)
    })

    let lastModifiers = 0
    const keyCtl = new Gtk.EventControllerKey()
    keyCtl.connect("key-pressed", (_c, _k, _kc, state) => {
        lastModifiers = state
        return false
    })

    let pollId = 0
    function stopPoll() {
        if (pollId) {
            GLib.source_remove(pollId)
            pollId = 0
        }
    }

    function readModifierState(): number {
        try {
            const display = Gdk.Display.get_default()
            const seat = display?.get_default_seat()
            return seat?.get_keyboard()?.get_modifier_state?.() ?? 0
        } catch {
            return 0
        }
    }

    return (
        <button
            cssClasses={["app-tile"]}
            tooltipText={app.name}
            onClicked={() => onLaunch(app, lastModifiers)}
            $={(self) => {
                self.add_controller(drag)
                self.add_controller(keyCtl)

                drag.connect("drag-begin", () => {
                    try {
                        const paintable = Gtk.WidgetPaintable.new(self)
                        drag.set_icon(paintable, 0, 0)
                    } catch (e) {
                        console.error("drag-begin set_icon:", e)
                    }
                    setActiveDrag(app)
                    Preview.show(app)
                    // Prime position so the rect doesn't flash at (0, 0).
                    const p0 = Hypr.cursorPos()
                    if (p0) Preview.move(p0.x, p0.y)

                    stopPoll()
                    // ~60Hz cursor polling for smooth preview tracking.
                    pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                        const p = Hypr.cursorPos()
                        if (p) Preview.move(p.x, p.y)
                        return true
                    })
                })

                drag.connect("drag-end", () => {
                    stopPoll()
                    const p = Hypr.cursorPos()
                    Preview.hide()
                    clearActiveDrag()
                    if (!p) return
                    if (Layout.isOverRail(p.x, p.y)) return
                    const mods = readModifierState()
                    const forceNew = !!(
                        mods &
                        (Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.CONTROL_MASK)
                    )
                    Spawn.dropApp(app, p.x, p.y, forceNew).catch(console.error)
                })

                drag.connect("drag-cancel", () => {
                    stopPoll()
                    Preview.hide()
                    clearActiveDrag()
                    return false
                })
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                <image iconName={app.icon} pixelSize={48} />
                <label
                    label={app.name}
                    maxWidthChars={12}
                    ellipsize={3}
                    canFocus={false}
                    selectable={false}
                />
            </box>
        </button>
    )
}
