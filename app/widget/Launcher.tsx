import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, For } from "ags"
import AppTile from "./AppTile"
import * as Apps from "../service/Apps"
import * as Hypr from "../service/Hypr"
import { AppEntry } from "../service/Apps"

const [query, setQuery] = createState("")

export default function Launcher() {
    const results = createComputed(() => Apps.search(query()).slice(0, 80))

    return (
        <window
            cssClasses={["drawer-launcher"]}
            namespace="hypr-drawer"
            anchor={Astal.WindowAnchor.LEFT | Astal.WindowAnchor.TOP | Astal.WindowAnchor.BOTTOM}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.ON_DEMAND}
            exclusivity={Astal.Exclusivity.NORMAL}
            visible={false}
            widthRequest={360}
            $={(self) => {
                const keyCtl = new Gtk.EventControllerKey()
                keyCtl.connect("key-pressed", (_c, key) => {
                    if (key === Gdk.KEY_Escape) self.visible = false
                    return false
                })
                self.add_controller(keyCtl)
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={8} cssClasses={["launcher-root"]}>
                <entry
                    cssClasses={["launcher-search"]}
                    placeholderText="Search apps…"
                    onChanged={(self) => setQuery(self.text)}
                    onActivate={() => {
                        const first = Apps.search(query())[0]
                        if (first) launch(first, 0)
                    }}
                />
                <Gtk.ScrolledWindow hexpand vexpand>
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                        <For each={results}>
                            {(app: AppEntry) => <AppTile app={app} onLaunch={launch} />}
                        </For>
                    </box>
                </Gtk.ScrolledWindow>
                <label
                    cssClasses={["launcher-hint"]}
                    label="Drag → move into drawer · Shift+drag → new instance"
                />
            </box>
        </window>
    )
}

async function launch(app: AppEntry, modifiers: number) {
    const forceNew = !!(modifiers & (Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.CONTROL_MASK))
    if (forceNew) {
        await Hypr.spawnInSpecial(app.exec)
        return
    }
    const existing = Hypr.findByClass(app.wmClass)
    if (existing) await Hypr.moveToSpecial(existing.address)
    else await Hypr.spawnInSpecial(app.exec)
}
