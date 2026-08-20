import { strict as assert } from "node:assert"
import {
    shortcutFileContent,
    humanCombo,
    shortcutHelp,
    shortcutTooltip,
    EXTRACT_COMBO,
} from "../app/service/Shortcuts.ts"

const bin = "/home/test/.local/bin/hypr-drawer"

const legacy = shortcutFileContent("legacy", "SUPER CTRL, R", bin)
assert.match(legacy, /bind = SUPER CTRL, R, exec, \/home\/test\/\.local\/bin\/hypr-drawer toggle/)
assert.match(legacy, /bind = SUPER ALT, mouse:272, exec, \/home\/test\/\.local\/bin\/hypr-drawer extract/)
assert.match(legacy, /bindm = SUPER ALT, mouse:272, movewindow/)

const lua = shortcutFileContent("lua", "SUPER CTRL, R", bin)
assert.match(lua, /hl\.bind\("SUPER \+ CTRL \+ R", hl\.dsp\.exec_cmd\("\/home\/test\/\.local\/bin\/hypr-drawer toggle"\)\)/)
assert.match(lua, /hl\.bind\("SUPER \+ ALT \+ mouse:272", hl\.dsp\.exec_cmd\("\/home\/test\/\.local\/bin\/hypr-drawer extract"\), \{ mouse = true \}\)/)
assert.match(lua, /hl\.bind\("SUPER \+ ALT \+ mouse:272", hl\.dsp\.window\.drag\(\), \{ mouse = true \}\)/)

console.log("ok - drawer shortcut serialization")

// --- human-readable rendering for the drawer's shortcut tooltip -------------
// Hyprland's own spelling ("SUPER CTRL, R") is what lives in settings.json and
// in the bind file; it is not what a user wants to read at the bottom of the
// rail. Only the display layer converts.
assert.equal(humanCombo("SUPER CTRL, R"), "Super + Ctrl + R")
assert.equal(humanCombo("SUPER, Return"), "Super + Return")
assert.equal(humanCombo("SUPER SHIFT ALT, F13"), "Super + Shift + Alt + F13")
// The extract gesture binds mouse button 272 (left), which reads as a drag.
assert.equal(humanCombo(EXTRACT_COMBO), "Super + Alt + drag")
// A never-configured hotkey must not render as a stray " + ".
assert.equal(humanCombo(""), "not set")

// --- the tooltip rows -------------------------------------------------------
const rows = shortcutHelp("SUPER CTRL, R")
assert.equal(rows[0].keys, "Super + Ctrl + R", "the live toggle hotkey leads")
assert.match(rows[0].action, /drawer/i)
assert.ok(
    rows.some((r) => r.keys === "Super + Alt + drag"),
    "the extract gesture is listed",
)
assert.ok(rows.some((r) => /favorite/i.test(r.action)), "favoriting is listed")
assert.ok(rows.every((r) => r.keys && r.action), "no half-filled row")

// Rows track the live hotkey rather than the default.
assert.equal(shortcutHelp("SUPER, D")[0].keys, "Super + D")

const tip = shortcutTooltip("SUPER CTRL, R")
const lines = tip.split("\n")
assert.equal(lines.length, rows.length, "one line per row, no trailing blank")
assert.equal(lines[0], "Super + Ctrl + R - toggle the drawer")
// Plain dashes only: an em dash would not match the rest of the UI copy.
assert.ok(!tip.includes("—"), "no em dashes in the tooltip")

console.log("ok - drawer shortcut help rendering")
