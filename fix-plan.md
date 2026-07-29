# hypr-drawer — correctness & safety fixes

> **Status:** planned, not started. Written 2026-07-28. Scope was deliberately
> limited to correctness and safety; see *Deferred* below for what was left out
> on purpose.

## Context

`hypr-drawer` was written on Ubuntu with a single monitor at layout origin `(0,0)`. On that setup, global compositor coordinates and monitor-local coordinates are numerically identical, so three separate places that confuse the two spaces were invisible. The current test machine has three monitors, all with large non-zero origins:

| Monitor | Origin | Size |
| --- | --- | --- |
| HDMI-A-1 | (5430, 2620) | 3440×1440 |
| DP-2 | (3750, 4060) | 5120×1440 |
| HDMI-A-2 | (3510, 2980) | 1920×1080 |

The result is that drag-and-drop — the product's core interaction — is broken, and the uninstaller can leave Hyprland with a config error. This plan fixes those two things and a pair of small correctness bugs alongside them.

**Proven, not assumed** (verified against Hyprland v0.56.0 source and a live session):

- `Compositor.cpp:869-871` — `movewindowpixel exact` takes the literal integers with no `relativeTo` added; `relativeTo` is `position(GEOMETRIC_GOAL)`, the same accessor `hyprctl clients -j .at` reports (`HyprCtl.cpp`). **Everything a hyprctl dispatcher consumes is GLOBAL.**
- `hyprctl cursorpos -j` → `6431,3221` (global); `.at` → `3760` for a window on DP-2 whose origin is `3750` (global).
- Hyprland emits **no** `resizewindow` event. `movewindow` fires only from `moveToWorkspace()`; `changefloatingmode` only on float-toggle; `DragController::dragEnd()` posts nothing. There is no IPC signal for an interactive move or resize.
- `parseWindowVectorArgsRelative` silently returns a no-op if the argument string contains no space — malformed dispatches fail invisibly.

**The invariant this plan establishes:** *anything handed to, or read from, a hyprctl dispatcher is in global layout space. Monitor-local space exists in exactly one place — geometry inside a per-monitor layer-shell window's `Gtk.Fixed`.*

`app/service/Preview.ts:102-135` already implements this correctly and is the reference; it is refactored to use the shared helper but its behavior must not change.

## Scope

**In:** the coordinate bug (3 sites), installer/uninstaller config safety, the dead `resizewindow` branch, the `/run/user` fallback.

**Deferred by decision** (real, but not this pass):

- blocking `hyprctl` subprocess per socket event (`app.ts:413` — `isDrawerOpen()` runs on every line)
- 60 Hz blocking fork during drags (`AppTile.tsx:103-107` calls the synchronous `Hypr.cursorPos()`)
- `pollId` timer leak on widget destroy (`AppTile.tsx:51`; `<For>` rebuilds tiles on every query/favorites/counts change)
- `Memory.update()` full read-modify-write per client inside a loop (`app.ts:147-158`, `app.ts:415-426`)
- `railMonitor` persisted as an unstable GDK index → connector-name migration (`Launcher.tsx:652-663`)
- `Apps.list()` re-parsing every `.desktop` file on each keystroke (`Launcher.tsx:39-48`)
- `Preview.ts` never handles monitor hotplug (`init()` early-returns once populated)
- rail size setting does nothing for `side: top|bottom` (`Launcher.tsx:61` sets `widthRequest` for all four sides)

**Not a bug — do not "fix":**

- `Usage.ts:44-53`. `createState`'s setter is synchronous (`gnim/src/jsx/state.ts:145-149` assigns then notifies inline), so reading the accessor right after the setter returns the new value. `Usage.ts` is correct and `Settings.ts`'s `{ ...snapshot(), key: next }` override is merely redundant. Leave both.
- `install.sh:45`'s `app.ts` symlink. esbuild defaults to `preserveSymlinks: false`, so imports resolve via realpath today.
- `uninstall.sh:63` `[ -L ] || [ -f ] && { … }` parses as `(A||B) && C`, which is intended; and `[ … ] && { … }` is not a `set -e` hazard (bash exempts all but the final command in an `&&` list). Both verified by test.

---

## Phase 1 — Coordinate space

One atomic commit; the sites are interdependent.

