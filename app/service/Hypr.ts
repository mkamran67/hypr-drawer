import { execAsync, exec } from "ags/process"
import GLib from "gi://GLib"
import { serialize, type Action } from "./Dispatch"
import * as Match from "./Match"
import { provider } from "./Provider"

// ---------------------------------------------------------------------------
// COORDINATE SPACE INVARIANT
//
// Anything handed to, or read from, a hyprctl dispatcher is in GLOBAL layout
// space. That covers `cursorpos`, a client's `.at`, and the integers fed to
// `movewindowpixel exact` / `resizewindowpixel exact`.
//
// Proven against Hyprland v0.56.0 and re-confirmed on hardware 2026-07-29:
// `Compositor.cpp:869-871` takes the literal integers for `exact` with no
// `relativeTo` added, and `relativeTo` is `position(GEOMETRIC_GOAL)` — the
// same accessor `hyprctl clients -j .at` reports. A scratch window on a
// monitor with origin (3750, 4060) reported `at=5677,4108`; dispatching that
// same X back was a no-op, and +100 moved exactly 100px.
//
// Monitor-LOCAL space exists in exactly one place: geometry inside a
// per-monitor layer-shell window's `Gtk.Fixed` (see Preview.ts). `toLocal` is
// the only legal bridge into it, and is only ever called immediately before a
// `Gtk.Fixed.move()`.
//
// This was worth writing down because on a single monitor at origin (0,0) the
// two spaces are numerically identical, so confusing them is invisible.
// ---------------------------------------------------------------------------

// Per-monitor special workspaces: each monitor gets its own
// `special:drawer-<connector>` (e.g. `special:drawer-DP-1`). This sidesteps
// the single-instance migration race of a single global `special:drawer`
// (toggling on monitor B would yank it off monitor A and drag windows
// along). With one special per monitor, toggling drawer open/closed is just
// N independent toggles, and tracked windows are pinned to their monitor's
// workspace by name.
export const SPECIAL_PREFIX = "special:drawer-"

// Workspace dispatcher name (without the `special:` prefix), used in
// togglespecialworkspace and [workspace ...] rules.
export function specialNameFor(monitorName: string): string {
    return `drawer-${monitorName}`
}

// Full workspace name (with `special:` prefix), used in movetoworkspacesilent
// and matchers.
export function fullSpecialNameFor(monitorName: string): string {
    return `special:${specialNameFor(monitorName)}`
}

// Extract the monitor name encoded into a `special:drawer-<name>` workspace
// name. Returns null for any other workspace name.
export function monitorFromSpecial(wsName: string | undefined): string | null {
    if (!wsName || !wsName.startsWith(SPECIAL_PREFIX)) return null
    return wsName.slice(SPECIAL_PREFIX.length)
}

export type Client = {
    address: string
    class: string
    // The class the window mapped with. Some apps rewrite `class` later, so
    // this is a second chance at recognising them; Match scores it lower.
    initialClass?: string
    // 0 is the focused window, higher is further back in the focus stack.
    // Used to break ties when an app has several windows open.
    focusHistoryID?: number
    title: string
    pid: number
    workspace: { id: number; name: string }
    at: [number, number]
    size: [number, number]
    monitor: number
    floating?: boolean
}

export type Monitor = {
    id: number
    name: string
    focused: boolean
    activeWorkspace?: { id: number; name: string }
    specialWorkspace?: { id: number; name: string }
    x?: number
    y?: number
    width?: number
    height?: number
}

export function monitors(): Monitor[] {
    try {
        return JSON.parse(exec("hyprctl monitors -j")) as Monitor[]
    } catch {
        return []
    }
}

export function focusedMonitor(): Monitor | undefined {
    return monitors().find((m) => m.focused)
}

export function cursorPos(): { x: number; y: number } | null {
    try {
        return JSON.parse(exec("hyprctl cursorpos -j")) as { x: number; y: number }
    } catch {
        return null
    }
}

// --------------------------------------------------------------- geometry

export type Rect = { x: number; y: number; w: number; h: number }

// A monitor's global layout rect, or null when hyprctl omitted any part of
// the geometry. Callers must handle null rather than defaulting — a monitor
// with unknown bounds can't be hit-tested or clamped against meaningfully.
export function rectOf(m: Monitor): Rect | null {
    if (
        m.x === undefined ||
        m.y === undefined ||
        m.width === undefined ||
        m.height === undefined
    ) {
        return null
    }
    return { x: m.x, y: m.y, w: m.width, h: m.height }
}

// Inclusive on the top-left edge, exclusive on the bottom-right, so adjacent
// monitors in a layout never both claim the same pixel.
export function containsPoint(r: Rect, x: number, y: number): boolean {
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h
}

