import { Astal, Gtk, Gdk } from "ags/gtk4"
import { createState, createComputed, For } from "ags"
import AppTile from "./AppTile"
import * as Apps from "../service/Apps"
import * as Hypr from "../service/Hypr"
import * as Settings from "../service/Settings"
import * as Memory from "../service/Memory"
import * as Hotkey from "../service/Hotkey"
import * as Usage from "../service/Usage"
import * as RailState from "../service/RailState"
import * as Shortcuts from "../service/Shortcuts"
import { AppEntry } from "../service/Apps"

const [query, setQuery] = createState("")
const [page, setPage] = createState<"launcher" | "settings">("launcher")
const [editingGrid, setEditingGrid] = createState(false)

function startGridEdit() {
    Settings.setViewMode("grid")
    setEditingGrid(true)
    setPage("launcher")
}

function finishGridEdit() {
    setEditingGrid(false)
}

// Called by app.ts before each show() to re-pin the rail to the user's chosen
// monitor (which can change at runtime when railMonitor is "focused"). The
// state itself lives in RailState so Layout can read it without importing this
// module — see the cycle note there.
export function setLauncherMonitor(mon: any): void {
    RailState.setRailMonitor(mon)
}

function closeDrawer() {
    const hide = (globalThis as any).__hyprDrawerHide
    if (typeof hide === "function") hide()
}

