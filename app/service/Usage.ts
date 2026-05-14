import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { createState } from "ags"

// Persistent record of how often each app has been launched from the drawer
// and which apps the user has pinned as favorites. Keyed by desktopId so it
// survives app renames in /usr/share/applications and stays stable.

export type UsageData = {
    counts: Record<string, number>
    favorites: string[]
}

const STATE_DIR = `${GLib.get_user_state_dir()}/hypr-drawer`
const FILE = `${STATE_DIR}/usage.json`

function loadFromDisk(): UsageData {
    const file = Gio.File.new_for_path(FILE)
    if (!file.query_exists(null)) return { counts: {}, favorites: [] }
    try {
        const [, contents] = file.load_contents(null)
        const parsed = JSON.parse(new TextDecoder().decode(contents)) as Partial<UsageData>
        return {
            counts: parsed.counts ?? {},
            favorites: parsed.favorites ?? [],
        }
    } catch {
        return { counts: {}, favorites: [] }
    }
}

function saveToDisk(data: UsageData): void {
    GLib.mkdir_with_parents(STATE_DIR, 0o755)
    const file = Gio.File.new_for_path(FILE)
    const enc = new TextEncoder().encode(JSON.stringify(data, null, 2))
    file.replace_contents(enc, null, false, Gio.FileCreateFlags.NONE, null)
}

const initial = loadFromDisk()

export const [counts, setCountsState] = createState<Record<string, number>>(initial.counts)
export const [favorites, setFavoritesState] = createState<string[]>(initial.favorites)

function persist(): void {
    saveToDisk({ counts: counts(), favorites: favorites() })
}

export function recordLaunch(desktopId: string): void {
    if (!desktopId) return
    const next = { ...counts() }
    next[desktopId] = (next[desktopId] ?? 0) + 1
    setCountsState(next)
    persist()
}

export function toggleFavorite(desktopId: string): void {
    if (!desktopId) return
    const list = favorites()
    const next = list.includes(desktopId)
        ? list.filter((id) => id !== desktopId)
        : [...list, desktopId]
    setFavoritesState(next)
    persist()
}

export function isFavorite(desktopId: string): boolean {
    return favorites().includes(desktopId)
}

export function count(desktopId: string): number {
    return counts()[desktopId] ?? 0
}
