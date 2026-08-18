// Matching a launcher entry to the window it belongs to.
//
// The drawer's headline feature is "click an app that is already running and
// it comes to you". That needs an identity for the app that survives the trip
// from a .desktop file to a Hyprland window class, and the two spellings agree
// far less often than they look like they should:
//
//   - `StartupWMClass` is optional, and roughly a quarter of the entries on a
//     normal system omit it.
//   - Gio's fallback, `get_executable()`, is frequently an ABSOLUTE PATH.
//     Docker Desktop is the canonical case: no StartupWMClass, and
//     `Exec=/opt/docker-desktop/bin/docker-desktop` against a window class of
//     plain `docker-desktop`.
//   - Desktop ids are often reverse-DNS (`dev.zed.Zed`) where the class may be
//     either the full id or just the last segment.
//   - Some apps append a channel to the binary but not the class
//     (`google-chrome-stable` vs `google-chrome`).
//
// So an entry gets a LIST of candidate keys, best first, and a client is
// scored against all of them. Everything here is pure: this module imports
// nothing from gi:// or ags/ so `packaging/test-match.ts` can run it under
// plain node, the same rule Dispatch.ts follows.
//
// PID correlation deliberately plays no part. It looks like the rigorous
// answer and isn't: Docker Desktop's window process reports
// `/proc/<pid>/exe = /opt/docker-desktop/Docker Desktop`, which is not the
// path its own .desktop file execs.

export type DesktopFields = {
    startupWmClass?: string | null
    // Gio's get_executable(). Routinely an absolute path.
    executable?: string | null
    // e.g. "dev.zed.Zed.desktop"
    desktopId?: string | null
    name?: string | null
}

// Structural subset of Hypr.Client. `initialClass` and `focusHistoryID` are
// both in hyprctl's JSON; this module only needs these five fields, and taking
// a structural type rather than importing Hypr.Client is what keeps it free of
// gi:// imports.
export type ClientLike = {
    address: string
    class?: string
    initialClass?: string
    workspace?: { name?: string }
    focusHistoryID?: number
}

// Reduce one raw candidate to a comparable key, or "" if it can't be one.
// Taking the basename is the whole fix for the Docker Desktop bug.
function normalize(raw: string | null | undefined): string {
    if (!raw) return ""
    let s = raw.trim().toLowerCase()
    // A leftover Exec field code (%U, %F, ...) is not an identity.
    if (!s || s.startsWith("%")) return ""
    const slash = s.lastIndexOf("/")
    if (slash >= 0) s = s.slice(slash + 1)
    s = s.replace(/\s+/g, "-")
    // A trailing slash leaves an empty basename; anything still holding a
    // slash was never a class name to begin with.
    if (!s || s.includes("/")) return ""
    return s
}

// Ordered, deduped identity keys for one desktop entry, best first. Order
// matters: `scoreClient` applies a small penalty per position, so an equally
// strong match on an earlier key wins.
export function identKeys(f: DesktopFields): string[] {
    const out: string[] = []
    const push = (raw: string | null | undefined) => {
        const k = normalize(raw)
        if (k && !out.includes(k)) out.push(k)
    }

    // 1. The one field that exists precisely to answer this question.
    push(f.startupWmClass)

    // 2. The desktop id, which is what most toolkits set the class from.
    const id = normalize(f.desktopId).replace(/\.desktop$/, "")
    push(id)

    // 3. The binary's basename.
    push(f.executable)

    // 4. The last segment of a reverse-DNS id, for apps whose class is the
    //    short name (`com.shellyorg.shelly` -> `shelly`). Guarded to genuine
    //    reverse-DNS ids so a hyphenated name is never chopped.
    const segs = id.split(".")
    if (segs.length >= 3 && segs[segs.length - 1].length >= 3) {
        push(segs[segs.length - 1])
    }

    // 5. The display name, as a last resort.
    push(f.name)

    return out
}

// Tiers are 200 apart so the two penalties below (50 + 50 at most) can never
// let a weaker tier overtake a stronger one.
export const TIER_EXACT = 1000
export const TIER_BOUNDARY = 800
export const TIER_CONTAINS = 600
export const TIER_REVERSE = 400

// A match on `initialClass` is real but weaker than one on the live `class`:
// an app that rewrites its class at runtime should still be found, but a
// window currently advertising the class wins.
export const INITIAL_PENALTY = 50
// Per candidate-key position, so an equal-tier match on `StartupWMClass`
// beats one on the display name.
export const KEY_RANK_PENALTY = 10
const MAX_RANKED_KEYS = 5

