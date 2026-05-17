import Gio from "gi://Gio"

export type AppEntry = {
    name: string
    icon: string
    exec: string
    desktopId: string
    wmClass: string
}

// Desktop Entry field codes (freedesktop spec). `get_commandline()` returns
// the raw Exec line including these, but we hand the string to `hyprctl
// dispatch exec`, which runs it via /bin/sh -c — no field-code expansion.
// Unsubstituted `%U` / `%F` then reach the app as literal argv and break
// some launchers (Nautilus rejects `%U` as a bad URI and exits).
const FIELD_CODES = new Set([
    "%f", "%F", "%u", "%U", "%d", "%D",
    "%n", "%N", "%i", "%c", "%k", "%v", "%m",
])

function stripFieldCodes(cmd: string): string {
    return cmd.split(/\s+/).filter((t) => t && !FIELD_CODES.has(t)).join(" ")
}

function toEntry(info: Gio.DesktopAppInfo): AppEntry {
    const icon = info.get_string("Icon") || "application-x-executable"
    const wmClass =
        info.get_startup_wm_class() ||
        info.get_executable() ||
        info.get_name() ||
        ""
    return {
        name: info.get_name() || info.get_id() || "(unknown)",
        icon,
        exec: stripFieldCodes(info.get_commandline() || info.get_executable() || ""),
        desktopId: info.get_id() || "",
        wmClass: wmClass.toLowerCase(),
    }
}

function allDesktop(): Gio.DesktopAppInfo[] {
    return (Gio.AppInfo.get_all() as unknown as Gio.AppInfo[])
        .filter((a) => a instanceof Gio.DesktopAppInfo)
        .map((a) => a as unknown as Gio.DesktopAppInfo)
        .filter((a) => a.should_show())
}

export function list(): AppEntry[] {
    return allDesktop()
        .map(toEntry)
        .sort((a, b) => a.name.localeCompare(b.name))
}

// Lightweight fuzzy match: every query char appears in order in the haystack.
// Score = lower is better; a prefix match beats a scattered one.
function fuzzyScore(query: string, hay: string): number {
    if (!query) return 0
    const q = query.toLowerCase()
    const h = hay.toLowerCase()
    if (h.startsWith(q)) return -1000 + h.length
    let qi = 0
    let firstHit = -1
    let gaps = 0
    let lastIdx = -1
    for (let i = 0; i < h.length && qi < q.length; i++) {
        if (h[i] === q[qi]) {
            if (firstHit < 0) firstHit = i
            if (lastIdx >= 0) gaps += i - lastIdx - 1
            lastIdx = i
            qi++
        }
    }
    if (qi < q.length) return Infinity
    return firstHit + gaps * 2 + h.length * 0.01
}

export function search(query: string): AppEntry[] {
    const all = list()
    if (!query.trim()) return all
    return all
        .map((a) => ({ a, s: Math.min(fuzzyScore(query, a.name), fuzzyScore(query, a.desktopId)) }))
        .filter((r) => r.s !== Infinity)
        .sort((x, y) => x.s - y.s)
        .map((r) => r.a)
}

// Browse-mode sort used when the search box is empty. With both flags off it
// reduces to the original alphabetical list. With favorites on, pinned apps
// float to the top in the order the user added them. With recents on, the
// rest are ordered by launch count (alphabetical tie-breaker) instead of
// pure alphabetical.
export function browseList(opts: {
    favEnabled: boolean
    recEnabled: boolean
    favorites: string[]
    counts: Record<string, number>
}): AppEntry[] {
    const all = list()
    const favSet = opts.favEnabled ? new Set(opts.favorites) : new Set<string>()
    const favOrder = opts.favEnabled
        ? new Map(opts.favorites.map((id, i) => [id, i]))
        : new Map<string, number>()

    const favs: AppEntry[] = []
    const rest: AppEntry[] = []
    for (const a of all) {
        if (favSet.has(a.desktopId)) favs.push(a)
        else rest.push(a)
    }
    favs.sort((x, y) => (favOrder.get(x.desktopId)! - favOrder.get(y.desktopId)!))

    if (opts.recEnabled) {
        rest.sort((x, y) => {
            const cx = opts.counts[x.desktopId] ?? 0
            const cy = opts.counts[y.desktopId] ?? 0
            if (cx !== cy) return cy - cx
            return x.name.localeCompare(y.name)
        })
    }
    return [...favs, ...rest]
}

