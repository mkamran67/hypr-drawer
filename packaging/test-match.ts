// Unit tests for window identity matching.
//
// The bug this module exists to prevent: a .desktop file with no
// `StartupWMClass` falls back to Gio's `get_executable()`, which is routinely
// an absolute path. Docker Desktop's entry has no StartupWMClass and
// `Exec=/opt/docker-desktop/bin/docker-desktop`, so the drawer stored
// "/opt/docker-desktop/bin/docker-desktop" as the app's identity and compared
// it against the real Hyprland class "docker-desktop". Neither string contains
// the other, so "move the running window into the drawer" silently fell
// through to "launch a new instance" - a no-op for a single-instance app.
// From the user's side, clicking the tile did nothing at all.
//
// Every client fixture below is a literal capture from `hyprctl clients -j` on
// a real session, and every desktop fixture from `Gio.DesktopAppInfo` probed
// under gjs. Treat them as recorded observations, not guesses - if one needs
// changing, re-probe the real system first.
//
// Usage: node packaging/test-match.ts   (node >= 22, native type stripping)

import {
    identKeys,
    keyMatches,
    pickClient,
    scoreClient,
    INITIAL_PENALTY,
    TIER_BOUNDARY,
    TIER_EXACT,
    type ClientLike,
    type DesktopFields,
} from "../app/service/Match.ts"

let failed = 0

function group(name: string): void {
    console.log(`\n\x1b[1m${name}\x1b[0m`)
}

function chk(label: string, got: unknown, want: unknown): void {
    const g = JSON.stringify(got)
    const w = JSON.stringify(want)
    if (g === w) {
        console.log(`  \x1b[1;32mPASS\x1b[0m ${label}`)
    } else {
        console.log(`  \x1b[1;31mFAIL\x1b[0m ${label}`)
        console.log(`       got  ${g}`)
        console.log(`       want ${w}`)
        failed = 1
    }
}

// --------------------------------------------------------------- fixtures

const DOCKER: DesktopFields = {
    startupWmClass: null,
    executable: "/opt/docker-desktop/bin/docker-desktop",
    desktopId: "docker-desktop.desktop",
    name: "Docker Desktop",
}

const DOCKER_CLIENT: ClientLike = {
    address: "0xdock",
    class: "docker-desktop",
    initialClass: "docker-desktop",
    workspace: { name: "4" },
    focusHistoryID: 3,
}

const FIREFOX: DesktopFields = {
    startupWmClass: "firefox",
    executable: "/usr/lib/firefox/firefox",
    desktopId: "firefox.desktop",
    name: "Firefox",
}

const WARP: DesktopFields = {
    startupWmClass: "dev.warp.Warp",
    executable: "warp-terminal",
    desktopId: "dev.warp.Warp.desktop",
    name: "Warp",
}

const ZED: DesktopFields = {
    startupWmClass: null,
    executable: "/home/highz/.local/zed.app/bin/zed",
    desktopId: "dev.zed.Zed.desktop",
    name: "Zed",
}

const CHROME: DesktopFields = {
    startupWmClass: "Google-chrome",
    executable: "/usr/bin/google-chrome-stable",
    desktopId: "google-chrome.desktop",
    name: "Google Chrome",
}

const JAVA: DesktopFields = {
    startupWmClass: null,
    executable: "/usr/lib/jvm/java-17-openjdk/bin/java",
    desktopId: "java-java17-openjdk.desktop",
    name: "OpenJDK Java 17 Runtime",
}

// A reverse-DNS desktop id whose executable and display name both differ from
// the last id segment. Only the dot-segment rule can produce "shelly" here.
const SHELLY: DesktopFields = {
    startupWmClass: null,
    executable: "/usr/bin/shelly-ui",
    desktopId: "com.shellyorg.shelly.desktop",
    name: "Shelly UI",
}

// Two Firefox windows on different workspaces. focusHistoryID 0 is the
// currently-focused window; higher is further back.
const FF_FOCUSED: ClientLike = {
    address: "0xff0",
    class: "firefox",
    initialClass: "firefox",
    workspace: { name: "gaming" },
    focusHistoryID: 0,
}
const FF_OLD: ClientLike = {
    address: "0xff2",
    class: "firefox",
    initialClass: "firefox",
    workspace: { name: "4" },
    focusHistoryID: 2,
}
const FF_IN_DRAWER: ClientLike = {
    address: "0xffd",
    class: "firefox",
    initialClass: "firefox",
    workspace: { name: "special:drawer-DP-2" },
    focusHistoryID: 0,
}

const inDrawer = (c: ClientLike) => c.workspace?.name?.startsWith("special:drawer-") ?? false

// ------------------------------------------------------------------ tests

group("regression: docker-desktop (no StartupWMClass, absolute Exec)")

chk(
    "B1 adopts the running window",
    pickClient(identKeys(DOCKER), [DOCKER_CLIENT])?.address,
    "0xdock",
)
// The exact comparison the old Hypr.findByClass performed, kept executable so
// the regression stays documented rather than remembered.
function oldFindByClass(want: string, c: ClientLike): boolean {
    const have = (c.class || "").toLowerCase()
    return have === want.toLowerCase() || have.includes(want.toLowerCase())
}

