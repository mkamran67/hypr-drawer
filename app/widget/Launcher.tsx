import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, For } from "ags"
import AppTile from "./AppTile"
import * as Apps from "../service/Apps"
import * as Hypr from "../service/Hypr"
import * as Settings from "../service/Settings"
import * as Memory from "../service/Memory"
import * as Hotkey from "../service/Hotkey"
import { AppEntry } from "../service/Apps"

const [query, setQuery] = createState("")
const [page, setPage] = createState<"launcher" | "settings">("launcher")

function closeDrawer() {
    const hide = (globalThis as any).__hyprDrawerHide
    if (typeof hide === "function") hide()
}

export default function Launcher() {
    const results = createComputed(() => Apps.search(query()).slice(0, 80))
    const anchor = createComputed(() => Settings.anchorFor(Settings.side()))

    return (
        <window
            cssClasses={["drawer-launcher"]}
            namespace="hypr-drawer"
            anchor={anchor}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.ON_DEMAND}
            exclusivity={Astal.Exclusivity.NORMAL}
            visible={false}
            widthRequest={Settings.width}
            $={(self) => {
                const keyCtl = new Gtk.EventControllerKey()
                keyCtl.connect("key-pressed", (_c, key) => {
                    if (key === Gdk.KEY_Escape) closeDrawer()
                    return false
                })
                self.add_controller(keyCtl)
            }}
        >
            <box orientation={Gtk.Orientation.VERTICAL} spacing={6} cssClasses={["launcher-root"]}>
                <Header />
                <Gtk.Stack
                    visibleChildName={page}
                    transitionType={Gtk.StackTransitionType.SLIDE_LEFT_RIGHT}
                    transitionDuration={150}
                    hexpand
                    vexpand
                >
                    <LauncherPage results={results} />
                    <SettingsPage />
                </Gtk.Stack>
            </box>
        </window>
    )
}

function Header() {
    return (
        <box cssClasses={["launcher-header"]} spacing={6}>
            <label cssClasses={["launcher-title"]} label="Drawer" hexpand xalign={0} />
            <button
                cssClasses={["icon-button"]}
                tooltipText="Settings"
                onClicked={() => setPage(page() === "settings" ? "launcher" : "settings")}
            >
                <label cssClasses={["icon-glyph"]} label="⚙" />
            </button>
            <button
                cssClasses={["icon-button", "icon-button-close"]}
                tooltipText="Close drawer"
                onClicked={closeDrawer}
            >
                <label cssClasses={["icon-glyph"]} label="✕" />
            </button>
        </box>
    )
}

function LauncherPage(props: { results: ReturnType<typeof createComputed<AppEntry[]>> }) {
    return (
        <box
            $type="named"
            name="launcher"
            orientation={Gtk.Orientation.VERTICAL}
            spacing={8}
        >
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
                    <For each={props.results}>
                        {(app: AppEntry) => <AppTile app={app} onLaunch={launch} />}
                    </For>
                </box>
            </Gtk.ScrolledWindow>
            <label
                cssClasses={["launcher-hint"]}
                label="Drag → move into drawer · Shift+drag → new instance"
            />
        </box>
    )
}

