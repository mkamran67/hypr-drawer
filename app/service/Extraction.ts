export type ExtractableWindow = {
    address: string
    monitor: number
    workspace?: { name?: string }
}

export type ExtractionDeps = {
    activeWindow(): ExtractableWindow | null
    untrack(address: string): void
    setFloating(address: string): Promise<void>
    moveToRegular(address: string, monitor: number): Promise<void>
}

export type ExtractionResult = "extracted" | "no-active-window" | "not-in-drawer"

export async function extractFocused(deps: ExtractionDeps): Promise<ExtractionResult> {
    const window = deps.activeWindow()
    if (!window) return "no-active-window"
    if (!window.workspace?.name?.startsWith("special:drawer-")) return "not-in-drawer"

    // Untrack before the compositor emits movewindow. Otherwise the drawer's
    // event listener interprets the regular-workspace move as accidental and
    // immediately traps the window again.
    deps.untrack(window.address)
    await deps.setFloating(window.address)
    await deps.moveToRegular(window.address, window.monitor)
    return "extracted"
}
