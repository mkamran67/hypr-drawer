import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import { AppEntry } from "../service/Apps"

type Props = {
    app: AppEntry
    onLaunch: (app: AppEntry, modifiers: number) => void
}

// Each tile is a button (click = launch with current modifiers) and a DnD
// source carrying a JSON payload the DropZone consumes.
export default function AppTile({ app, onLaunch }: Props) {
    const drag = new Gtk.DragSource({ actions: Gdk.DragAction.COPY })
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

    return (
        <button
            cssClasses={["app-tile"]}
            tooltipText={app.name}
            onClicked={() => onLaunch(app, lastModifiers)}
            $={(self) => {
                self.add_controller(drag)
                self.add_controller(keyCtl)
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                <image iconName={app.icon} pixelSize={48} />
                <label label={app.name} maxWidthChars={12} ellipsize={3} />
            </box>
        </button>
    )
}