### 1.1 Shared helpers in `app/service/Hypr.ts`

Add the invariant as a header comment, then:

```ts
export type Rect = { x: number; y: number; w: number; h: number }

export function rectOf(m: Monitor): Rect | null          // null if hyprctl omitted geometry
export function containsPoint(r: Rect, x: number, y: number): boolean
export function monitorAt(x: number, y: number, mons?: Monitor[]): Monitor | undefined
export function nearestMonitor(x: number, y: number, mons?: Monitor[]): Monitor | undefined
export function toLocal(m: Monitor, x: number, y: number): { x: number; y: number }
```

`monitorAt`'s predicate must be **character-identical** to the existing one in `Preview.move` (`>= m.x`, `< m.x + m.width`, …) so the extraction is provably behavior-preserving — verify by diff, not by eye.

`nearestMonitor` is required, not optional: this layout has genuine dead space (e.g. `x≈3600, y≈2700` is on no monitor), so `monitorAt` can legitimately miss.

`toLocal` is the **only** legal bridge to local space and is only ever called immediately before a `Gtk.Fixed.move()`.

### 1.2 New module `app/service/RailState.ts`

`Layout.isOverRail` needs to know which monitor the rail is on. That state lives in `Launcher.tsx:14`, and the import graph runs `Launcher → AppTile → Layout`, so importing Launcher from Layout would create a cycle through modules that call `createState` at import time. Extract instead:

```ts
export const [railMonitor, setRailMonitor] = createState<any>(null)  // Gdk.Monitor | null
export function railMonitorName(): string | null                     // get_connector()
export function setRailWindow(w: any): void
export function thickness(): number   // live widget extent, falling back to Settings.width()
```

`thickness()` reads the actual widget width/height rather than `Settings.width()`, because `Launcher.tsx:61` sets `widthRequest` for all four sides — which for a top/bottom-anchored bar controls width, not height.

Graph stays acyclic: `Settings` ← `RailState` ← `Layout`, `Launcher`.

`Launcher.tsx` drops its local `railMon` state and delegates `setLauncherMonitor` (line 29) to `RailState`; the window's `$=` callback (line 62) registers `setRailWindow(self)`.

### 1.3 Site 1 — `app/service/Layout.ts:17-27` (fix first; it gates the others)

Delete `primaryMonitor()` entirely — it hardcodes GDK monitor index 0 and discards `g.x`/`g.y`. Rewrite `isOverRail` to resolve the rail's actual monitor via `RailState.railMonitorName()`, bail if the point isn't on that monitor, then test the strip against the monitor's **global** rect (`x < r.x + t`, `x >= r.x + r.w - t`, …).

Change the failure mode from fail-closed to **fail-open** (`return false` on unknown rail monitor). Failing closed is precisely what silently swallowed drops.

Current behavior for the record — this determines how you reproduce it:

- `side: left` (the default) → `x < 360` against a global x never below 3510 → **always false**. Drops are *not* discarded; they proceed with wrong coordinates and land under the rail.
- `side: right`/`bottom` → the test is **always true** → **100% of drops silently discarded**, which masks the Spawn bug completely.

### 1.4 Site 2 — `app/service/Spawn.ts:105-106`

Delete `localX`/`localY` and pass the global drop point straight through to `centeredGeom`. All three call sites in `dropApp` (lines 119, 143, 151) change identically.

Add `clampToMonitor(m, geom)` and wrap every `applyGeom` argument in it — now that a hit-test miss falls back to `nearestMonitor`, a drop near an edge must not park the window off-screen.

Rewrite `resolveTargetMonitor` (line 10) to hit-test via `Hypr.monitorAt` **unconditionally** — the `Settings.blurAllMonitors()` gate at line 18 is removed. It has to go: with coordinates correctly global, a gated drop would move the window into `special:drawer-<focused>` while positioning it at another monitor's coordinates, so workspace membership and geometry would contradict each other.

> **User-visible behavior change — call it out in the commit message.** With "blur all monitors" off, a drop released over a different monitor now lands *there* rather than on the focused monitor. This was the chosen behavior.

Fallback order becomes: `monitorAt` → saved monitor (by connector name, then legacy numeric id) → `nearestMonitor` → focused → `mons[0]`.

