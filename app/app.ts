import app from "ags/gtk4/app"
import { subprocess } from "ags/process"
import GLib from "gi://GLib"
import { Gdk } from "ags/gtk4"
import Launcher, { setLauncherMonitor } from "./widget/Launcher"
import * as Hypr from "./service/Hypr"
import * as Memory from "./service/Memory"
import * as Preview from "./service/Preview"
import * as Hotkey from "./service/Hotkey"
import * as Settings from "./service/Settings"
import * as Shade from "./widget/Shade"
import style from "./style.scss"

// State the daemon owns. The drawer's "visible" status is NOT stored as a
// local flag — that desyncs whenever anything else (another keybind, a
// daemon restart, a lock cycle) touches the special workspace. We always
// read the truth from Hyprland via Hypr.isDrawerOpen() before acting.
let launcherWin: any = null

// Set while hide()/show() is mid-transition. The socket2 listener fires
// focusedmon/activespecial events as a side effect of our own
// openAllDrawerSpecials/closeAllDrawerSpecials sequence; without this
// guard those events trigger refreshMonitorAnchors, which re-creates the
// shade right after we just tore it down (and vice versa). The guard is
// cleared after the next idle so any genuine user-initiated focus change
// during the brief async window is still handled correctly.
let transitioning = false

function applyLayerVisibility(want: boolean) {
    if (launcherWin) launcherWin.visible = want
}

// Pick the GDK monitor the launcher rail should anchor to, based on the
// user's `railMonitor` setting. "focused" reads Hyprland for the active
// monitor; "primary" is the first GDK monitor; a number is an explicit
// index with bounds-check fallback to primary.
function resolveRailMonitor(): any {
    const display = Gdk.Display.get_default()
    const monitors: any = display?.get_monitors?.()
    const count = monitors?.get_n_items?.() ?? 0
    if (!monitors || count === 0) return null

    const pref = Settings.railMonitor()

    if (pref === "focused") {
        const fm = Hypr.focusedMonitor()
        if (fm) {
            for (let i = 0; i < count; i++) {
                const m: any = monitors.get_item(i)
                if (m?.get_connector?.() === fm.name) return m
            }
        }
        return monitors.get_item(0)
    }

    if (pref === "primary") return monitors.get_item(0)

    const idx = typeof pref === "number" && pref >= 0 && pref < count ? pref : 0
    return monitors.get_item(idx)
}

// Re-anchor the rail (and shades) to whichever monitor is appropriate right
// now. Called on every show() and on Hyprland focusedmon events while the
// drawer is open.
function refreshMonitorAnchors(): void {
    const mon = resolveRailMonitor()
    setLauncherMonitor(mon)
    if (Settings.blurAllMonitors()) {
        Shade.show(drawerTracked)
    } else {
        Shade.hide()
    }
}

// Addresses of windows the user has launched/dragged via the drawer. These
// windows live on their target monitor's REGULAR workspace, not in
// special:drawer — special is only a transient spawn pipe (see Spawn.ts).
// The set survives drawer hide/show so the shade can keep skipping monitors
// that host these windows across toggles. Dead addresses are pruned in
// pruneDeadTracked() and on closewindow socket events.
const drawerTracked = new Set<string>()

export function trackDrawerWindow(address: string): void {
    drawerTracked.add(address)
}

function pruneDeadTracked(): void {
    if (drawerTracked.size === 0) return
    const live = new Set(Hypr.clients().map((c) => c.address))
    for (const addr of [...drawerTracked]) {
        if (!live.has(addr)) drawerTracked.delete(addr)
    }
}

// On first show after a daemon start, any windows already sitting in a
// drawer special workspace (from a previous session) get tracked and
// re-pinned to the correct monitor's special. If a previous session left
// orphans in the wrong monitor's special, they get reassigned.
async function adoptSpecialResidents(): Promise<void> {
    const specials = Hypr.findInSpecial()
    if (specials.length === 0) return
    const mons = Hypr.monitors()
    for (const c of specials) {
        drawerTracked.add(c.address)
        const mon = mons.find((m) => m.id === c.monitor)
        if (!mon) continue
        const expected = Hypr.fullSpecialNameFor(mon.name)
        if (c.workspace?.name !== expected) {
            await Hypr.moveToSpecialOn(c.address, mon.name)
        }
    }
}