export default function Launcher() {
    const results = createComputed(() => {
        const q = query()
        if (q.trim()) return Apps.search(q).slice(0, 120)
        return Apps.browseList({
            favEnabled: Settings.favoritesEnabled(),
            recEnabled: Settings.recentsEnabled(),
            favorites: Usage.favorites(),
            counts: Usage.counts(),
        }).slice(0, 200)
    })
    const anchor = createComputed(() => Settings.anchorFor(Settings.side()))

    return (
        <window
            cssClasses={["drawer-launcher"]}
            namespace="hypr-drawer"
            gdkmonitor={RailState.railMonitor}
            anchor={anchor}
            layer={Astal.Layer.OVERLAY}
            keymode={Astal.Keymode.ON_DEMAND}
            exclusivity={Astal.Exclusivity.NORMAL}
            visible={false}
            widthRequest={Settings.width}
            $={(self) => {
                // Hand the live window to RailState so Layout.isOverRail can
                // measure the rail's real thickness instead of trusting
                // Settings.width(), which only describes the vertical sides.
                RailState.setRailWindow(self)
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

const VIEW_GLYPH: Record<Settings.ViewMode, string> = {
    tiles: "▤",
    grid: "▦",
    compact: "≡",
}

const VIEW_TOOLTIP: Record<Settings.ViewMode, string> = {
    tiles: "View: tiles · click for grid",
    grid: "View: grid · click for compact list",
    compact: "View: compact list · click for tiles",
}

function Header() {
    return (
        <box cssClasses={["launcher-header"]} spacing={6}>
            <label cssClasses={["launcher-title"]} label="Drawer" hexpand xalign={0} />
            <button
                cssClasses={["icon-button"]}
                tooltipText={createComputed(() => VIEW_TOOLTIP[Settings.viewMode()])}
                onClicked={() => Settings.cycleViewMode()}
            >
                <label
                    cssClasses={["icon-glyph"]}
                    label={createComputed(() => VIEW_GLYPH[Settings.viewMode()])}
                />
            </button>
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
    let searchEntry: Gtk.Entry | null = null

    function syncClearIcon(entry: Gtk.Entry) {
        // GTK4 Entry's secondary icon doubles as our clear-X. Hiding it when
        // the field is empty avoids a permanent dead glyph on the right.
        if (entry.text) {
            entry.set_icon_from_icon_name(
                Gtk.EntryIconPosition.SECONDARY,
                "edit-clear-symbolic",
            )
            entry.set_icon_tooltip_text(
                Gtk.EntryIconPosition.SECONDARY,
                "Clear search",
            )
            entry.set_icon_activatable(Gtk.EntryIconPosition.SECONDARY, true)
        } else {
            entry.set_icon_from_icon_name(Gtk.EntryIconPosition.SECONDARY, null)
        }
    }

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
                onChanged={(self) => {
                    setQuery(self.text)
                    syncClearIcon(self)
                }}
                onActivate={() => {
                    const first = Apps.search(query())[0]
                    if (first) launchSafe(first, 0)
                }}
                $={(self: Gtk.Entry) => {
                    searchEntry = self
                    self.connect("icon-press", (_e, pos: Gtk.EntryIconPosition) => {
                        if (pos !== Gtk.EntryIconPosition.SECONDARY) return
                        self.text = ""
                        setQuery("")
                        syncClearIcon(self)
                        self.grab_focus()
                    })
                }}
            />
            <Gtk.Revealer
                revealChild={createComputed(() => editingGrid())}
                transitionType={Gtk.RevealerTransitionType.SLIDE_DOWN}
                transitionDuration={150}
            >
                <box
                    cssClasses={["grid-edit-panel"]}
                    orientation={Gtk.Orientation.VERTICAL}
                    spacing={6}
                >
                    <label
                        cssClasses={["settings-section"]}
                        label="Columns"
                        xalign={0}
                    />
                    <Gtk.Scale
                        hexpand
                        drawValue
                        valuePos={Gtk.PositionType.RIGHT}
                        digits={0}
                        $={(self: Gtk.Scale) => {
                            self.set_range(2, 10)
                            self.set_increments(1, 1)
                            self.set_value(Settings.gridColumns())
                            for (let i = 2; i <= 10; i++) {
                                self.add_mark(i, Gtk.PositionType.BOTTOM, null)
                            }
                            self.connect("value-changed", (s) => {
                                const v = Math.round(s.get_value())
                                if (v !== Settings.gridColumns()) Settings.setGridColumns(v)
                            })
                        }}
                    />
                    <button
                        cssClasses={["icon-button"]}
                        hexpand={false}
                        halign={Gtk.Align.END}
                        onClicked={finishGridEdit}
                    >
                        <label cssClasses={["icon-glyph"]} label="Done" />
                    </button>
                </box>
            </Gtk.Revealer>
            <Gtk.ScrolledWindow
                hexpand
                vexpand
                hscrollbarPolicy={Gtk.PolicyType.NEVER}
            >
                <Gtk.Stack
                    visibleChildName={createComputed(() => Settings.viewMode())}
                    transitionType={Gtk.StackTransitionType.CROSSFADE}
                    transitionDuration={120}
                >
                    <box
                        $type="named"
                        name="tiles"
                        orientation={Gtk.Orientation.VERTICAL}
                        spacing={4}
                    >
                        <For each={props.results}>
                            {(app: AppEntry) => (
                                <AppTile app={app} onLaunch={launchSafe} mode="tiles" />
                            )}
                        </For>
                    </box>
                    <Gtk.FlowBox
                        $type="named"
                        name="grid"
                        homogeneous
                        valign={Gtk.Align.START}
                        selectionMode={Gtk.SelectionMode.NONE}
                        minChildrenPerLine={Settings.gridColumns}
                        maxChildrenPerLine={Settings.gridColumns}
                        rowSpacing={2}
                        columnSpacing={4}
                    >
                        <For each={props.results}>
                            {(app: AppEntry) => (
                                <AppTile app={app} onLaunch={launchSafe} mode="grid" />
                            )}
                        </For>
                    </Gtk.FlowBox>
                    <box
                        $type="named"
                        name="compact"
                        orientation={Gtk.Orientation.VERTICAL}
                        spacing={2}
                    >
                        <For each={props.results}>
                            {(app: AppEntry) => (
                                <AppTile app={app} onLaunch={launchSafe} mode="compact" />
                            )}
                        </For>
                    </box>
                </Gtk.Stack>
            </Gtk.ScrolledWindow>
            <ShortcutBar />
        </box>
    )
}

// Bottom strip of the rail. It shows the toggle hotkey the user actually has
// bound right now - which is the one thing a static hint line could never get
// right after a rebind - and parks the rest of the shortcut list in a tooltip
// so the rail stays uncluttered.
function ShortcutBar() {
    const tip = createComputed(() => Shortcuts.shortcutTooltip(Settings.hotkey()))
    return (
        <box
            cssClasses={["shortcut-bar"]}
            spacing={6}
            tooltipText={tip}
        >
            <label cssClasses={["shortcut-bar-glyph"]} label="⌨" />
            <label
                cssClasses={["shortcut-bar-keys"]}
                label={createComputed(() => Shortcuts.humanCombo(Settings.hotkey()))}
                hexpand
                xalign={0}
                ellipsize={3}
            />
            <label cssClasses={["shortcut-bar-more"]} label="shortcuts ⓘ" />
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

                    <label
                        cssClasses={["settings-section"]}
                        label="Grid view"
                        xalign={0}
                    />
                    <button
                        cssClasses={["icon-button"]}
                        hexpand={false}
                        halign={Gtk.Align.START}
                        tooltipText="Switch to the grid and tweak rows/columns live"
                        onClicked={() => startGridEdit()}
                    >
                        <label cssClasses={["icon-glyph"]} label="Edit grid view" />
                    </button>
                    <label
                        cssClasses={["launcher-hint"]}
                        label="Opens the grid with rows + columns sliders. Adjust live, then hit Done."
                        xalign={0}
                        wrap
                    />

                    <label cssClasses={["settings-section"]} label="Rail monitor" xalign={0} />
                    <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
                        <RailMonitorRadio value="focused" label="Follow focused monitor" />
                        <RailMonitorRadio value="primary" label="Primary monitor" />
                        <For each={createComputed(() => listMonitorOptions())}>
                            {(opt: MonitorOpt) => (
                                <RailMonitorRadio value={opt.index} label={opt.label} />
                            )}
                        </For>
                    </box>

                    <label cssClasses={["settings-section"]} label="Blur scope" xalign={0} />
                    <Gtk.CheckButton
                        label="Blur all monitors when drawer is open"
                        active={createComputed(() => Settings.blurAllMonitors())}
                        $={(self: Gtk.CheckButton) => {
                            self.connect("toggled", () => {
                                if (self.get_active() !== Settings.blurAllMonitors()) {
                                    Settings.setBlurAllMonitors(self.get_active())
                                }
                            })
                        }}
                    />
                    <label
                        cssClasses={["launcher-hint"]}
                        label="When on, the drawer opens on every monitor and apps can live on any of them. When off, only the focused monitor blurs and apps stay there."
                        xalign={0}
                        wrap
                    />

                    <label cssClasses={["settings-section"]} label="Suggestions" xalign={0} />
                    <Gtk.CheckButton
                        label="Enable favorites (pinned to top)"
                        active={createComputed(() => Settings.favoritesEnabled())}
                        $={(self: Gtk.CheckButton) => {
                            self.connect("toggled", () => {
                                if (self.get_active() !== Settings.favoritesEnabled()) {
                                    Settings.setFavoritesEnabled(self.get_active())
                                }
                            })
                        }}
                    />
                    <Gtk.CheckButton
                        label="Enable most-used (sort by launch frequency)"
                        active={createComputed(() => Settings.recentsEnabled())}
                        $={(self: Gtk.CheckButton) => {
                            self.connect("toggled", () => {
                                if (self.get_active() !== Settings.recentsEnabled()) {
                                    Settings.setRecentsEnabled(self.get_active())
                                }
                            })
                        }}
                    />
                    <label
                        cssClasses={["launcher-hint"]}
                        label="Right-click any app to toggle it as a favorite. Most-used reorders the rest of the list by how often you've launched each app from the drawer."
                        xalign={0}
                        wrap
                    />

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

type MonitorOpt = { index: number; label: string }

function listMonitorOptions(): MonitorOpt[] {
    const display = Gdk.Display.get_default()
    const monitors: any = display?.get_monitors?.()
    const count = monitors?.get_n_items?.() ?? 0
    const out: MonitorOpt[] = []
    for (let i = 0; i < count; i++) {
        const m: any = monitors.get_item(i)
        const name = m?.get_connector?.() || `monitor-${i}`
        out.push({ index: i, label: `${name} (${i})` })
    }
    return out
}

function RailMonitorRadio(props: { value: Settings.RailMonitor; label: string }) {
    return (
        <Gtk.CheckButton
            label={props.label}
            active={createComputed(() => Settings.railMonitor() === props.value)}
            $={(self: Gtk.CheckButton) => {
                self.connect("toggled", () => {
                    if (self.get_active() && Settings.railMonitor() !== props.value) {
                        Settings.setRailMonitor(props.value)
                    }
                })
            }}
        />
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

// Every launch entry point goes through here. `launch` is async and none of
// its call sites can await it, so without this an adoption or spawn failure
// became an unhandled rejection with nothing in daemon.log - the click simply
// appeared to do nothing.
function launchSafe(app: AppEntry, modifiers: number): void {
    launch(app, modifiers).catch((e) => console.error("launch:", app.desktopId, e))
}

async function launch(app: AppEntry, modifiers: number) {
    Usage.recordLaunch(app.desktopId)
    const forceNew = !!(modifiers & (Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.CONTROL_MASK))

    // Per-monitor drawer specials: launched apps go into the focused
    // monitor's `special:drawer-<name>` workspace, so they hide-away with
    // the drawer toggle and never get caught in a single-instance special
    // migration race.
    const targetMon = Hypr.focusedMonitor()

    const track = (addr: string) => {
        const fn = (globalThis as any).__hyprDrawerTrack
        if (typeof fn === "function") try { fn(addr) } catch (e) { console.error(e) }
    }
    const refresh = () => {
        const fn = (globalThis as any).__hyprDrawerRefresh
        if (typeof fn === "function") try { fn() } catch (e) { console.error(e) }
    }

    if (!forceNew) {
        const existing = Hypr.findForApp(app.matchKeys)
        if (existing) {
            track(existing.address)
            if (!targetMon) {
                // No focused monitor means nothing to move the window into.
                // Rare, but it used to return here in silence, which is
                // indistinguishable from the click never registering.
                console.error("launch: no focused monitor, cannot adopt", app.desktopId)
                refresh()
                return
            }
            if (existing.workspace?.name === Hypr.fullSpecialNameFor(targetMon.name)) {
                // The window is already exactly where a move would put it, so
                // moving it again would be invisible. Focus it instead.
                await Hypr.focusWindow(existing.address)
            } else {
                await Hypr.moveToSpecialOn(existing.address, targetMon.name)
            }
            await Hypr.setFloating(existing.address)
            refresh()
            return
        }
    }

    const before = new Set(Hypr.clients().map((c) => c.address))
    if (targetMon) {
        await Hypr.spawnInSpecialOn(app.exec, targetMon.name)
    } else {
        await Hypr.dispatch({ kind: "spawnFloating", exec: app.exec })
    }
    // Some apps (e.g. Rust/Tauri) ignore the spawn-time `[float]`
    // dispatcher and come up tiled. Wait for the window to appear and
    // force float so it's actually resizable inside the drawer.
    const fresh = await Hypr.awaitNewWindow(app.matchKeys, before)
    if (fresh) {
        track(fresh.address)
        await Hypr.setFloating(fresh.address)
    }
    refresh()
}
