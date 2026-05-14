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
    let statusLabel: Gtk.Label | null = null
    let widthSpin: Gtk.SpinButton | null = null
    let defaultWSpin: Gtk.SpinButton | null = null
    let defaultHSpin: Gtk.SpinButton | null = null
    let captureButton: Gtk.Button | null = null
    let captureLabel: Gtk.Label | null = null
    let saveButton: Gtk.Button | null = null

    // Pending hotkey is the value displayed on the capture button — only
    // committed to disk + applied to Hyprland when the user clicks Save.
    let pendingHotkey = Settings.hotkey()
    let capturing = false

    function setStatus(msg: string) {
        if (statusLabel) statusLabel.label = msg
    }

    function refreshCaptureUi() {
        if (captureLabel) {
            captureLabel.label = capturing ? "Press keys…" : pendingHotkey || "Click to capture"
        }
        if (captureButton) {
            const cls = capturing
                ? ["icon-button", "hotkey-capture", "capturing"]
                : ["icon-button", "hotkey-capture"]
            captureButton.set_css_classes(cls)
        }
        if (saveButton) {
            saveButton.sensitive = !!pendingHotkey && pendingHotkey !== Settings.hotkey()
        }
    }

    function isModifierOnly(keyval: number): boolean {
        return (
            keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R ||
            keyval === Gdk.KEY_Shift_L   || keyval === Gdk.KEY_Shift_R   ||
            keyval === Gdk.KEY_Alt_L     || keyval === Gdk.KEY_Alt_R     ||
            keyval === Gdk.KEY_Super_L   || keyval === Gdk.KEY_Super_R   ||
            keyval === Gdk.KEY_Meta_L    || keyval === Gdk.KEY_Meta_R    ||
            keyval === Gdk.KEY_Hyper_L   || keyval === Gdk.KEY_Hyper_R
        )
    }

    function formatCombo(state: number, keyval: number): string {
        const M = Gdk.ModifierType
        const mods: string[] = []
        if (state & M.SUPER_MASK)   mods.push("SUPER")
        if (state & M.CONTROL_MASK) mods.push("CTRL")
        if (state & M.ALT_MASK)     mods.push("ALT")
        if (state & M.SHIFT_MASK)   mods.push("SHIFT")
        if (state & M.META_MASK)    mods.push("META")
        let name = Gdk.keyval_name(keyval) ?? ""
        // Keyvals 0x1008FF00–0x1008FFFF are the "XFree86 vendor" keysym block
        // (multimedia / launch / extra-function keys). GTK reports the short
        // tail of the name (e.g. "Launch5"), but Hyprland matches the full
        // "XF86Launch5" form — so the bind misses unless we re-add the prefix.
        if (
            keyval >= 0x1008ff00 &&
            keyval <= 0x1008ffff &&
            name &&
            !name.startsWith("XF86")
        ) {
            name = `XF86${name}`
        }
        return `${mods.join(" ")}, ${name}`
    }

    function startCapture() {
        capturing = true
        refreshCaptureUi()
        captureButton?.grab_focus()
        setStatus("Listening for your new hotkey — press Escape to cancel.")
    }

    function clearPositions() {
        Memory.clear()
        setStatus("Cleared saved window positions.")
    }

    async function saveHotkey() {
        if (!pendingHotkey || pendingHotkey === Settings.hotkey()) return
        const previous = Settings.hotkey()
        await Hotkey.apply(previous, pendingHotkey)
        setStatus(`Hotkey set to ${pendingHotkey}.`)
        refreshCaptureUi()
    }

    async function resetAll() {
        const previousHotkey = Settings.hotkey()
        Settings.reset()
        widthSpin?.set_value(Settings.width())
        defaultWSpin?.set_value(Settings.defaultW())
        defaultHSpin?.set_value(Settings.defaultH())
        pendingHotkey = Settings.hotkey()
        capturing = false
        refreshCaptureUi()
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
                        <button
                            cssClasses={["icon-button", "hotkey-capture"]}
                            hexpand
                            tooltipText="Click, then press the new combo"
                            onClicked={() => startCapture()}
                            $={(self: Gtk.Button) => {
                                captureButton = self
                                const keyCtl = new Gtk.EventControllerKey()
                                // CAPTURE phase so we win over the launcher
                                // window's Escape→close handler while
                                // we're listening for a new combo.
                                keyCtl.propagationPhase = Gtk.PropagationPhase.CAPTURE
                                keyCtl.connect(
                                    "key-pressed",
                                    (_c, keyval: number, keycode: number, state: number) => {
                                        if (!capturing) return false
                                        if (keyval === Gdk.KEY_Escape) {
                                            capturing = false
                                            refreshCaptureUi()
                                            setStatus("Capture cancelled.")
                                            return true
                                        }
                                        if (isModifierOnly(keyval)) return true
                                        const name = Gdk.keyval_name(keyval)
                                        const hex = "0x" + keyval.toString(16)
                                        console.log(
                                            `hotkey capture: keyval=${hex} ` +
                                            `keycode=${keycode} name=${name}`,
                                        )
                                        if (!name) {
                                            setStatus(
                                                `Captured key has no keysym name ` +
                                                `(keyval=${hex}, keycode=${keycode}). ` +
                                                `Hyprland can't bind it by name — try a ` +
                                                `different key.`,
                                            )
                                            capturing = false
                                            refreshCaptureUi()
                                            return true
                                        }
                                        pendingHotkey = formatCombo(state, keyval)
                                        capturing = false
                                        refreshCaptureUi()
                                        setStatus(
                                            `Captured ${pendingHotkey} ` +
                                            `(keyval=${hex}, keycode=${keycode}). ` +
                                            `Click Save to apply.`,
                                        )
                                        return true
                                    },
                                )
                                self.add_controller(keyCtl)
                            }}
                        >
                            <label
                                cssClasses={["icon-glyph"]}
                                label={Settings.hotkey() || "Click to capture"}
                                $={(self: Gtk.Label) => {
                                    captureLabel = self
                                }}
                            />
                        </button>
                        <button
                            cssClasses={["icon-button"]}
                            tooltipText="Save the captured hotkey"
                            onClicked={() => saveHotkey().catch(console.error)}
                            $={(self: Gtk.Button) => {
                                saveButton = self
                                self.sensitive = false
                            }}
                        >
                            <label cssClasses={["icon-glyph"]} label="Save" />
                        </button>
                    </box>
                    <label
                        cssClasses={["launcher-hint"]}
                        label="Click the field, press the combo you want, then Save."
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
