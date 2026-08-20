// Unit tests for the favorites reducer behind the star button on each tile.
//
// The list is not a set: `Apps.browseList` pins favorites to the top *in the
// order the user added them*, so `toggle` must append rather than re-sort, and
// must never mutate the list it is handed - the launcher state is a signal and
// an in-place edit would leave subscribers unnotified.
//
// Usage: node packaging/test-favorites.ts   (node >= 22, native type stripping)

import { strict as assert } from "node:assert"
import { toggle, isFavorite, starGlyph, starTooltip } from "../app/service/Favorites.ts"

// --- toggle: add / remove ---------------------------------------------------
assert.deepEqual(toggle([], "firefox.desktop"), ["firefox.desktop"])
assert.deepEqual(toggle(["firefox.desktop"], "firefox.desktop"), [])
assert.deepEqual(
    toggle(["a.desktop", "b.desktop"], "a.desktop"),
    ["b.desktop"],
)

// New favorites land at the end so the pinned block keeps insertion order.
assert.deepEqual(toggle(["a.desktop"], "b.desktop"), ["a.desktop", "b.desktop"])

// --- toggle: purity ---------------------------------------------------------
const original = ["a.desktop"]
const added = toggle(original, "b.desktop")
assert.notEqual(added, original, "toggle must return a fresh array")
assert.deepEqual(original, ["a.desktop"], "toggle must not mutate its input")

// A tile with no desktop id (a .desktop file Gio could not name) is not
// favoritable - storing "" would pin every such app at once.
assert.deepEqual(toggle(["a.desktop"], ""), ["a.desktop"])

// --- isFavorite -------------------------------------------------------------
assert.equal(isFavorite(["a.desktop"], "a.desktop"), true)
assert.equal(isFavorite(["a.desktop"], "b.desktop"), false)
assert.equal(isFavorite(["a.desktop"], ""), false)
assert.equal(isFavorite([], "a.desktop"), false)

// --- star presentation ------------------------------------------------------
assert.equal(starGlyph(true), "★")
assert.equal(starGlyph(false), "☆")
assert.match(starTooltip(true), /remove/i)
assert.match(starTooltip(false), /add/i)

console.log("ok - favorites reducer and star presentation")
