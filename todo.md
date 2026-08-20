# hypr-drawer — Release & Distribution TODO

## Extract a drawer app with Super+Alt+drag

- [x] Reproduce the missing gesture at the generated-shortcut boundary.
- [x] Add Super+Alt+left-drag extraction for legacy and Lua providers.
- [x] Stop tracking intentionally extracted windows so they remain outside.
- [x] Document and verify the gesture.

Repo: `github.com/mkamran67/hypr-drawer`

---

## Hyprland Lua config provider support (DONE — pending a real reinstall)

Hyprland ships two config providers in one binary. The hyprlang one is now
namespaced `Config::Legacy` internally; a fresh install with no config
generates `hyprland.lua`. CachyOS already ships a Lua config by default, and
on those machines the installer hooked `hyprland.conf` — a file Hyprland
never reads — so the drawer silently did nothing.

Resolution order, verified against 0.56.2 with `--verify-config`:

| config dir contains                    | provider |
| -------------------------------------- | -------- |
| `hyprland.lua` (with or without `.conf`) | lua      |
| only `hyprland.conf`                     | legacy   |
| neither                                  | lua (generated) |

- [x] `detect_provider()` in `install.sh` — mirror the table above; honour a
      `HYPR_PROVIDER` override so the sandboxed tests stay hermetic. Falls back
      to a running compositor's `configProvider`, then to probing the binary
      with `--verify-config` in a throwaway HOME.
- [x] `config/drawer.lua` + `drawer-bind.lua` templates. `@BIN@` is substituted
      with the real prefix, so a non-default `PREFIX` no longer gets a
      hardcoded `~/.local/bin` the way `drawer.conf` still does.
- [x] `install.sh` — hook `require("drawer")` into `hyprland.lua` under lua,
      keep the `source =` path under legacy.
- [x] `install.sh` — stop `touch`ing `hyprland.conf` unconditionally. On a
      machine with no config yet it creates an empty `.conf` where no `.lua`
      exists, which silently flips the user from lua to the legacy provider.
      The hook file is now never created; a missing one warns and prints the
      line to add by hand. (Creating an empty `hyprland.lua` would be worse
      still — it suppresses the config Hyprland would otherwise generate.)
- [x] `uninstall.sh` — strip the `require` line from `*.lua`, remove
      `drawer.lua` / `drawer-bind.lua`. Both providers are always swept.
- [x] `Hotkey.ts` — `hyprctl keyword` is rejected under lua
      (`keyword can't work with non-legacy parsers. Use eval.`). Write
      `drawer-bind.lua` and drive live rebinds through `hyprctl eval`.
      Settings keeps the hyprlang spelling (`SUPER CTRL, R`) on disk and
      converts to `SUPER + CTRL + R` at the boundary, so an existing
      settings.json survives a provider change untouched.
- [x] `packaging/test-config-hook.sh` — lua cases alongside the legacy ones,
      including a `--verify-config` assertion that the generated Lua parses.
      46 assertions, all green.
- [x] README — note the two providers and how detection works.

Verified end to end against a copy of a real CachyOS Lua config: install
detects `lua`, hooks `hyprland.lua`, and `Hyprland --verify-config` reports
`config ok`; uninstall restores `hyprland.lua` byte-identical.

### Still broken: `hyprctl dispatch` is Lua-parsed too (NEXT)

Found after the first reinstall — the drawer's rail rendered but nothing else
worked. Under the Lua provider `hyprctl dispatch X Y` is wrapped as
`return hl.dispatch(X Y)` and parsed as Lua, so every legacy dispatcher string
is a syntax error:

    $ hyprctl dispatch togglespecialworkspace drawer-DP-2
    error: [string "return hl.dispatch(togglespecialworkspace dra..."]:1:
    ')' expected near 'drawer'

Consequence: `special:drawer-*` never opens, so `decoration:blur:special` has
nothing to blur (the reported "no blur"), and window placement, floating,
drag-to-drawer and geometry restore are all dead. `daemon.log` shows a
`show: Error / execAsyncv` for every toggle.

Verified working replacements:

    hl.dsp.focus({ monitor = "DP-2" })
    hl.dsp.workspace.toggle_special("drawer-DP-2")

- [x] `app/service/Dispatch.ts` — new. Models each compositor action as data
      and serializes per provider, so the two spellings sit side by side and
      are unit-testable without a compositor. Imports nothing from `gi://`.
- [x] `app/service/Provider.ts` — new. Shared provider detection, extracted
      from Hotkey.ts (Hypr.ts needs it too).
- [x] `Hypr.ts` — `dispatch()` now takes an `Action`, not a string. All 12
      call sites converted, plus `Launcher.tsx:739` (`exec [float]`). Under
      lua it uses the argv form of execAsync, since the Lua expression carries
      quotes and commas that `shell_parse_argv` would mangle.
