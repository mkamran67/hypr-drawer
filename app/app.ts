import app from "ags/gtk4/app"
import { exec, subprocess } from "ags/process"
import GLib from "gi://GLib"
import Launcher from "./widget/Launcher"
import DropZone from "./widget/DropZone"
import * as Hypr from "./service/Hypr"
import * as Memory from "./service/Memory"
import style from "./style.scss"

// State the daemon owns.
let launcherWin: any = null
let dropzoneWin: any = null
let visible = false

function show() {
    if (!launcherWin || !dropzoneWin) return
    // 1. Open the special workspace (or focus it if hidden).
    exec("hyprctl dispatch togglespecialworkspace drawer")
    // 2. Re-apply saved geometry to anything already living there.
    for (const c of Hypr.findInSpecial()) {
        const saved = Memory.get(c.class?.toLowerCase() || "")
        if (saved) Hypr.applyGeom(c.address, saved).catch(() => {})
    }
    launcherWin.visible = true
    dropzoneWin.visible = true
    visible = true
}

function hide() {
    if (!launcherWin || !dropzoneWin) return
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
    exec("hyprctl dispatch togglespecialworkspace drawer")
    launcherWin.visible = false
    dropzoneWin.visible = false
    visible = false
}

function toggle() {
    if (visible) hide()
    else show()
}

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
        dropzoneWin = DropZone({ onClose: hide })
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
            if (!visible) return
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
