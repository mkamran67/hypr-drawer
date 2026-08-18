import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { keyMatches } from "./Match"

// `x`/`y` are GLOBAL layout coordinates — they are written straight from a
// client's `.at`, which hyprctl reports in global space (see the invariant in
// Hypr.ts). `monitor` is a connector name (e.g. "DP-2"); older files hold a
// stringified Hyprland monitor id instead, which Spawn.resolveTargetMonitor
// still reads as a fallback. No migration is needed either way.
export type Geometry = { x: number; y: number; w: number; h: number; monitor?: string }
export type Positions = Record<string, Geometry>

// This map has historically been keyed two different ways: writers used the
// runtime Hyprland window class, readers used the desktop-derived wmClass
// (StartupWMClass, falling back to the executable or even the display name).
// Those agree only when a .desktop file declares a StartupWMClass matching the
// real window class — so for Electron apps, flatpaks and anything without the
// key, saved geometry was written under one name and looked up under another
// and never found again.
//
// Writers now record the desktop-derived key where one is known. `get` keeps a
// tolerant read for orphan windows (adopted from outside the drawer, so no
// AppEntry exists) and for entries written before this change. `keyMatches`
// lives in Match.ts, shared with the runtime class matching, so the two key
// spaces can never drift apart again.
//
// It also carries the compatibility for the day AppEntry.wmClass stopped being
// a raw executable path: a file holding "/opt/docker-desktop/bin/docker-desktop"
// is still found by the key "docker-desktop".

const STATE_DIR = `${GLib.get_user_state_dir()}/hypr-drawer`
const STATE_FILE = `${STATE_DIR}/positions.json`

function ensureDir() {
    GLib.mkdir_with_parents(STATE_DIR, 0o755)
}

export function load(): Positions {
    ensureDir()
    const file = Gio.File.new_for_path(STATE_FILE)
    if (!file.query_exists(null)) return {}
    try {
        const [, contents] = file.load_contents(null)
        const text = new TextDecoder().decode(contents)
        return JSON.parse(text) as Positions
    } catch {
        return {}
    }
}

export function save(positions: Positions): void {
    ensureDir()
    const file = Gio.File.new_for_path(STATE_FILE)
    const data = new TextEncoder().encode(JSON.stringify(positions, null, 2))
    file.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null)
}

export function update(cls: string, geom: Geometry): void {
    const all = load()
    all[cls] = geom
    save(all)
}

export function get(cls: string): Geometry | undefined {
    const all = load()

    // An exact hit always wins — the fuzzy pass below must never override it.
    const exact = all[cls]
    if (exact) return exact

    // Substring matching on keys shorter than 3 chars would pair up half the
    // file, so don't attempt it.
    const want = cls.toLowerCase()
    if (want.length < 3) return undefined

    // Longest candidate wins: "google-chrome" is a better answer for
    // "google-chrome-stable" than a bare "chrome" entry would be.
    let best: string | undefined
    for (const have of Object.keys(all)) {
        if (have.length < 3) continue
        if (!keyMatches(want, have.toLowerCase())) continue
        if (best === undefined || have.length > best.length) best = have
    }
    return best !== undefined ? all[best] : undefined
}

export function clear(): void {
    save({})
}