- [x] `uninstall.sh` — eviction pass is provider-aware; trapped windows would
      otherwise stay hidden on a Lua machine with no daemon left to reveal
      them.
- [x] `packaging/test-dispatch.ts` — 25 assertions covering both providers and
      Lua string escaping (a .desktop Exec line with a quote would otherwise
      close the literal early, or inject Lua). Runs under plain node via
      native type stripping: `node packaging/test-dispatch.ts`.
- [x] Every Lua serialization confirmed against a real Hyprland 0.56.2 with
      the lua provider — each returns `ok` with the intended effect.
- [x] `packaging/test-match.ts` - window identity matching (`app/service/Match.ts`).
      A .desktop file with no `StartupWMClass` falls back to Gio's
      `get_executable()`, which is routinely an absolute path, so the drawer
      compared `/opt/docker-desktop/bin/docker-desktop` against the window
      class `docker-desktop` and never matched. "Move the running window into
      the drawer" then fell through to "launch a new one", a no-op for a
      single-instance app: clicking the tile appeared to do nothing. 15 of the
      installed entries on the test machine had a path-shaped identity.
      Runs under plain node: `node packaging/test-match.ts`.

- [ ] Add a live smoke test that dispatches each action against a scratch
      compositor and fails on a non-`ok` reply. The serializer tests pin the
      strings, but only a running Hyprland can catch a dispatcher being
      renamed upstream.
- [x] Make dispatch failures loud (logging half). `Hypr.dispatch` now logs the
      serialized command and rethrows, and `Launcher.launchSafe` catches the
      launch promise every call site used to discard. Before this, a failed
      adoption produced literally nothing - not even a line in `daemon.log`.
- [ ] Make dispatch failures loud (notification half). `show()`/`hide()` still
      swallow into `console.error`, so the rail renders and the install looks
      successful while every compositor call fails - which is exactly why this
      shipped broken. A repeated-failure notification would turn a silent
      breakage into an obvious one.

Known wart, pre-existing and not fixed here: `test-config-hook.sh` runs
`install.sh`, which calls `hyprctl reload` on step 8 whenever Hyprland is
running. A sandboxed test therefore reloads the developer's live compositor
~15 times per run. Harmless (the live config is unrelated to the temp dir) but
rude; step 8 should be skipped when `XDG_CONFIG_HOME` is not the live one.

Deliberate deviation from `drawer.conf`: the Lua template sets only
`decoration.blur.special`, not `size` / `passes` / `xray`. The `.conf`
version force-sets the global blur settings, which stomps whatever the user
already had (on CachyOS, `decorations.lua` sets `size = 5, passes = 4`).
Whether to narrow the legacy `.conf` the same way is an open question below.

## Distribution tiers (roadmap)

### Tier 1 — Git-tag releases + self-update script (NEXT)
Lowest effort, fits the current "clone the repo" install model.
Detailed plan below.

### Tier 2 — AUR package (`hypr-drawer-git` + `hypr-drawer`)
Hyprland's user base is overwhelmingly Arch. A PKGBUILD on AUR turns the
update flow into `yay -Syu` — no custom infrastructure to maintain.
- `hypr-drawer-git` — rolling, builds from `master`.
- `hypr-drawer` — stable, builds from latest tag.
Both PKGBUILDs delegate to `install.sh` semantics (or a slimmer `Makefile`).
Defer until Tier 1 is stable and we have ≥1 external user.

### Tier 3 — GitHub Releases with attached artifacts
Pre-bundled `out.js` + tarball uploaded to each release. `update.sh` curls
the tarball instead of `git pull`. Lets non-cloners install. Skip unless
we get demand from non-developer users.

---

## Tier 1 — Detailed plan

### Goal
1. Every commit can be tagged (`vX.Y.Z`) and published as a GitHub Release.
2. The daemon knows its own version and can compare against the latest
   release on GitHub.
3. Users can update with one command: `./update.sh` (or via a notification
   action surfaced by the daemon).
4. **No auto-applying updates** — always user-initiated. Pulling code onto
   a user's machine without consent is a footgun.

### Components

#### 1. Single source of truth for VERSION
- New file: `VERSION` at repo root, contents like `0.1.0` (no `v` prefix).
- New file: `app/version.ts` — `export const VERSION = "0.1.0"`.
- Keep the two in sync via a tiny `scripts/sync-version.sh` that reads
  `VERSION` and rewrites `app/version.ts`. Run as the first step of the
  release script; CI-friendly later.

#### 2. Update-check service in the daemon
- New file: `app/service/Updates.ts`.
- Polls `https://api.github.com/repos/mkamran67/hypr-drawer/releases/latest`
  once on startup, then once per 24h. Cache last-check timestamp in
  `XDG_STATE_HOME/hypr-drawer/update-check.json` so daemon restarts don't
  spam the API.
