import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { Astal } from "ags/gtk4"
import { createState } from "ags"

export type DrawerSide = "left" | "right" | "top" | "bottom"

// "focused": follow whichever monitor Hyprland reports as focused at toggle time.
// "primary": first monitor in the GDK list (stable across focus changes).
// number:    explicit index into the GDK monitor list.
export type RailMonitor = "focused" | "primary" | number

export type Settings = {
    side: DrawerSide
    width: number
    defaultW: number
    defaultH: number
    hotkey: string
    railMonitor: RailMonitor
    blurAllMonitors: boolean
}

export const DEFAULTS: Settings = {
    side: "left",
    width: 360,
    defaultW: 720,
    defaultH: 480,
    hotkey: "SUPER CTRL, R",
    railMonitor: "focused",
    blurAllMonitors: false,
}

const STATE_DIR = `${GLib.get_user_state_dir()}/hypr-drawer`
const FILE = `${STATE_DIR}/settings.json`

function loadFromDisk(): Settings {
    const file = Gio.File.new_for_path(FILE)
    if (!file.query_exists(null)) return { ...DEFAULTS }
    try {
        const [, contents] = file.load_contents(null)
        const parsed = JSON.parse(new TextDecoder().decode(contents)) as Partial<Settings>
        return { ...DEFAULTS, ...parsed }
    } catch {
        return { ...DEFAULTS }
    }
}

function saveToDisk(s: Settings): void {
    GLib.mkdir_with_parents(STATE_DIR, 0o755)
    const file = Gio.File.new_for_path(FILE)
    const data = new TextEncoder().encode(JSON.stringify(s, null, 2))
    file.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null)
}

const initial = loadFromDisk()

export const [side, setSideState] = createState<DrawerSide>(initial.side)
export const [width, setWidthState] = createState<number>(initial.width)
export const [defaultW, setDefaultWState] = createState<number>(initial.defaultW)
export const [defaultH, setDefaultHState] = createState<number>(initial.defaultH)
export const [hotkey, setHotkeyState] = createState<string>(initial.hotkey)
export const [railMonitor, setRailMonitorState] = createState<RailMonitor>(initial.railMonitor)
export const [blurAllMonitors, setBlurAllMonitorsState] = createState<boolean>(initial.blurAllMonitors)

function snapshot(): Settings {
    return {
        side: side(),
        width: width(),
        defaultW: defaultW(),
        defaultH: defaultH(),
        hotkey: hotkey(),
        railMonitor: railMonitor(),
        blurAllMonitors: blurAllMonitors(),
    }
}

export function setSide(next: DrawerSide): void {
    setSideState(next)
    saveToDisk({ ...snapshot(), side: next })
}

export function setWidth(next: number): void {
    setWidthState(next)
    saveToDisk({ ...snapshot(), width: next })
}

export function setDefaultW(next: number): void {
    setDefaultWState(next)
    saveToDisk({ ...snapshot(), defaultW: next })
}

export function setDefaultH(next: number): void {
    setDefaultHState(next)
    saveToDisk({ ...snapshot(), defaultH: next })
}

export function setHotkey(next: string): void {
    setHotkeyState(next)
    saveToDisk({ ...snapshot(), hotkey: next })
}

export function setRailMonitor(next: RailMonitor): void {
    setRailMonitorState(next)
    saveToDisk({ ...snapshot(), railMonitor: next })
}

export function setBlurAllMonitors(next: boolean): void {
    setBlurAllMonitorsState(next)
    saveToDisk({ ...snapshot(), blurAllMonitors: next })
}

// Reset everything back to DEFAULTS. Caller is responsible for any side
// effects that need to fire (e.g. reapplying the Hyprland keybind), since
// this module only owns the persisted values.
export function reset(): void {
    setSideState(DEFAULTS.side)
    setWidthState(DEFAULTS.width)
    setDefaultWState(DEFAULTS.defaultW)
    setDefaultHState(DEFAULTS.defaultH)
    setHotkeyState(DEFAULTS.hotkey)
    setRailMonitorState(DEFAULTS.railMonitor)
    setBlurAllMonitorsState(DEFAULTS.blurAllMonitors)
    saveToDisk({ ...DEFAULTS })
}

// Translate a DrawerSide into the Astal anchor bitmask. Vertical sides pin
// the rail to one edge and stretch top→bottom; horizontal sides pin to a
// horizontal edge and stretch left→right.
export function anchorFor(s: DrawerSide): number {
    const A = Astal.WindowAnchor
    switch (s) {
        case "left":   return A.LEFT  | A.TOP    | A.BOTTOM
        case "right":  return A.RIGHT | A.TOP    | A.BOTTOM
        case "top":    return A.TOP   | A.LEFT   | A.RIGHT
        case "bottom": return A.BOTTOM | A.LEFT  | A.RIGHT
    }
}

export function isVertical(s: DrawerSide): boolean {
    return s === "left" || s === "right"
}