// The monitor whose layout rect contains the global point, if any. Returns
// undefined for points in layout dead space — which is a real case on
// non-rectangular arrangements, not a defensive hypothetical. Pair with
// `nearestMonitor` wherever a miss still has to resolve to something.
export function monitorAt(x: number, y: number, mons?: Monitor[]): Monitor | undefined {
    const list = mons ?? monitors()
    return list.find((m) => {
        const r = rectOf(m)
        return r !== null && containsPoint(r, x, y)
    })
}

// Closest monitor by squared distance to its rect (0 when inside). Used as the
// fallback when `monitorAt` misses, so a drop into dead space still lands
// somewhere sensible instead of nowhere.
export function nearestMonitor(x: number, y: number, mons?: Monitor[]): Monitor | undefined {
    const list = mons ?? monitors()
    let best: Monitor | undefined
    let bestDist = Infinity
    for (const m of list) {
        const r = rectOf(m)
        if (!r) continue
        const cx = Math.max(r.x, Math.min(x, r.x + r.w))
        const cy = Math.max(r.y, Math.min(y, r.y + r.h))
        const dx = x - cx
        const dy = y - cy
        const dist = dx * dx + dy * dy
        if (dist < bestDist) {
            bestDist = dist
            best = m
        }
    }
    return best
}

// Global -> monitor-local. The ONLY legal bridge out of global space; see the
// invariant at the top of this file. Call it immediately before a
// `Gtk.Fixed.move()` and nowhere else.
export function toLocal(m: Monitor, x: number, y: number): { x: number; y: number } {
    return { x: x - (m.x ?? 0), y: y - (m.y ?? 0) }
}

export function clients(): Client[] {
    try {
        return JSON.parse(exec("hyprctl clients -j")) as Client[]
    } catch {
        return []
    }
}

export function activeWindow(): Client | null {
    try {
        const active = JSON.parse(exec("hyprctl activewindow -j")) as Client
        return active?.address ? active : null
    } catch {
        return null
    }
}

// Is this client currently living in any monitor's drawer special?
export function isInDrawer(c: Client): boolean {
    return c.workspace?.name?.startsWith(SPECIAL_PREFIX) ?? false
}

// The running window belonging to a launcher entry, if there is one.
// `keys` is an AppEntry's `matchKeys`; see Match.ts for why an app needs a
// list of spellings rather than a single class name.
//
// Windows already inside a drawer special are deprioritized rather than
// excluded: when an app has one window in the drawer and one outside, the user
// is looking at the one outside, and that is the one to pull in. When every
// candidate is already in the drawer the match still succeeds, and the caller
// focuses it instead of re-issuing a move that would be invisible.
export function findForApp(keys: readonly string[]): Client | undefined {
    return Match.pickClient(keys, clients(), { deprioritize: isInDrawer })
}

// Every client that currently lives in any per-monitor drawer special.
export function findInSpecial(): Client[] {
    return clients().filter((c) => c.workspace?.name?.startsWith(SPECIAL_PREFIX))
}

// Single source of truth for "is the drawer overlay currently visible?".
// Reads Hyprland directly rather than trusting an in-process flag — that
// flag would desync if anything else (another keybind, daemon restart,
// session lock cycle) toggled the workspace behind our back. With
// per-monitor specials, "drawer open" means at least one monitor has its
// drawer-<name> special active.
export function isDrawerOpen(): boolean {
    return monitors().some((m) => m.specialWorkspace?.name?.startsWith(SPECIAL_PREFIX))
}

// Every compositor action goes through here as data, so the Lua and legacy
// spellings live in one serializer instead of being scattered across template
// literals. See Dispatch.ts for why the two differ at all.
export async function dispatch(action: Action): Promise<string> {
    const arg = serialize(action, provider())
    try {
        if (provider() === "lua") {
            // Argv form, not a command string: the Lua expression carries
            // quotes, parens and commas that GLib.shell_parse_argv would
            // mangle.
            return await execAsync(["hyprctl", "dispatch", arg])
        }
        return await execAsync(`hyprctl dispatch ${arg}`)
    } catch (e) {
        // Log and rethrow. Callers keep whatever error handling they already
        // had, but the failing command reaches daemon.log instead of vanishing
        // into a swallowed promise - a silent dispatch failure is
        // indistinguishable from "the drawer just ignored my click".
        console.error("dispatch failed:", arg, e)
        throw e
    }
}

// Move a window into the target monitor's drawer special workspace. Used to
// reassign membership after a drag between monitors, or to re-trap an
// orphan into its rightful monitor on adoption.
export async function moveToSpecialOn(address: string, monitorName: string): Promise<void> {
    await dispatch({
        kind: "moveToWorkspaceSilent",
        workspace: fullSpecialNameFor(monitorName),
        address,
    })
}