async function show() {
    setLauncherMonitor(resolveRailMonitor())
    // Open the per-monitor drawer special on every monitor. Each monitor's
    // special is independent, so this is safe and idempotent. Guard the
    // socket listener from racing focusedmon events fired by our own
    // focusmonitor dispatches.
    transitioning = true
    try {
        await Hypr.openAllDrawerSpecials()
        await adoptSpecialResidents()
    } catch (e) {
        console.error("show:", e)
    } finally {
        transitioning = false
    }
    pruneDeadTracked()
    // Refresh saved geometry for tracked windows after the adoption pass
    // has had a chance to settle them onto regular workspaces.
    for (const c of Hypr.clients()) {
        if (!drawerTracked.has(c.address)) continue
        const saved = Memory.get(c.class?.toLowerCase() || "")
        if (saved) Hypr.applyGeom(c.address, saved).catch(() => {})
    }
    refreshMonitorAnchors()
    applyLayerVisibility(true)
}

async function hide() {
    // Snapshot every tracked window's geometry before closing so size/pos
    // persists across toggles. Windows live in their monitor's drawer
    // special; Hyprland remembers special-workspace membership across the
    // toggle so the next open re-reveals them in place.
    for (const c of Hypr.clients()) {
        if (!drawerTracked.has(c.address)) continue
        const cls = c.class?.toLowerCase()
        if (!cls) continue
        Memory.update(cls, {
            x: c.at[0],
            y: c.at[1],
            w: c.size[0],
            h: c.size[1],
            monitor: String(c.monitor),
        })
    }
    // Tear down the visible surfaces first so the shade is gone before
    // any focusedmon socket events from the close sequence arrive.
    Shade.hide()
    applyLayerVisibility(false)
    transitioning = true
    try {
        await Hypr.closeAllDrawerSpecials()
    } catch (e) {
        console.error("hide:", e)
    } finally {
        transitioning = false
    }
    // Keep drawerTracked across hide/show so the shade keeps skipping the
    // monitors that hold those windows on the next open. Dead entries are
    // pruned in pruneDeadTracked()/the closewindow socket handler.
}

function toggle() {
    // Skip if a previous show/hide is still mid-transition — the dispatch
    // loops over monitors take long enough on multi-monitor setups that a
    // fast double-tap could otherwise interleave show and hide.
    if (transitioning) return
    if (Hypr.isDrawerOpen()) hide()
    else show()
}

// Exposed so widgets (close button) can hide the drawer.
;(globalThis as any).__hyprDrawerHide = hide
// Exposed so the drop pipeline can force an immediate shade refresh after
// it moves special:drawer between monitors, without waiting for Hyprland's
// activespecial socket event to round-trip.
;(globalThis as any).__hyprDrawerRefresh = refreshMonitorAnchors
;(globalThis as any).__hyprDrawerTrack = trackDrawerWindow

// Coalesce rapid duplicate toggle requests. Hyprland occasionally fires a
// bind twice in quick succession when a conf-sourced bind overlaps with one
// installed via `hyprctl keyword bind`. With no debounce that flicker-opens
// then flicker-closes the drawer on a single keypress; 200ms is comfortably
// longer than any legitimate human re-press and short enough to not feel
// laggy.
const DEBOUNCE_MS = 200
let lastToggleAt = 0
function maybeToggle(): boolean {
    const now = GLib.get_monotonic_time() / 1000 // µs → ms
    if (now - lastToggleAt < DEBOUNCE_MS) return false
    lastToggleAt = now
    toggle()
    return true
}

app.start({
    css: style,
    instanceName: "hypr-drawer",
    requestHandler(argv: string[], response: (msg: string) => void) {
        const cmd = (argv[0] ?? "").trim()
        switch (cmd) {
            case "toggle":
                response(maybeToggle() ? "ok" : "debounced")
                break
            case "show":
                show()
                response("ok")
                break
            case "hide":
                hide()
                response("ok")
                break
            case "quit":
                response("bye")
                app.quit()
                break
            default:
                response(`unknown: ${cmd}`)
        }
    },
    main() {
        launcherWin = Launcher()
        Preview.init()
        Hotkey.ensureFile()
        // Subscribe to Hyprland events so geometry of a window the user
        // resizes/moves while the drawer is open gets persisted live.
        listenHyprEvents()
        // Live blur-scope and rail-monitor changes: refresh shades. We no
        // longer evict from special on mode switch — apps live in regular
        // workspaces now, so the only thing changing is which monitors
        // render the blur layer.
        Settings.blurAllMonitors.subscribe(() => {
            if (Hypr.isDrawerOpen()) refreshMonitorAnchors()
        })
        Settings.railMonitor.subscribe(() => {
            if (Hypr.isDrawerOpen()) refreshMonitorAnchors()
        })
    },
})