chk(
    "B2 the old two-leg matcher could never find it from the raw Exec path",
    oldFindByClass("/opt/docker-desktop/bin/docker-desktop", DOCKER_CLIENT),
    false,
)
chk(
    "B2b the app's identity no longer contains the path at all",
    identKeys(DOCKER),
    ["docker-desktop"],
)

group("identKeys derivation")

chk("A1 docker-desktop", identKeys(DOCKER), ["docker-desktop"])
chk("A2 firefox", identKeys(FIREFOX), ["firefox"])
chk("A3 warp", identKeys(WARP), ["dev.warp.warp", "warp-terminal", "warp"])
chk("A4 zed", identKeys(ZED), ["dev.zed.zed", "zed"])
chk("A5 chrome", identKeys(CHROME), ["google-chrome", "google-chrome-stable"])
chk(
    "A6 java keeps both the specific id and the bare interpreter name",
    [identKeys(JAVA).includes("java-java17-openjdk"), identKeys(JAVA).includes("java")],
    [true, true],
)
chk(
    "A7 no derived key is ever a path",
    [DOCKER, FIREFOX, WARP, ZED, CHROME, JAVA]
        .flatMap(identKeys)
        .filter((k) => k.includes("/")),
    [],
)

group("scoring and ranking")

chk("A8 shelly reaches the short class via the dot-segment rule", identKeys(SHELLY), [
    "com.shellyorg.shelly",
    "shelly-ui",
    "shelly",
])

chk(
    "B3 most recently focused window wins a tie",
    pickClient(["firefox"], [FF_OLD, FF_FOCUSED])?.address,
    "0xff0",
)
chk(
    "B4 a window already in the drawer loses to one outside it",
    pickClient(["firefox"], [FF_IN_DRAWER, FF_OLD], { deprioritize: inDrawer })?.address,
    "0xff2",
)
chk(
    "B4b ...but is still picked when it is the only candidate",
    pickClient(["firefox"], [FF_IN_DRAWER], { deprioritize: inDrawer })?.address,
    "0xffd",
)
chk(
    "B5 google-chrome-stable matches google-chrome at the separator boundary",
    scoreClient(["google-chrome-stable"], { address: "0x1", class: "google-chrome" }),
    TIER_BOUNDARY,
)
chk(
    "B6 warp matches its own class exactly after normalization",
    scoreClient(identKeys(WARP), { address: "0x1", class: "dev.warp.Warp" }),
    TIER_EXACT,
)
chk(
    "B7 the bare interpreter name never matches fuzzily",
    [
        scoreClient(["java"], { address: "0x1", class: "javascript-playground" }),
        scoreClient(["java"], { address: "0x1", class: "java" }),
    ],
    [0, TIER_EXACT],
)
chk(
    "B8 a key below the fuzzy floor only matches exactly",
    [
        scoreClient(["zed"], { address: "0x1", class: "unzeddish" }),
        scoreClient(["dev.zed.zed"], { address: "0x1", class: "dev.zed.Zed" }),
    ],
    [0, TIER_EXACT],
)
chk(
    "B9 unrelated windows are not adopted",
    pickClient(identKeys(DOCKER), [
        { address: "0x1", class: "firefox" },
        { address: "0x2", class: "kitty" },
    ]),
    undefined,
)
chk(
    "B10 initialClass matches, but ranks below a live class match",
    scoreClient(["signal"], { address: "0x1", class: "", initialClass: "signal" }),
    TIER_EXACT - INITIAL_PENALTY,
)
chk(
    "B11 excluded addresses are skipped (awaitNewWindow's contract)",
    pickClient(["firefox"], [FF_FOCUSED, FF_OLD], {
        exclude: new Set(["0xff0"]),
    })?.address,
    "0xff2",
)
chk(
    "B12 an exact match on a later key beats a boundary match on the first",
    pickClient(["google-chrome", "chromium-browser"], [
        { address: "0xa", class: "google-chrome-stable" },
        { address: "0xb", class: "chromium-browser" },
    ])?.address,
    "0xb",
)

group("positions.json key-space compatibility")

chk(
    "C1 the old full-path key is still reachable from the new short key",
    keyMatches("docker-desktop", "/opt/docker-desktop/bin/docker-desktop"),
    true,
)
chk(
    "C2 zed's key change is a recorded one-time loss, not a silent one",
    keyMatches("dev.zed.zed", "/home/highz/.local/zed.app/bin/zed"),
    false,
)
chk("C3 chrome's two spellings still bridge", keyMatches("google-chrome-stable", "google-chrome"), true)

if (failed === 0) {
    console.log("\n\x1b[1;32m✓ all match tests passed\x1b[0m")
} else {
    console.log("\n\x1b[1;31m✗ match tests failed\x1b[0m")
}
process.exit(failed)
