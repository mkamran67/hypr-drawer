import { strict as assert } from "node:assert"
import { shortcutFileContent } from "../app/service/Shortcuts.ts"

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
