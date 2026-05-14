import app from "ags/gtk4/app"
import { exec, subprocess } from "ags/process"
import GLib from "gi://GLib"
import Launcher from "./widget/Launcher"
import * as Hypr from "./service/Hypr"
import * as Memory from "./service/Memory"
import * as Preview from "./service/Preview"
import * as Hotkey from "./service/Hotkey"
import style from "./style.scss"

// State the daemon owns. The drawer's "visible" status is NOT stored as a
// local flag — that desyncs whenever anything else (another keybind, a
// daemon restart, a lock cycle) touches the special workspace. We always
// read the truth from Hyprland via Hypr.isDrawerOpen() before acting.
let launcherWin: any = null

function applyLayerVisibility(want: boolean) {
    if (launcherWin) launcherWin.visible = want
}

function show() {
    // Only open the special workspace if it isn't already showing.
    if (!Hypr.isDrawerOpen()) {
        exec("hyprctl dispatch togglespecialworkspace drawer")
    }
    // Re-apply saved geometry to anything already living there.
    for (const c of Hypr.findInSpecial()) {
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
    if (Hypr.isDrawerOpen()) {
        exec("hyprctl dispatch togglespecialworkspace drawer")
    }
    applyLayerVisibility(false)
}

function toggle() {
    if (Hypr.isDrawerOpen()) hide()
    else show()
}

// Exposed so widgets (close button) can hide the drawer.
;(globalThis as any).__hyprDrawerHide = hide

app.start({
    css: style,
    instanceName: "hypr-drawer",
    requestHandler(argv: string[], response: (msg: string) => void) {
        const cmd = (argv[0] ?? "").trim()
        switch (cmd) {
            case "toggle":
                toggle()
                response("ok")
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
            // We only need a coarse trigger: any of these means "snapshot now if drawer open".
            if (!Hypr.isDrawerOpen()) return
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