function listenHyprEvents() {
    const his = GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE")
    const runtime = GLib.getenv("XDG_RUNTIME_DIR") || `/run/user/${GLib.get_user_name()}`
    if (!his) return
    const sock = `${runtime}/hypr/${his}/.socket2.sock`
    subprocess(
        ["socat", "-U", "-", `UNIX-CONNECT:${sock}`],
        (line: string) => {
            // Rail follows the cursor: re-anchor on every focused-monitor
            // change while the drawer is open and rail is in "focused"
            // mode. We don't move the special workspace itself — apps
            // already living there would flicker; the shade overlays
            // handle "blur on every monitor" independently of which one
            // hosts special:drawer.
            if (/^(focusedmon|moveworkspace|activespecial)>>/.test(line)) {
                if (transitioning) return
                if (!Hypr.isDrawerOpen()) return
                refreshMonitorAnchors()
                return
            }
            // Window moved between monitors. If it's a tracked drawer
            // window, reassign its workspace membership to the destination
            // monitor's drawer special so the hide-away toggle keeps
            // working. Then refresh the shade so the source monitor's blur
            // re-renders and the destination's clears.
            const mv = /^movewindow>>([0-9a-fx]+)/.exec(line)
            if (mv && Hypr.isDrawerOpen()) {
                const addr = mv[1].startsWith("0x") ? mv[1] : `0x${mv[1]}`
                if (drawerTracked.has(addr)) {
                    const c = Hypr.clients().find((x) => x.address === addr)
                    const mons = Hypr.monitors()
                    const mon = c ? mons.find((m) => m.id === c.monitor) : undefined
                    if (c && mon) {
                        const expected = Hypr.fullSpecialNameFor(mon.name)
                        if (c.workspace?.name !== expected) {
                            Hypr.moveToSpecialOn(c.address, mon.name).catch(() => {})
                        }
                    }
                    refreshMonitorAnchors()
                }
            }
            // Any new window that lands in a drawer special needs to be
            // floating to be drag-resizable inside the overlay. Apps that
            // ignore the spawn-time `[float]` dispatcher or `float on`
            // windowrule (Rust/Tauri, some Electron) come up tiled, and
            // popups spawned from a drawer-resident app inherit nothing.
            // The Spawn/launch paths already force float for their own
            // direct spawns; this handler covers everything else.
            const ow = /^openwindow>>([0-9a-fx]+),([^,]+),/.exec(line)
            if (ow) {
                const addr = ow[1].startsWith("0x") ? ow[1] : `0x${ow[1]}`
                const wsName = ow[2]
                const inDrawer =
                    wsName.startsWith(Hypr.SPECIAL_PREFIX) ||
                    wsName.startsWith("drawer-")
                if (inDrawer) {
                    drawerTracked.add(addr)
                    const c = Hypr.clients().find((x) => x.address === addr)
                    if (c && c.floating !== true) {
                        Hypr.setFloating(addr).catch(() => {})
                    }
                    if (Hypr.isDrawerOpen()) refreshMonitorAnchors()
                }
            }
            // Prune tracked entries the moment a window dies, regardless of
            // drawer state, so we don't accumulate dead addresses across
            // sessions.
            const cw = /^closewindow>>([0-9a-fx]+)/.exec(line)
            if (cw) {
                const addr = cw[1].startsWith("0x") ? cw[1] : `0x${cw[1]}`
                if (drawerTracked.delete(addr) && Hypr.isDrawerOpen()) {
                    refreshMonitorAnchors()
                }
            }
            if (!Hypr.isDrawerOpen()) return
            if (/^(movewindow|resizewindow|closewindow|openwindow)>>/.test(line)) {
                for (const c of Hypr.clients()) {
                    if (!drawerTracked.has(c.address)) continue
                    const cls = c.class?.toLowerCase()
                    if (!cls) continue
                    Memory.update(cls, {
                        x: c.at[0],
                        y: c.at[1],
                        w: c.size[0],
                        h: c.size[1],
                        monitor: String(c.monitor),
                    })
                }
            }
        },
        (err: string) => console.error("hypr socket:", err),
    )
}
