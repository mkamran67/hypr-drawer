# hypr-drawer — Release & Distribution TODO

Repo: `github.com/mkamran67/hypr-drawer`

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
