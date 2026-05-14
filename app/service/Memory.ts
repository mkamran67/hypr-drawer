import GLib from "gi://GLib"
import Gio from "gi://Gio"

export type Geometry = { x: number; y: number; w: number; h: number; monitor?: string }
export type Positions = Record<string, Geometry>

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
    return load()[cls]
}

export function clear(): void {
    save({})
}
