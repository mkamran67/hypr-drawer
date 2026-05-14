import { Astal, Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import { AppEntry } from "../service/Apps"
import * as Hypr from "../service/Hypr"
import * as Memory from "../service/Memory"

// Invisible click-through layer that ONLY catches drag-and-drop, sitting on
// top of the special workspace area while the drawer is visible.
export default function DropZone(props: { onClose: () => void }) {
    const drop = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.COPY)

    drop.connect("drop", (_t, value: any, _x: number, _y: number) => {
        let app: AppEntry
        try {
            app = JSON.parse(value as string) as AppEntry
        } catch {
            return false
        }

        const display = Gdk.Display.get_default()
        const seat = display?.get_default_seat()
        const state = seat?.get_keyboard()?.get_modifier_state?.() ?? 0
        const forceNew = !!(state & (Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.CONTROL_MASK))

        handleDrop(app, forceNew).catch(console.error)
        return true
    })

    return (
        <window
            cssClasses={["drawer-dropzone"]}
            namespace="hypr-drawer-dropzone"
            anchor={Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM |
                    Astal.WindowAnchor.LEFT | Astal.WindowAnchor.RIGHT}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.NONE}
            exclusivity={Astal.Exclusivity.IGNORE}
            visible={false}
            $={(self) => {
                self.add_controller(drop)
                // Make the surface input-transparent EXCEPT for DnD.
                // GTK4 DropTarget still receives drag events while clicks pass through
                // because we don't set any click controllers here.
            }}
        >
            <box hexpand vexpand />
        </window>
    )
}

async function handleDrop(app: AppEntry, forceNew: boolean) {
    if (forceNew) {
        await Hypr.spawnInSpecial(app.exec)
        return
    }
    const existing = Hypr.findByClass(app.wmClass)
    if (existing) {
        await Hypr.moveToSpecial(existing.address)
        const saved = Memory.get(app.wmClass)
        if (saved) await Hypr.applyGeom(existing.address, saved)
    } else {
        await Hypr.spawnInSpecial(app.exec)
    }
}