- Compare `tag_name` (strip leading `v`) to `VERSION` via semver-ish
  string compare; if newer, fire `notify-send` with title
  "hypr-drawer update available" and body "vA.B.C → vX.Y.Z. Run:
  cd <repo> && ./update.sh".
- Use `Gio.File`/`subprocess` for the HTTP call (curl shell-out is fine —
  no extra dep, already required for Nix installer guidance).
- **Failures are silent.** No nag if GitHub is down or rate-limited.

#### 3. Settings toggle
- `app/service/Settings.ts` — new `checkUpdates` boolean, default `true`.
- Settings UI gains a single checkbox: "Check for updates on startup".
- Honoring the toggle is the only thing that gates `Updates.ts` from
  running.

#### 4. `update.sh`
- Three jobs: `git fetch --tags`, `git pull --ff-only` (refuse on dirty
  tree — bail with a clear message), then `./install.sh`.
- Friendly output: print `current → new` versions before pulling, success
  banner with new version after.

#### 5. Release script
- `scripts/release.sh vX.Y.Z`:
  1. Refuse if working tree is dirty.
  2. Refuse if current branch isn't `master`.
  3. Write `X.Y.Z` to `VERSION`, run `scripts/sync-version.sh`.
  4. `ags bundle app/app.ts /tmp/hypr-drawer-bundle.js` (sanity).
  5. Commit `chore: release vX.Y.Z`, tag `vX.Y.Z`, push both.
  6. `gh release create vX.Y.Z --generate-notes` (auto-changelog from
     commit messages since last tag).

#### 6. README updates
- Installation: keep current steps.
- Updating: "Run `./update.sh` from the cloned repo."
- A small "Versioning" section: semver-ish, breaking changes bump minor
  while pre-1.0.

### Files touched / created

Created:
- `VERSION`
- `app/version.ts`
- `app/service/Updates.ts`
- `update.sh`
- `scripts/sync-version.sh`
- `scripts/release.sh`

Modified:
- `app/app.ts` — call `Updates.checkOnStartup()` in `main()`.
- `app/service/Settings.ts` — add `checkUpdates`.
- `app/widget/` (settings UI file) — add checkbox.
- `install.sh` — improved dep checks (see below).
- `README.md` — update + version sections.

### Verification
1. `./install.sh` on a clean VM with no deps → fails fast with clear
   guidance on each missing piece.
2. `./scripts/release.sh v0.1.0` → tag pushed, GitHub Release created.
3. Bump local `VERSION` to `0.0.9`, restart daemon → notification fires.
4. `./update.sh` from a clean tree → fast-forwards, reinstalls, daemon
   restarts with new VERSION.
5. `./update.sh` from a dirty tree → bails out, no changes.

---

## Install-script dependency-check gaps (do alongside Tier 1)

Current state (`install.sh` + `packaging/deps.sh`):
- ✓ `hyprctl` checked, fatal if missing.
- ✓ `nix` checked, fatal if missing with install instructions.
- ✓ `ags` v3 verified post-install (version + path).
- ✗ `socat`/`jq` — installed via package manager, but **never verified
  afterward**. If `pacman`/`apt` silently no-ops or installs a broken
  version, install.sh marches on and the daemon fails later at runtime.
- ✗ `git` — required for `update.sh`, never checked.
- ✗ `curl` — required for update-check HTTP call, never checked.
- ✗ `notify-send` (`libnotify`) — required to surface update notification.
  Not fatal if missing (we fall back to stderr log), but worth a warning.
- ✗ Unknown package manager case prints `!!` and continues — should be
  fatal unless `socat`/`jq` are already on PATH.

Plan:
- Add a `require_cmds()` helper in `packaging/deps.sh` that takes a list
  of `cmd|hint` pairs and dies with the union of missing commands and
  install hints.
- Run `require_cmds` **before** any installation step: hard-require
  `hyprctl`, `bash`, `git`, `curl`, `nix`. Soft-warn for `notify-send`.
- After `install_socat_jq`, re-check `socat` and `jq` are on PATH; die
  with the distro-specific install command if not.
- Unknown-PM case becomes fatal unless `socat` and `jq` are already
  resolvable.

---

## Open questions (resolve before starting)

- Versioning scheme: semver strict, or "anything goes pre-1.0"? Default
  to semver-ish (MAJOR.MINOR.PATCH, no pre-release suffixes) until 1.0,
  then strict.
- First tag version: `v0.1.0` (current code is feature-complete enough
  for a baseline; below 0.1.0 implies pre-alpha).
- Auto-update polling: daily fine? Or per-launch only?
- Should the legacy `config/drawer.conf` stop force-setting global blur
  (`size`, `passes`, `new_optimizations`, `xray`) and set only
  `decoration:blur:special`, matching the Lua template? It currently
  overrides whatever blur the user already configured. Behaviour change for
  existing legacy installs, so it needs a call rather than a silent fix.
