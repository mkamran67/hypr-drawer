import { createState } from "ags"
import * as Settings from "./Settings"

// Which monitor the launcher rail is pinned to, and how thick it actually is.
//
// This lives outside Launcher.tsx because Layout.isOverRail needs it and the
// import graph runs Launcher -> AppTile -> Layout. Importing Launcher from
// Layout would close a cycle through modules that call createState at import
// time. Extracting the state keeps the graph acyclic:
//
//     Settings <- RailState <- Layout, Launcher
//
// Launcher owns the writes (it is what actually renders the rail); Layout
// only reads.

// The GDK monitor the rail window is currently displayed on. Untyped for the
// same reason Launcher's original state was — Astal's `gdkmonitor` prop takes
// a Gdk.Monitor and the gi typings for it are awkward to thread through JSX.
export const [railMonitor, setRailMonitor] = createState<any>(null)

// The live rail window, registered by Launcher's `$=` ref callback. Used only
// to measure the rail; never rendered or mutated from here.
let railWindow: any = null

export function setRailWindow(w: any): void {
    railWindow = w
}

// Connector name (e.g. "DP-2") of the monitor hosting the rail, matching the
// `name` field hyprctl reports for monitors. Null when the rail has not been
// pinned yet, which callers must treat as "unknown" rather than "monitor 0" —
// guessing is exactly what the old primaryMonitor() did wrong.
export function railMonitorName(): string | null {
    try {
        return railMonitor()?.get_connector?.() ?? null
    } catch {
        return null
    }
}

// How thick the rail strip is, along the axis perpendicular to the edge it is
// anchored to.
//
// Deliberately measures the real widget rather than returning Settings.width().
// Launcher sets only `widthRequest` for all four sides, so for a top- or
// bottom-anchored rail — which stretches left-to-right and is sized by its
// content vertically — Settings.width() describes the wrong axis entirely.
// (That the setting does nothing for horizontal sides is a separate, deferred
// bug; measuring here means the hit-test stays honest either way.)
export function thickness(): number {
    const fallback = Settings.width()
    try {
        if (!railWindow) return fallback
        const vertical = Settings.isVertical(Settings.side())
        const measured = vertical
            ? railWindow.get_width?.()
            : railWindow.get_height?.()
        // An unrealized or not-yet-allocated window measures 0.
        if (typeof measured === "number" && measured > 0) return measured
    } catch {}
    return fallback
}
