import { strict as assert } from "node:assert"
import { extractFocused } from "../app/service/Extraction.ts"

const calls: string[] = []
const result = await extractFocused({
    activeWindow: () => ({ address: "0xabc", monitor: 2, workspace: { name: "special:drawer-DP-2" } }),
    untrack: (address) => calls.push(`untrack ${address}`),
    setFloating: async (address) => { calls.push(`float ${address}`) },
    moveToRegular: async (address, monitor) => { calls.push(`move ${address} ${monitor}`) },
})
assert.equal(result, "extracted")
assert.deepEqual(calls, ["untrack 0xabc", "float 0xabc", "move 0xabc 2"])

calls.length = 0
const ignored = await extractFocused({
    activeWindow: () => ({ address: "0xdef", monitor: 2, workspace: { name: "7" } }),
    untrack: () => calls.push("untrack"),
    setFloating: async () => { calls.push("float") },
    moveToRegular: async () => { calls.push("move") },
})
assert.equal(ignored, "not-in-drawer")
assert.deepEqual(calls, [])

console.log("ok - focused drawer window extraction")
