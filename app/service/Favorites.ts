// Pure favorites logic, deliberately free of any gi:// import so it can run
// under plain node in packaging/test-favorites.ts. Usage.ts owns the signal
// and the on-disk file; this module owns the rules.

// Favorites are an ordered list, not a set: Apps.browseList pins them to the
// top in the order they were added, so a new one appends and the rest keep
// their positions. Always returns a fresh array - the caller stores it in a
// signal, and an in-place edit would not notify subscribers.
export function toggle(list: string[], desktopId: string): string[] {
    if (!desktopId) return [...list]
    return list.includes(desktopId)
        ? list.filter((id) => id !== desktopId)
        : [...list, desktopId]
}

export function isFavorite(list: string[], desktopId: string): boolean {
    if (!desktopId) return false
    return list.includes(desktopId)
}

// Filled vs hollow star. The hollow one is what the tile shows on hover for a
// not-yet-favorited app, so the click target reads the same in both states.
export function starGlyph(fav: boolean): string {
    return fav ? "★" : "☆"
}

export function starTooltip(fav: boolean): string {
    return fav ? "Remove from favorites" : "Add to favorites"
}