function SettingsPage() {
    let hotkeyEntry: Gtk.Entry | null = null
    let statusLabel: Gtk.Label | null = null
    let widthSpin: Gtk.SpinButton | null = null
    let defaultWSpin: Gtk.SpinButton | null = null
    let defaultHSpin: Gtk.SpinButton | null = null

    function setStatus(msg: string) {
        if (statusLabel) statusLabel.label = msg
    }

    async function applyHotkey() {
        if (!hotkeyEntry) return
        const next = hotkeyEntry.text.trim()
        if (!next.includes(",")) {
            setStatus("Hotkey must look like 'SUPER CTRL, R'.")
            return
        }
        const previous = Settings.hotkey()
        await Hotkey.apply(previous, next)
        setStatus(`Hotkey set to ${next}.`)
    }

    function clearPositions() {
        Memory.clear()
        setStatus("Cleared saved window positions.")
    }

    async function resetAll() {
        const previousHotkey = Settings.hotkey()
        Settings.reset()
        // Push the (now-default) values back into the live SpinButton widgets
        // so the UI tracks the reset; createComputed-backed radios update on
        // their own.
        widthSpin?.set_value(Settings.width())
        defaultWSpin?.set_value(Settings.defaultW())
        defaultHSpin?.set_value(Settings.defaultH())
        if (hotkeyEntry) hotkeyEntry.text = Settings.hotkey()
        await Hotkey.apply(previousHotkey, Settings.hotkey())
        setStatus("Settings reset to defaults.")
    }

    return (
        <box
            $type="named"
            name="settings"
            orientation={Gtk.Orientation.VERTICAL}
            spacing={12}
            cssClasses={["settings-page"]}
        >
            <Gtk.ScrolledWindow hexpand vexpand>
                <box orientation={Gtk.Orientation.VERTICAL} spacing={12}>
                    <label cssClasses={["settings-section"]} label="Drawer side" xalign={0} />
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                        <SideRadio value="left" label="Left" />
                        <SideRadio value="right" label="Right" />
                        <SideRadio value="top" label="Top" />
                        <SideRadio value="bottom" label="Bottom" />
                    </box>

                    <label cssClasses={["settings-section"]} label="Rail size (px)" xalign={0} />
                    <Gtk.SpinButton
                        hexpand={false}
                        $={(self: Gtk.SpinButton) => {
                            widthSpin = self
                            self.set_range(200, 800)
                            self.set_increments(20, 100)
                            self.set_value(Settings.width())
                            self.connect("value-changed", (s) =>
                                Settings.setWidth(s.get_value_as_int()),
                            )
                        }}
                    />

                    <label
                        cssClasses={["settings-section"]}
                        label="Default window size (px)"
                        xalign={0}
                    />
                    <box orientation={Gtk.Orientation.HORIZONTAL} spacing={8}>
                        <label label="W" />
                        <Gtk.SpinButton
                            hexpand={false}
                            $={(self: Gtk.SpinButton) => {
                                defaultWSpin = self
                                self.set_range(120, 3840)
                                self.set_increments(20, 100)
                                self.set_value(Settings.defaultW())
                                self.connect("value-changed", (s) =>
                                    Settings.setDefaultW(s.get_value_as_int()),
                                )
                            }}
                        />
                        <label label="H" />
                        <Gtk.SpinButton
                            hexpand={false}
                            $={(self: Gtk.SpinButton) => {
                                defaultHSpin = self
                                self.set_range(120, 2160)
                                self.set_increments(20, 100)
                                self.set_value(Settings.defaultH())
                                self.connect("value-changed", (s) =>
                                    Settings.setDefaultH(s.get_value_as_int()),
                                )
                            }}
                        />
                    </box>

                    <label cssClasses={["settings-section"]} label="Toggle hotkey" xalign={0} />
                    <box orientation={Gtk.Orientation.HORIZONTAL} spacing={6}>
                        <entry
                            cssClasses={["launcher-search"]}
                            placeholderText="e.g. SUPER CTRL, R"
                            hexpand
                            $={(self: Gtk.Entry) => {
                                hotkeyEntry = self
                                self.text = Settings.hotkey()
                                self.connect("activate", () => {
                                    applyHotkey().catch(console.error)
                                })
                            }}
                        />
                        <button
                            cssClasses={["icon-button"]}
                            tooltipText="Apply hotkey"
                            onClicked={() => applyHotkey().catch(console.error)}
                        >
                            <label cssClasses={["icon-glyph"]} label="Apply" />
                        </button>
                    </box>
                    <label
                        cssClasses={["launcher-hint"]}
                        label='Format: "MODS, KEY" — modifiers separated by spaces. Press Enter or Apply.'
                        xalign={0}
                        wrap
                    />

                    <label cssClasses={["settings-section"]} label="Maintenance" xalign={0} />
                    <box orientation={Gtk.Orientation.HORIZONTAL} spacing={6}>
                        <button
                            cssClasses={["icon-button"]}
                            tooltipText="Forget every remembered window position"
                            onClicked={clearPositions}
                        >
                            <label cssClasses={["icon-glyph"]} label="Clear positions" />
                        </button>
                        <button
                            cssClasses={["icon-button"]}
                            tooltipText="Reset every setting to its default"
                            onClicked={() => resetAll().catch(console.error)}
                        >
                            <label cssClasses={["icon-glyph"]} label="Reset settings" />
                        </button>
                    </box>

                    <label
                        cssClasses={["launcher-hint"]}
                        label=""
                        xalign={0}
                        wrap
                        $={(self: Gtk.Label) => {
                            statusLabel = self
                        }}
                    />
                </box>
            </Gtk.ScrolledWindow>
        </box>
    )
}

function SideRadio(props: { value: Settings.DrawerSide; label: string }) {
    return (
        <Gtk.CheckButton
            label={props.label}
            active={createComputed(() => Settings.side() === props.value)}
            $={(self: Gtk.CheckButton) => {
                self.connect("toggled", () => {
                    if (self.get_active() && Settings.side() !== props.value) {
                        Settings.setSide(props.value)
                    }
                })
            }}
        />
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
