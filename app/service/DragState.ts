import { AppEntry } from "./Apps"

// Module-level handle to the app currently being dragged. There is only ever
// one drag in flight at a time, so a shared variable is enough — and lets the
// DropZone size its preview rectangle on `enter` without having to read the
// async drop value.
let current: AppEntry | null = null

export function setActiveDrag(app: AppEntry): void {
    current = app
}

export function clearActiveDrag(): void {
    current = null
}

export function getActiveDrag(): AppEntry | null {
    return current
}