// Move a window to the target monitor's currently-active REGULAR (non-special)
// workspace. Retained for completeness; the new model keeps drawer apps in
// per-monitor specials, but evicting back to a regular workspace is still
// useful as an escape hatch.
export async function moveToRegularOn(
    address: string,
    monitorName: string,
): Promise<void> {
    const m = monitors().find((x) => x.name === monitorName)
    const ws = m?.activeWorkspace?.id
    if (ws === undefined) return
    await dispatch({ kind: "moveToWorkspaceSilent", workspace: String(ws), address })
}

// Spawn an app directly into the given monitor's drawer special workspace,
// floating. Per-monitor specials make this trivial — no migration, no
// post-spawn eviction; the workspace name itself carries the monitor.
export async function spawnInSpecialOn(execStr: string, monitorName: string): Promise<void> {
    await dispatch({
        kind: "spawnWithRules",
        exec: execStr,
        workspace: fullSpecialNameFor(monitorName),
    })
}

// Poll hyprctl for a newly-mapped window matching `keys` that wasn't in the
// pre-spawn address set. Used to attach floating/geom rules to apps whose
// own startup is too slow for the spawn-time [float] dispatcher to stick.
//
// Deliberately the same matcher findForApp uses. This helper used to carry its
// own private class comparison, which drifted from findByClass's and quietly
// grew a third matching leg the other lacked - so an app could be recognised
// after being spawned but never recognised for adoption.
export async function awaitNewWindow(
    keys: readonly string[],
    knownAddrs: Set<string>,
    timeoutMs = 4000,
): Promise<Client | null> {
    const intervalMs = 120
    const tries = Math.ceil(timeoutMs / intervalMs)
    for (let i = 0; i < tries; i++) {
        const fresh = Match.pickClient(keys, clients(), { exclude: knownAddrs })
        if (fresh) return fresh
        await new Promise<void>((resolve) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
                resolve()
                return false
            })
        })
    }
    return null
}

// Force a window into the floating state. Belt-and-suspenders for the
// `[float]` spawn dispatcher and the `float on` workspace windowrule, both
// of which silently miss for some apps (notably Rust/Tauri windows like
// verbatim) — the window ends up tiled in the drawer special, where
// `resizewindowpixel` is a no-op and the user can't drag-resize.
export async function setFloating(address: string): Promise<void> {
    await dispatch({ kind: "setFloating", address })
}

export async function applyGeom(
    address: string,
    geom: { x: number; y: number; w: number; h: number },
): Promise<void> {
    await dispatch({ kind: "resizeExact", w: geom.w, h: geom.h, address })
    await dispatch({ kind: "moveExact", x: geom.x, y: geom.y, address })
}

export async function movePixel(address: string, x: number, y: number): Promise<void> {
    await dispatch({ kind: "moveExact", x, y, address })
}

export async function moveWindowToMonitor(address: string, monitorName: string): Promise<void> {
    await dispatch({ kind: "moveToMonitor", monitor: monitorName, address })
}

// Focus a window without moving it. Used when a click's target is already
// sitting where a move would put it.
export async function focusWindow(address: string): Promise<void> {
    await dispatch({ kind: "focusWindow", address })
}

// Open the drawer special workspace on every monitor that doesn't already
// have it open. Hyprland's `togglespecialworkspace` always targets the
// focused monitor, so we walk monitors, focusmonitor on each, toggle if
// needed, then restore focus to the original monitor. Per-monitor specials
// mean each toggle is independent — no migration of a shared workspace.
export async function openAllDrawerSpecials(): Promise<void> {
    const mons = monitors()
    if (mons.length === 0) return
    const originalFocus = mons.find((m) => m.focused)?.name
    for (const m of mons) {
        const want = specialNameFor(m.name)
        if (m.specialWorkspace?.name === `special:${want}`) continue
        await dispatch({ kind: "focusMonitor", monitor: m.name })
        await dispatch({ kind: "toggleSpecial", workspace: want })
    }
    if (originalFocus) await dispatch({ kind: "focusMonitor", monitor: originalFocus })
}

// Close every drawer special that's currently open. Mirrors
// openAllDrawerSpecials. Tracked windows stay assigned to their workspace —
// Hyprland persists special-workspace membership across toggles, so the
// next open re-reveals them in place.
export async function closeAllDrawerSpecials(): Promise<void> {
    const mons = monitors()
    if (mons.length === 0) return
    const originalFocus = mons.find((m) => m.focused)?.name
    for (const m of mons) {
        const name = m.specialWorkspace?.name
        if (!name || !name.startsWith(SPECIAL_PREFIX)) continue
        // Toggle on the monitor that currently hosts this special, which
        // will close it. Usually that's m itself, but we trust the data.
        await dispatch({ kind: "focusMonitor", monitor: m.name })
        await dispatch({ kind: "toggleSpecial", workspace: name.slice("special:".length) })
    }
    if (originalFocus) await dispatch({ kind: "focusMonitor", monitor: originalFocus })
}