const SEPS = new Set(["-", ".", "_"])
// Both sides must be at least this long before any non-exact tier applies.
// Without it, three-letter keys like "zed" match half the window list.
const MIN_FUZZY = 4

// Interpreters, wrappers and sandboxes. These turn up as the basename of an
// Exec line (`java-java17-openjdk.desktop` execs `.../bin/java`) and would
// otherwise substring-match every window whose class happens to contain them.
// Exact matches still count - a window really classed `java` is a java window.
const GENERIC = new Set([
    "sh", "bash", "zsh", "fish", "env", "exec",
    "python", "python2", "python3", "perl", "ruby",
    "node", "nodejs", "electron",
    "java", "javaw", "mono", "dotnet",
    "wine", "wine64", "flatpak", "snap", "gjs",
    "xterm", "xdg-open", "sudo", "pkexec", "open",
])

// True when `b` starts with `a` and the very next character is a separator, so
// `google-chrome` matches `google-chrome-stable` but `zed` does not match
// `zedit`. This is the tier that makes channel suffixes work.
function boundaryPrefix(a: string, b: string): boolean {
    return b.length > a.length && b.startsWith(a) && SEPS.has(b[a.length])
}

function tierFor(key: string, have: string): number {
    if (!key || !have) return 0
    if (have === key) return TIER_EXACT
    if (key.length < MIN_FUZZY || have.length < MIN_FUZZY) return 0
    if (GENERIC.has(key)) return 0
    if (boundaryPrefix(key, have) || boundaryPrefix(have, key)) return TIER_BOUNDARY
    if (have.includes(key)) return TIER_CONTAINS
    // The leg the old Hypr.findByClass was missing, and the reason a
    // path-shaped key could never find its window.
    if (key.includes(have)) return TIER_REVERSE
    return 0
}

// 0 means "not this app". There is no separate threshold constant.
export function scoreClient(keys: readonly string[], c: ClientLike): number {
    const live = (c.class || "").toLowerCase()
    const initial = (c.initialClass || "").toLowerCase()
    let best = 0
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i]
        const rank = Math.min(i, MAX_RANKED_KEYS) * KEY_RANK_PENALTY
        const onLive = tierFor(key, live)
        if (onLive > 0) best = Math.max(best, onLive - rank)
        if (initial && initial !== live) {
            const onInitial = tierFor(key, initial)
            if (onInitial > 0) best = Math.max(best, onInitial - INITIAL_PENALTY - rank)
        }
    }
    return best
}

export type PickOpts<C extends ClientLike> = {
    // Addresses to skip. awaitNewWindow passes the pre-spawn address set so a
    // window that already existed can't be mistaken for the one just launched.
    exclude?: ReadonlySet<string>
    // Equal-score tie-break loser. Hypr passes "already in a drawer special":
    // when an app has one window in the drawer and one outside, the user is
    // looking at the one outside, so that is the one to pull in.
    deprioritize?: (c: C) => boolean
}

export function pickClient<C extends ClientLike>(
    keys: readonly string[],
    clients: readonly C[],
    opts: PickOpts<C> = {},
): C | undefined {
    let best: C | undefined
    let bestScore = 0
    let bestDeprio = false

    for (const c of clients) {
        if (opts.exclude?.has(c.address)) continue
        const score = scoreClient(keys, c)
        if (score <= 0) continue
        const deprio = opts.deprioritize?.(c) ?? false

        if (best === undefined) {
            best = c
            bestScore = score
            bestDeprio = deprio
            continue
        }
        if (score !== bestScore) {
            if (score > bestScore) {
                best = c
                bestScore = score
                bestDeprio = deprio
            }
            continue
        }
        if (deprio !== bestDeprio) {
            if (!deprio) {
                best = c
                bestDeprio = deprio
            }
            continue
        }
        // Lower focusHistoryID is more recently focused; 0 is the focused
        // window. An absent id sorts last.
        const fh = c.focusHistoryID ?? Number.MAX_SAFE_INTEGER
        const bestFh = best.focusHistoryID ?? Number.MAX_SAFE_INTEGER
        if (fh < bestFh) best = c
    }

    return best
}

// Fuzzy key comparison for the on-disk positions.json key space, where the
// same app may have been recorded under an old spelling. Shared with Memory.ts
// so the runtime class space and the saved key space can never drift apart the
// way findByClass and matchClass did.
export function keyMatches(want: string, have: string): boolean {
    return have === want || have.includes(want) || want.includes(have)
}
