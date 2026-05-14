import app from "ags/gtk4/app"
import { exec, subprocess } from "ags/process"
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
        Shade.show()
    } else {
        Shade.hide()
    }
}

// Addresses of windows the user has "put into" the drawer (either by
// spawning them via a tile drop or by having them present in special when
// the drawer opened). While the drawer is visible, these stay trapped in
// special:drawer — if the user drags one between monitors via normal
// window-move, Hyprland pulls it onto a regular workspace, which would
// drop it behind a shade. We watch for that and re-trap it.
const drawerTracked = new Set<string>()

export function trackDrawerWindow(address: string): void {
    drawerTracked.add(address)
}

// Pull a drawer-owned window back into special:drawer after Hyprland
// ejected it (e.g. cross-monitor window drag from special). Migrates the
// special workspace to the window's current monitor first so the window
// becomes visible immediately under the rail's blur, then re-adds the
// window to special:drawer.
async function retrapDrawerWindow(address: string): Promise<void> {
    const client = Hypr.clients().find((c) => c.address === address)
    if (!client) {
        drawerTracked.delete(address)
        return
    }
    const mons = Hypr.monitors()
    const target = mons.find((m) => m.id === client.monitor)
    const specialHost = mons.find((m) => m.specialWorkspace?.name === "special:drawer")
    if (target && (!specialHost || specialHost.id !== target.id)) {
        await Hypr.migrateSpecialToMonitor(target.name)
    }
    await Hypr.moveToSpecial(address)
    refreshMonitorAnchors()
}

function show() {
    // Set the rail's monitor first so the layer-shell anchors correctly,
    // but DON'T compute shades yet — special:drawer isn't open, so
    // Shade.show would mistakenly cover every monitor including the
    // focused one. Open special first, then refresh.
    setLauncherMonitor(resolveRailMonitor())
    if (!Hypr.isDrawerOpen()) {
        exec("hyprctl dispatch togglespecialworkspace drawer")
    }
    refreshMonitorAnchors()
    // Seed the tracked set with whatever's already in special and re-apply
    // saved geometry.
    for (const c of Hypr.findInSpecial()) {
        drawerTracked.add(c.address)
        const saved = Memory.get(c.class?.toLowerCase() || "")
        if (saved) Hypr.applyGeom(c.address, saved).catch(() => {})
    }
    applyLayerVisibility(true)
}

function hide() {
    // Snapshot every window in the special workspace before we close.
    for (const c of Hypr.findInSpecial()) {
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
    // Close on every monitor that has it open — covers both modes uniformly.
    Hypr.closeSpecialOnAllMonitors().catch(() => {})
    Shade.hide()
    applyLayerVisibility(false)
    // The drawer is now closed; release tracked windows so a future drag
    // outside the drawer doesn't snap them back in.
    drawerTracked.clear()
}

function toggle() {
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
        // React to live blur-scope and rail-monitor changes while the
        // drawer is open. Toggle shades on/off and (when leaving blur-all
        // mode) evict apps from non-focused monitors before they get
        // stranded on a hidden special workspace.
        Settings.blurAllMonitors.subscribe(() => {
            if (!Hypr.isDrawerOpen()) return
            if (!Settings.blurAllMonitors()) {
                Hypr.evictSpecialFromNonFocused().catch(() => {})
            }
            refreshMonitorAnchors()
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
                if (!Hypr.isDrawerOpen()) return
                refreshMonitorAnchors()
                return
            }
            // Re-trap drawer-owned windows that the user dragged out of
            // special (e.g., by alt-dragging between monitors). The
            // movewindow event format is `movewindow>>ADDR,WSNAME`. If we
            // know this window belongs to the drawer but it now lives on
            // a non-special workspace, migrate special to that monitor
            // and pull the window back in. Layer-shell can't render
            // normal windows above a TOP-layer shade — keeping them in
            // special is the only way to stay in front of the blur.
            const mv = /^movewindow>>([0-9a-fx]+),(.+)$/.exec(line)
            if (mv && Hypr.isDrawerOpen()) {
                const addr = mv[1].startsWith("0x") ? mv[1] : `0x${mv[1]}`
                const wsName = mv[2]
                if (drawerTracked.has(addr) && !wsName.startsWith("special:drawer")) {
                    retrapDrawerWindow(addr).catch((e) =>
                        console.error("retrap:", e),
                    )
                    return
                }
            }
            // We only need a coarse trigger: any of these means "snapshot now if drawer open".
            if (!Hypr.isDrawerOpen()) return
            const cw = /^closewindow>>([0-9a-fx]+)/.exec(line)
            if (cw) {
                const addr = cw[1].startsWith("0x") ? cw[1] : `0x${cw[1]}`
                drawerTracked.delete(addr)
            }
            if (/^(movewindow|resizewindow|closewindow|openwindow)>>/.test(line)) {
                for (const c of Hypr.findInSpecial()) {
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