### 1.5 Site 3 — `app/app.ts:316-319` (`settleOrphanGeometry`)

Add the monitor origin: `centerX = r.x + Math.round(r.w / 2)` (same for `y`), via `Hypr.rectOf(mon)`. Also wrap the `saved` branch at lines 301-308 in `clampToMonitor` — geometry saved from a since-removed monitor currently parks the window off-screen.

### 1.6 Site 0 — `app/service/Preview.ts:102-135` (behavior preserved)

Swap the inline hit-test for `Hypr.monitorAt(x, y, mons)` and the inline `x - (host.x ?? 0)` for `Hypr.toLocal(host, x, y)`. Everything else, including the clamp against `e.width`/`e.height`, stays exactly as-is — that clamp is correct precisely because `Gtk.Fixed` is monitor-local.

### 1.7 Memory monitor key

`app.ts:156` and `app.ts:424` persist `monitor: String(c.monitor)` — a Hyprland numeric id that is reassigned on replug. Write the connector name instead. `resolveTargetMonitor` (1.4) already reads both, so existing `positions.json` files keep working.

**No `positions.json` migration is needed.** It was always written from `c.at`, which is already global; only the *consumption* was wrong.

---

## Phase 2 — Installer / uninstaller config safety

Bash only; independent of Phase 1.

### 2.1 `uninstall.sh:48-61` — the dangling `source =`

Three defects compound into one broken config:

1. The awk strips `source =` only when it directly follows the `# Added by hypr-drawer installer` marker (verified: without the marker, the line survives).
2. It only ever inspects `hyprland.conf`. HyDE — which the test machine runs — and most dotfile frameworks move user `source` lines into `userprefs.conf`.
3. `drawer.conf` is deleted **unconditionally** at line 61, so any surviving `source` line becomes a hard config error on next reload.

Rewrite as: `grep -rlF "$DRAWER_CONF" "$HYPR_CONF_DIR" --include='*.conf'` to find every referencing file → strip the source line from each **with or without** the marker (buffering the marker comment so it's only re-emitted when it wasn't ours) → delete `drawer.conf` **only if nothing references it any more**, warning otherwise.

Write results with `cat "$tmp" > "$f"`, not `mv` — `mv` replaces the inode and destroys symlinks, and dotfile frameworks symlink these files into a git repo.

### 2.2 `uninstall.sh:66` — unconditional state wipe

`rm -rf "$STATE_DIR"` destroys `settings.json`, `positions.json` and `usage.json` with no prompt. Gate behind a `--purge` flag; default to leaving it and printing the path.

### 2.3 `install.sh:66-77` — the symmetric bug

`grep -Fxq "$SOURCE_LINE" "$HYPR_CONF"` also only inspects `hyprland.conf`, so a user who has moved the source line into `userprefs.conf` gets a **duplicate** on reinstall. Use the same repo-wide `grep -rlF` search before deciding to append. Same helper, same commit.

---

## Phase 3 — Small correctness fixes

### 3.1 `app/app.ts:414` — delete the dead `resizewindow` branch

Remove `resizewindow` from the regex and add a comment citing `src/layout/supplementary/DragController.cpp` (which posts nothing on drag begin/end) so nobody re-adds it. Keep `movewindow`/`openwindow`/`closewindow`.

Also correct the misleading comment at `app.ts:238-239` — geometry does **not** persist live. It persists on every `hide()`, so the gap is narrow: changes are lost only if the daemon dies while the drawer is open. That gap is accepted and documented, not closed.

### 3.2 `app/app.ts:325` — `/run/user` is UID-keyed

`/run/user/${GLib.get_user_name()}` yields `/run/user/mk`; the directory is `/run/user/1000`. Replace the guess with a probe over `XDG_RUNTIME_DIR`, `/run/user/<uid>` (via `Gio.Credentials.new().get_unix_user()`), and `/tmp/hypr/<his>` (Hyprland < 0.41), taking the first that exists.

Log loudly when none is found. Today a wrong path produces a `socat` that dies into a `console.error` nobody reads, silently killing the entire event pipeline — every shade refresh and geometry save depends on it.

---

## Verification

### Gate 0 — before touching any coordinate code

Already proven from source, but confirm on the live compositor, since every Phase 1 change rests on it. Uses a scratch window and is fully reversible:

```bash
hyprctl dispatch exec [float] kitty; sleep 2
A=$(hyprctl -j clients | jq -r '.[]|select(.class=="kitty")|.address' | head -1)
read X Y <<<"$(hyprctl -j clients | jq -r --arg a "$A" '.[]|select(.address==$a)|"\(.at[0]) \(.at[1])"')"
hyprctl dispatch movewindowpixel "exact $X $Y,address:$A"; sleep 0.5   # identity → must be a no-op
hyprctl -j clients | jq -r --arg a "$A" '.[]|select(.address==$a)|.at'
hyprctl dispatch movewindowpixel "exact $((X+100)) $Y,address:$A"; sleep 0.5
hyprctl -j clients | jq -r --arg a "$A" '.[]|select(.address==$a)|.at'  # must be exactly +100
hyprctl dispatch killactive
```

Decisive because the origins are in the thousands: if the space were monitor-local, feeding a global `X` back would displace the window by 3750 or 5430 px. **Do not start Phase 1 until this passes.**

### Phase 1

`Hypr.monitorAt` / `rectOf` / `toLocal`, `Spawn.centeredGeom` / `clampToMonitor`, and `Layout.isOverRail` are all pure given an injected `mons[]`. Use the real three-monitor table as fixtures:

- `monitorAt(6431, 3221)` → HDMI-A-1; `monitorAt(3760, 4100)` → DP-2; `monitorAt(3600, 2700)` → **undefined** (dead space — exercises the `nearestMonitor` fallback).
- `isOverRail` with side=left, rail on HDMI-A-1: `(5500, 3000)` true; `(6431, 3221)` false; `(3760, 4100)` false (different monitor — the old code got this wrong in both directions).
- `clampToMonitor(DP-2, centeredGeom(3760, 4100, {w:720,h:480}))` stays within `3750..8870 × 4060..5500`.

Runtime, once ags v3 is installed — drag one tile onto each of the three monitors and assert the window centre matches the recorded `cursorpos` within ±2 px:

```bash
hyprctl -j clients | jq -r '.[]|select(.workspace.name|startswith("special:drawer-"))|"\(.class) at=\(.at) size=\(.size)"'
```

Pre-fix this is wrong by exactly `(mon.x, mon.y)` — 3750 or 5430 px, unmissable. Then repeat with `side: right`: pre-fix **zero** windows appear (every drop swallowed), post-fix all three land.

### Phase 2 — sandboxed, no risk to the real config

```bash
T=$(mktemp -d)
XDG_CONFIG_HOME=$T/config XDG_STATE_HOME=$T/state PREFIX=$T/local ./install.sh
grep -rn "drawer.conf" $T/config/hypr        # exactly one source line
XDG_CONFIG_HOME=$T/config XDG_STATE_HOME=$T/state PREFIX=$T/local ./uninstall.sh
grep -rn "drawer.conf" $T/config/hypr        # expect nothing
test -e $T/config/hypr/drawer.conf && echo FAIL
```

Three further cases: (a) move the source line into `userprefs.conf`, re-run install → must not duplicate, then uninstall → must strip it; (b) delete the marker comment but keep the source line → uninstall must still strip it; (c) make a referencing file a symlink → the symlink must survive.

Then for real: `./uninstall.sh && hyprctl reload && hyprctl configerrors` → expect no errors.

### Cross-cutting

`npx tsc --noEmit -p app/tsconfig.json` after each phase — note `strict: false`, so it catches less than usual; don't lean on it. `shellcheck install.sh uninstall.sh packaging/deps.sh` for Phase 2 (shellcheck is not currently installed). Once ags v3 is present, `ags bundle app/app.ts /dev/null` is the real syntax gate.

## Critical files

- `app/service/Hypr.ts` — new helpers, the invariant comment
- `app/service/Layout.ts` — highest-impact single fix
- `app/service/RailState.ts` — new, breaks the import cycle
- `app/service/Spawn.ts` — drop path
- `app/app.ts` — orphan geometry, memory key, dead event branch, socket path
- `app/service/Preview.ts` — refactor to shared helper, behavior unchanged
- `app/widget/Launcher.tsx` — delegate rail state
- `uninstall.sh`, `install.sh`
