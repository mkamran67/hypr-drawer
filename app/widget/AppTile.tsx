import { Gtk, Gdk } from "ags/gtk4"
import GObject from "gi://GObject"
import GLib from "gi://GLib"
import { createComputed, createState } from "ags"
import { AppEntry } from "../service/Apps"
import { setActiveDrag, clearActiveDrag } from "../service/DragState"
import * as Preview from "../service/Preview"
import * as Spawn from "../service/Spawn"
import * as Hypr from "../service/Hypr"
import * as Layout from "../service/Layout"
import * as Settings from "../service/Settings"
import * as Usage from "../service/Usage"
import * as Favorites from "../service/Favorites"

type Mode = "tiles" | "grid" | "compact"

type Props = {
    app: AppEntry
    onLaunch: (app: AppEntry, modifiers: number) => void
    mode?: Mode
}

// Each tile is a click-to-launch button AND a Wayland drag source. The drag
// source provides the icon ghost; we drive the preview rectangle + drop
// dispatch ourselves on drag-begin/drag-end, because cross-surface DnD into
// our layer-shell overlay doesn't deliver events on this stack.
export default function AppTile({ app, onLaunch, mode = "tiles" }: Props) {
    const drag = new Gtk.DragSource({ actions: Gdk.DragAction.COPY })
    drag.propagationPhase = Gtk.PropagationPhase.CAPTURE

    const tileClasses = ["app-tile", `app-tile-${mode}`]

    // The star only appears while the pointer is over the tile, unless the app
    // is already a favorite - a permanent star on every row would out-shout the
    // app icons. GTK's :hover would only match the widget actually under the
    // pointer, so the overlay tracks it explicitly and shares it with its
    // sibling star.
    //
    // It sits on the left: the ScrolledWindow's overlay scrollbar materializes
    // over the right edge of the list and would swallow a star parked there.
    const [hovered, setHovered] = createState(false)
    const isFav = createComputed(() => Usage.isFavorite(app.desktopId))
    const starVisible = createComputed(() => isFav() || hovered())
    const starGlyph = createComputed(() => Favorites.starGlyph(isFav()))
    const starTip = createComputed(() => Favorites.starTooltip(isFav()))
    const starClasses = createComputed(() =>
        isFav() ? ["fav-star", `fav-star-${mode}`, "is-fav"] : ["fav-star", `fav-star-${mode}`],
    )

    drag.connect("prepare", () => {
        const payload = JSON.stringify(app)
        const value = new GObject.Value()
        value.init(GObject.TYPE_STRING)
        value.set_string(payload)
        return Gdk.ContentProvider.new_for_value(value)
    })

    let lastModifiers = 0
    const keyCtl = new Gtk.EventControllerKey()
    keyCtl.connect("key-pressed", (_c, _k, _kc, state) => {
        lastModifiers = state
        return false
    })

    let pollId = 0
    function stopPoll() {
        if (pollId) {
            GLib.source_remove(pollId)
            pollId = 0
        }
    }

    function readModifierState(): number {
        try {
            const display = Gdk.Display.get_default()
            const seat = display?.get_default_seat()
            return seat?.get_keyboard()?.get_modifier_state?.() ?? 0
        } catch {
            return 0
        }
    }

    return (
        <overlay
            $={(self: Gtk.Overlay) => {
                const motion = new Gtk.EventControllerMotion()
                motion.connect("enter", () => setHovered(true))
                motion.connect("leave", () => setHovered(false))
                self.add_controller(motion)
            }}
        >
            <button
                cssClasses={tileClasses}
                tooltipText={app.name}
                onClicked={() => onLaunch(app, lastModifiers)}
                $={(self) => {
                    self.add_controller(drag)
                    self.add_controller(keyCtl)

                    // Right-click toggles favorite. Works regardless of whether
                    // the favorites toggle is enabled — that flag only controls
                    // whether favorites influence the visible ordering, so the
                    // user can pre-mark apps before flipping the setting on.
                    const rclick = new Gtk.GestureClick({ button: Gdk.BUTTON_SECONDARY })
                    rclick.connect("pressed", () => {
                        Usage.toggleFavorite(app.desktopId)
                    })
                    self.add_controller(rclick)

                    drag.connect("drag-begin", () => {
                        try {
                            const paintable = Gtk.WidgetPaintable.new(self)
                            drag.set_icon(paintable, 0, 0)
                        } catch (e) {
                            console.error("drag-begin set_icon:", e)
                        }
                        setActiveDrag(app)
                        Preview.show(app)
                        // Prime position so the rect doesn't flash at (0, 0).
                        const p0 = Hypr.cursorPos()
                        if (p0) Preview.move(p0.x, p0.y)

                        stopPoll()
                        // ~60Hz cursor polling for smooth preview tracking.
                        pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                            const p = Hypr.cursorPos()
                            if (p) Preview.move(p.x, p.y)
                            return true
                        })
                    })

                    drag.connect("drag-end", () => {
                        stopPoll()
                        const p = Hypr.cursorPos()
                        Preview.hide()
                        clearActiveDrag()
                        if (!p) return
                        if (Layout.isOverRail(p.x, p.y)) return
                        const mods = readModifierState()
                        const forceNew = !!(
                            mods &
                            (Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.CONTROL_MASK)
                        )
                        Spawn.dropApp(app, p.x, p.y, forceNew).catch(console.error)
                    })

                    drag.connect("drag-cancel", () => {
                        stopPoll()
                        Preview.hide()
                        clearActiveDrag()
                        return false
                    })
                }}
            >
                {renderBody(app, mode)}
            </button>
            <button
                $type="overlay"
                cssClasses={starClasses}
                visible={starVisible}
                tooltipText={starTip}
                canFocus={false}
                halign={Gtk.Align.START}
                valign={mode === "compact" ? Gtk.Align.CENTER : Gtk.Align.START}
                onClicked={() => Usage.toggleFavorite(app.desktopId)}
            >
                <label cssClasses={["fav-star-glyph"]} label={starGlyph} />
            </button>
        </overlay>
    )
}

// Largest icon pixel size that lets `cols` icons sit inside the rail with
// no horizontal overflow. Subtracts the fixed paddings around the FlowBox
// (launcher-root 12 × 2, app-tile-grid 2 × 2, vertical scrollbar reserve
// ~14, FlowBox column gaps 4 px each, and per-tile padding 2 × 2).
function gridIconSizeFor(cols: number, railWidth: number): number {
    const availContent = railWidth - 24 - 4 - 14
    const cellWidth = (availContent - 4 * (cols - 1)) / cols
    return Math.max(16, Math.min(192, Math.floor(cellWidth - 4)))
}

function renderBody(app: AppEntry, mode: Mode) {
    if (mode === "grid") {
        return (
            <image
                iconName={app.icon}
                pixelSize={createComputed(() =>
                    gridIconSizeFor(Settings.gridColumns(), Settings.width()),
                )}
            />
        )
    }
    if (mode === "compact") {
        return (
            <box orientation={Gtk.Orientation.HORIZONTAL} spacing={8}>
                <image iconName={app.icon} pixelSize={20} />
                <label
                    label={app.name}
                    xalign={0}
                    hexpand
                    ellipsize={3}
                    canFocus={false}
                    selectable={false}
                />
            </box>
        )
    }
    return (
        <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
            <image iconName={app.icon} pixelSize={48} />
            <label
                label={app.name}
                maxWidthChars={12}
                ellipsize={3}
                canFocus={false}
                selectable={false}
            />
        </box>
    )
}
