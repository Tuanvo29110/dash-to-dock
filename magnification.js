// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    GLib,
    GObject,
    Meta,
    Pango,
    Shell,
    St,
} from './dependencies/gi.js';

import {Main} from './dependencies/shell/ui.js';

import {
    AppIcons,
    Docking,
} from './imports.js';

// Hover magnification adapted from ubuntu/dash-to-dock PR #2681,
// inspired by simple-taskbar's animation behavior. Resize item cells to
// make room for neighboring icons and paint enlarged copies above the dock.
// Use a raised-cosine falloff and time-based smoothing driven by Mutter frames.
const MAGNIFY_EXTENT = 7; // falloff radius, iconSize * MAGNIFY_EXTENT / 2
const MAGNIFY_ENGAGE_MS = 45; // time constant to grow and shrink the icons
const MAGNIFY_FOLLOW_MS = 20; // time constant to follow the pointer
const MAGNIFY_LEVEL_EPSILON = 0.005;
const MAGNIFY_POINTER_EPSILON = 0.25;
const FRAME_MS = 16.6;

// The theme highlight stays at the resting position, so hide it while the
// icon is drawn somewhere else.
const MAGNIFIED_ICON_STYLE =
    'background-color: transparent; background-image: none; box-shadow: none;';

function getStageRect(actor) {
    if (!actor.has_allocation())
        return null;

    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return [x, y, width, height].every(Number.isFinite)
        ? {x, y, width, height} : null;
}

// Inline style drawing a label like the given one, `ratio` times larger
function getScaledLabelStyle(label, ratio) {
    const node = label.get_theme_node();
    const font = node.get_font();
    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
    const length = value => `${value * ratio / scaleFactor}px`;
    const color = ({red, green, blue, alpha}) =>
        `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
    const fontSize = font.get_size() / Pango.SCALE;

    return [
        `color: ${color(node.get_foreground_color())}`,
        `background-color: ${color(node.get_background_color())}`,
        `border: ${length(node.get_border_width(St.Side.TOP))} solid ${
            color(node.get_border_color(St.Side.TOP))}`,
        `border-radius: ${length(node.get_border_radius(St.Corner.TOPLEFT))}`,
        `font-family: ${font.get_family()}`,
        `font-weight: ${font.get_weight()}`,
        `font-size: ${font.get_size_is_absolute()
            ? length(fontSize) : `${fontSize * ratio}pt`}`,
    ].join(';');
}

/**
 * macOS-like magnification of the dash icons.
 *
 * Each magnified icon is replaced by a copy living in an overlay above the
 * dock (the dash itself is clipped by its scroll view): a sharp texture of the
 * icon plus live copies of its decorations (notification badge, progress bar,
 * hot-key number).
 */
export class DockMagnifier {
    constructor({dash, area, box, scrollView, position}) {
        this._dash = dash;
        // Holds both the applications and the show apps button
        this._area = area;
        this._box = box;
        this._scrollView = scrollView;
        this._position = position;
        this._isHorizontal = position === St.Side.TOP || position === St.Side.BOTTOM;
        this._adjustment = this._isHorizontal
            ? scrollView.hadjustment ?? scrollView.hscroll.adjustment
            : scrollView.vadjustment ?? scrollView.vscroll.adjustment;

        this._clones = new Map();
        // Items whose size along the dock axis has been overridden
        this._resized = new Set();
        // Reasons (drags, open menus) to keep the icons at rest
        this._suspensions = new Set();
        this._visible = false;
        // Pointer coordinate along the dock axis, or null when outside
        this._pointer = null;
        // Where the effect is centered, and how strong it currently is
        this._focus = 0;
        this._engagement = 0;
        this._resting = null;
        this._laterId = 0;
        this._lastFrameTime = 0;
        this._needsFrames = false;

        // The overlay must never be picked, or it would hide the dock from
        // drag and drop, which also considers non-reactive actors.
        this._overlay = new Clutter.Actor({reactive: false, visible: false});
        Shell.util_set_hidden_from_pick(this._overlay, true);
        Main.layoutManager.uiGroup.add_child(this._overlay);

        const onChildrenChanged = child => {
            // The separator is re-added on every redisplay
            if (child.style_class !== 'dash-separator')
                this.reset();
        };

        area.reactive = true;
        this._signals = [];
        const connect = (object, signal, callback) =>
            this._signals.push([object, object.connect(signal, callback)]);

        connect(area, 'motion-event', (_a, event) => this._onMotion(event));
        connect(area, 'leave-event', (_a, event) => this._onLeave(event));
        connect(area, 'notify::mapped', () => {
            if (area.mapped)
                this._syncPointer();
            else
                this._clearPointer();
        });
        // Keep the copies in place when the layout moves under them
        connect(area, 'notify::allocation', () => this._followLayout());
        connect(box, 'notify::allocation', () => this._followLayout());
        connect(this._adjustment, 'notify::value', () => this._followLayout());
        connect(box, 'child-added', (_box, child) => onChildrenChanged(child));
        // A removed app may finish animating out after the redisplay.
        connect(box, 'child-removed', (_box, child) => {
            this._suspensions.delete(child);
            onChildrenChanged(child);
        });

        const {settings} = Docking.DockManager;
        ['magnify-icons', 'magnification-factor', 'magnification-rise'].forEach(
            key => connect(settings, `changed::${key}`, () => this.reset()));
    }

    // Only called when the whole dash is being destroyed, so there's nothing
    // to restore on its actors: doing that would just trigger a relayout of a
    // half destroyed hierarchy.
    destroy() {
        this._destroyed = true;
        this._stopFrames();
        this._signals.forEach(([object, id]) => object.disconnect(id));
        this._signals = [];
        this._clones.forEach(clone => this._disconnectClone(clone));
        this._clones.clear();
        this._resized.clear();
        this._resting = null;
        this._overlay.destroy();
        this._overlay = null;
    }

    // The copies live outside the sliding dock, so they can only be shown
    // while the dock is fully on screen.
    setVisible(visible) {
        if (this._destroyed || this._visible === visible)
            return;

        this._visible = visible;
        this._overlay.visible = visible;

        if (visible)
            this._syncPointer();
        else
            this._clearPointer();
    }

    suspend(reason) {
        if (this._destroyed)
            return;

        this._suspensions.add(reason);
        this.reset();
    }

    resume(reason) {
        if (this._destroyed || !this._suspensions.delete(reason))
            return;

        this._syncPointer();
    }

    // Drops all the geometry, to be computed again from the current layout.
    reset() {
        if (this._destroyed)
            return;

        this._stopFrames();
        this._settle();
        this._startFrames();
    }

    get _translationProperty() {
        return this._isHorizontal ? 'translation_x' : 'translation_y';
    }

    // The dock actor holding the dash along with its decorations
    get _dockBox() {
        return this._dash.get_parent();
    }

    // Alignment along the dock axis
    get _alignProperty() {
        return this._isHorizontal ? 'x_align' : 'y_align';
    }

    get _active() {
        return this._visible && this._area.mapped && !this._suspensions.size;
    }

    _clearPointer() {
        this._pointer = null;
        this.reset();
    }

    _syncPointer() {
        const [x, y] = global.get_pointer();
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        this._pointer = actor && this._area.contains(actor)
            ? this._isHorizontal ? x : y
            : null;
        this._startFrames();
    }

    _onMotion(event) {
        const [x, y] = event.get_coords();
        this._pointer = this._isHorizontal ? x : y;
        this._startFrames();
        return Clutter.EVENT_PROPAGATE;
    }

    _onLeave(event) {
        // Crossing between the area and its children is not leaving it
        const related = event.get_related();
        if (related && this._area.contains(related))
            return Clutter.EVENT_PROPAGATE;

        this._pointer = null;
        this._startFrames();
        return Clutter.EVENT_PROPAGATE;
    }

    _followLayout() {
        if (this._clones.size)
            this._startFrames();
    }

    // Drives the effect off Mutter's laters API instead of a fixed timer, so
    // it stays in sync with actual frames. It stops once the animation
    // settles and restarts on the next change.
    _startFrames() {
        if (this._laterId || !this._active ||
            (this._pointer === null && !this._resting))
            return;

        this._lastFrameTime = 0;
        this._laterId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._update();

                if (this._needsFrames)
                    return GLib.SOURCE_CONTINUE;

                this._laterId = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    _stopFrames() {
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        this._needsFrames = false;
    }

    _getItems() {
        const items = this._box.get_children().filter(item =>
            item.child?._delegate?.icon?.icon && !item.animatingOut);
        const showApps = this._dash._showAppsIcon;
        if (showApps?.visible && showApps.get_parent() && showApps.icon.icon)
            items.push(showApps);
        return items;
    }

    // The parts of a dash item that take part in the effect
    _getTarget(item) {
        if (item === this._dash._showAppsIcon) {
            const baseIcon = item.icon;
            return {
                actor: item.child,
                baseIcon,
                createTexture: size => {
                    const source = baseIcon.icon;
                    const {red, green, blue, alpha} =
                        source.get_theme_node().get_foreground_color();
                    return new St.Icon({
                        gicon: source.gicon,
                        iconSize: size,
                        style: `color: rgba(${red},${green},${blue},${alpha / 255});`,
                    });
                },
            };
        }

        const appIcon = item.child._delegate;
        return {
            actor: appIcon,
            baseIcon: appIcon.icon,
            // Holds the icon along with its badges and the like
            container: appIcon._iconContainer,
            createTexture: size => appIcon.app.create_icon_texture(size),
        };
    }

    // Size and position of the items when not magnified. Positions are in
    // stage coordinates, so that they don't move along with the dock as it
    // grows around the magnified icons.
    _measureRestingLayout(items) {
        const isSettled = this._box.has_allocation() &&
            [...this._box.get_children(), ...items].every(c => !c.visible ||
                c.has_allocation() && !c.animatingOut &&
                c.scale_x === 1 && c.scale_y === 1);
        if (!isSettled)
            return null;

        const axis = this._isHorizontal ? 0 : 1;
        const getSpan = actor => {
            const start = actor.get_transformed_position()[axis];
            return [start, start + actor.get_transformed_size()[axis]];
        };
        const spans = new Map(items.map(item => {
            const [start, end] = getSpan(item);
            const box = item.get_allocation_box();
            return [item, {
                start,
                length: end - start,
                size: this._isHorizontal ? box.get_width() : box.get_height(),
            }];
        }));

        return {
            scroll: this._adjustment.value,
            room: this._getRoom(),
            dock: getSpan(this._dockBox),
            radius: this._getRadius([...spans.values()]),
            // Where the first item starts and the last one ends
            extent: [
                Math.min(...[...spans.values()].map(s => s.start)),
                Math.max(...[...spans.values()].map(s => s.start + s.length)),
            ],
            items: spans,
        };
    }

    // How much longer the dock can get without pushing icons out of view
    _getRoom() {
        const maxLength = this._isHorizontal
            ? this._dash.maxWidth : this._dash.maxHeight;
        if (maxLength === -1)
            return Infinity;

        const box = this._area.get_allocation_box();
        const length = this._isHorizontal ? box.get_width() : box.get_height();
        return Math.max(0, maxLength - length);
    }

    // How far from its center the effect reaches. With a whole number of
    // icons on each side the total growth, and so the length of the dock,
    // stays steady while the pointer moves along it.
    _getRadius(spans) {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const radius = this._dash.iconSize * scaleFactor * MAGNIFY_EXTENT / 2;
        const centers = spans.map(({start, length}) => start + length / 2)
            .sort((a, b) => a - b);
        const gaps = centers.slice(1).map((c, i) => c - centers[i])
            .sort((a, b) => a - b);
        // The median ignores the wider gap around the separator
        const pitch = gaps[Math.floor(gaps.length / 2)] ??
            spans[0]?.length;
        return pitch > 0 ? pitch * Math.max(1, Math.round(radius / pitch)) : radius;
    }

    // Computes the effect for one frame
    _update() {
        const {settings} = Docking.DockManager;
        const maxScale = Math.max(1, settings.magnificationFactor);
        const items = this._getItems();
        const engaged = this._pointer !== null && settings.magnifyIcons &&
            maxScale > 1 && items.length > 0;
        this._needsFrames = false;

        if (!this._resting) {
            if (!engaged)
                return;

            this._resting = this._measureRestingLayout(items);
            if (!this._resting) {
                // Wait for the layout to be ready
                this._needsFrames = true;
                return;
            }
        }

        this._advanceAnimation(engaged);

        if (!engaged && !this._engagement) {
            this._settle();
            return;
        }

        // other chrome can get stacked between the dock and the overlay
        this._raiseOverlay();
        this._layoutItems(items, maxScale);
    }

    // The icons grow and shrink smoothly, while the center of the effect
    // closely follows the pointer, staying where it was last seen.
    _advanceAnimation(engaged) {
        const now = GLib.get_monotonic_time();
        const elapsed = this._lastFrameTime
            ? (now - this._lastFrameTime) / 1000 : FRAME_MS;
        this._lastFrameTime = now;
        // Fraction of the remaining distance to cover in this frame
        const step = timeConstant => 1 - Math.exp(-elapsed / timeConstant);

        if (this._pointer !== null) {
            if (this._engagement > 0) {
                this._focus +=
                    (this._pointer - this._focus) * step(MAGNIFY_FOLLOW_MS);
            } else {
                this._focus = this._pointer;
            }

            if (Math.abs(this._pointer - this._focus) < MAGNIFY_POINTER_EPSILON)
                this._focus = this._pointer;
            else
                this._needsFrames = true;
        }

        const target = engaged ? 1 : 0;
        this._engagement += (target - this._engagement) * step(MAGNIFY_ENGAGE_MS);
        if (Math.abs(target - this._engagement) < MAGNIFY_LEVEL_EPSILON)
            this._engagement = target;
        else
            this._needsFrames = true;
    }

    _layoutItems(items, maxScale) {
        const {radius} = this._resting;
        const scrolled = this._adjustment.value - this._resting.scroll;
        const axis = this._isHorizontal ? 'width' : 'height';

        const cells = items.filter(item => this._resting.items.has(item)).map(item => {
            const resting = this._resting.items.get(item);
            const start = resting.start - scrolled;
            const distance = Math.abs(this._focus - (start + resting.length / 2));
            const level = distance < radius
                ? this._engagement * (Math.cos(distance * Math.PI / radius) + 1) / 2
                : 0;
            const scale = 1 + (maxScale - 1) * level;
            return {
                item, level, scale, resting,
                growth: resting.size * (scale - 1),
            };
        });

        // The dock grows by an even number of pixels, so that it doesn't
        // wobble when centered. Sizes are then rounded cumulatively, so that
        // every item doesn't jitter on its own. An almost full dock grows
        // less, and the enlarged icons get closer to each other.
        const exactGrowth = cells.reduce((sum, c) => sum + c.growth, 0);
        const growth = Math.min(2 * Math.round(exactGrowth / 2),
            2 * Math.floor(this._resting.room / 2));
        const ratio = exactGrowth > 0 ? growth / exactGrowth : 0;
        let cumulated = 0;
        let rounded = 0;

        cells.forEach(({item, resting, growth: itemGrowth}) => {
            cumulated += itemGrowth * ratio;
            const extra = Math.round(cumulated) - rounded;
            rounded += extra;

            // Real, along-axis-only resize of the item's own cell, relative
            // to its own resting size (not just the icon's), so the dash
            // reflows around it and the dock background follows.
            const size = resting.size + extra;
            this._resized.add(item);
            if (item[axis] !== size)
                item[axis] = size;
        });

        // Complete the layout now, so that the copies are placed according to
        // it in this same frame, instead of lagging behind their icons.
        this._box.get_allocation_box();
        this._anchorAtFocus(growth, scrolled);

        cells.forEach(({item, level, scale}) => {
            // Copies are kept until the pointer leaves, as creating them
            // again while it moves back and forth would cause stutters.
            let clone = this._clones.get(item);
            if (!clone && level > MAGNIFY_LEVEL_EPSILON)
                clone = this._createClone(item, maxScale);
            if (clone)
                this._updateClone(clone, scale);
        });

        const rowItems = new Set(items);
        [...this._clones.keys()].filter(item => !rowItems.has(item))
            .forEach(item => this._destroyClone(item));
    }

    // A centered dock grows evenly on both sides, moving the icons away from
    // under the pointer. Shift it so that, as on macOS, the point being
    // pointed at stays in place and the icons grow around it.
    _anchorAtFocus(growth, scrolled) {
        // An extended dock has to keep covering the whole screen edge
        if (Docking.DockManager.settings.dockExtended) {
            this._shiftDock(0);
            return;
        }

        const monitor = Main.layoutManager.findMonitorForActor(this._dockBox);
        const [monitorStart, monitorLength] = this._isHorizontal
            ? [monitor.x, monitor.width] : [monitor.y, monitor.height];
        const [start, end] = this._resting.dock;
        const length = end - start + growth;
        // Where the dock should start, without getting out of the screen
        const wanted = Math.round(start - growth * this._shareBeforeFocus(scrolled));
        const target = Math.max(monitorStart,
            Math.min(wanted, monitorStart + monitorLength - length));
        // Where the layout put it
        const axis = this._isHorizontal ? 0 : 1;
        const current = this._dockBox.get_transformed_position()[axis] -
            this._dockBox[this._translationProperty];
        this._shiftDock(Math.round(target - current));
    }

    // Which part of the growth happens before the center of the effect, given
    // by the area under the falloff curve on each side of it. Being continuous,
    // the dock moves smoothly, and stays still while away from its ends.
    _shareBeforeFocus(scrolled) {
        const {radius, extent: [start, end]} = this._resting;
        const area = distance => {
            const x = Math.min(Math.max(distance, 0), radius);
            return x / 2 + radius / (2 * Math.PI) * Math.sin(Math.PI * x / radius);
        };
        const before = area(this._focus - (start - scrolled));
        const after = area(end - scrolled - this._focus);
        return before + after > 0 ? before / (before + after) : 0.5;
    }

    _shiftDock(shift) {
        const property = this._translationProperty;
        if (this._dockBox && this._dockBox[property] !== shift)
            this._dockBox[property] = shift;
    }

    // Brings everything back to its resting state
    _settle() {
        [...this._clones.keys()].forEach(item => this._destroyClone(item));
        [...this._resized].forEach(item => this._restoreSize(item));
        if (this._resting)
            this._shiftDock(0);
        this._resting = null;
        this._engagement = 0;
    }

    _restoreSize(item) {
        if (!this._resized.delete(item))
            return;

        // Removed items are on their way to be destroyed
        if (item.get_parent() && !item.animatingOut)
            item[this._isHorizontal ? 'width' : 'height'] = -1;
    }

    _raiseOverlay() {
        const {uiGroup} = Main.layoutManager;
        let dockActor = this._box;
        while (dockActor && dockActor.get_parent() !== uiGroup)
            dockActor = dockActor.get_parent();

        // Stay right above the dock, so that menus, tooltips and the rest of
        // the shell chrome are still drawn on top of the icons.
        if (dockActor && dockActor.get_next_sibling() !== this._overlay)
            uiGroup.set_child_above_sibling(this._overlay, dockActor);
    }

    _createClone(item, maxScale) {
        const {actor: source, baseIcon, container, createTexture} =
            this._getTarget(item);
        const sourceIcon = baseIcon.icon;

        // BaseIcon.setIconSize() destroys and recreates the original icon.
        // Render a separate, sharp texture instead of rebuilding the actual
        // dock icon the first time the pointer enters the dock.
        const texture = createTexture(Math.round(this._dash.iconSize * maxScale));
        texture.reactive = false;
        texture.set_pivot_point(0.5, 0.5);

        const actor = new Clutter.Actor({reactive: false});
        actor.add_child(texture);
        actor.set_pivot_point(...{
            [St.Side.TOP]: [0.5, 0],
            [St.Side.BOTTOM]: [0.5, 1],
            [St.Side.LEFT]: [0, 0.5],
            [St.Side.RIGHT]: [1, 0.5],
        }[this._position]);

        const clone = {
            item, baseIcon, sourceIcon, container, actor, texture,
            // Copies of the badges and the like, indexed by their source
            decorations: new Map(),
            sourceOpacity: sourceIcon.opacity,
            baseIconStyle: baseIcon.get_style(),
            containerAlign: container?.[this._alignProperty],
            signals: [],
            bindings: [],
        };
        const connect = (object, signal, callback) =>
            clone.signals.push([object, object.connect(signal, callback)]);

        // The icon animator wiggles the icon of urgent applications
        if (baseIcon._iconBin) {
            clone.bindings.push(baseIcon._iconBin.bind_property('rotation-angle-z',
                texture, 'rotation-angle-z', GObject.BindingFlags.SYNC_CREATE));
        }

        connect(source, 'destroy', () => this._destroyClone(item));
        connect(sourceIcon, 'destroy', () => {
            // The icon texture changed, e.g. the trash got full
            this._destroyClone(item);
            this._startFrames();
        });

        sourceIcon.opacity = 0;
        baseIcon.set_style([clone.baseIconStyle, MAGNIFIED_ICON_STYLE]
            .filter(s => s).join(';'));

        if (container) {
            // Badges come and go while hovering
            connect(container, 'child-added', () => this._startFrames());
            connect(container, 'child-removed', (_c, child) => {
                this._removeDecoration(clone, child);
                this._startFrames();
            });
            // Don't let the container grow along with the item, so that the
            // badges and the other decorations stay next to the icon.
            container[this._alignProperty] = Clutter.ActorAlign.CENTER;
        }

        this._overlay.add_child(actor);
        this._clones.set(item, clone);
        return clone;
    }

    _updateClone(clone, scale) {
        const {actor} = clone;
        const rect = getStageRect(clone.sourceIcon);
        if (!rect) {
            this._needsFrames = true;
            return;
        }

        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const lift = (scale - 1) * this._dash.iconSize * scaleFactor *
            Docking.DockManager.settings.magnificationRise;
        const [liftX, liftY] = {
            [St.Side.TOP]: [0, lift],
            [St.Side.BOTTOM]: [0, -lift],
            [St.Side.LEFT]: [lift, 0],
            [St.Side.RIGHT]: [-lift, 0],
        }[this._position];

        // Textures drawn across fractions of a pixel look blurry, so use whole
        // pixel sizes and positions.
        const snappedScale = Math.round(rect.width * scale) / rect.width;
        const [pivotX, pivotY] = actor.get_pivot_point();
        const snap = (origin, pivot, length, offset) => {
            const edge = origin + pivot * length * (1 - snappedScale);
            return Math.round(edge + offset) - edge;
        };
        actor.set_scale(snappedScale, snappedScale);
        actor.translation_x = snap(rect.x, pivotX, rect.width, liftX);
        actor.translation_y = snap(rect.y, pivotY, rect.height, liftY);

        actor.visible = this._isInView(clone.item, rect);
        actor.set_position(rect.x, rect.y);
        actor.set_size(rect.width, rect.height);
        clone.texture.set_size(rect.width, rect.height);
        this._updateDecorations(clone, rect);
        this._updateLabel(clone, rect);
    }

    // The copies are not clipped by the scroll view as the icons are
    _isInView(item, {x, y, width, height}) {
        if (item.get_parent() !== this._box)
            return true;

        const axis = this._isHorizontal ? 0 : 1;
        const center = this._isHorizontal ? x + width / 2 : y + height / 2;
        const start = this._scrollView.get_transformed_position()[axis];
        const length = this._scrollView.get_transformed_size()[axis];
        return center >= start && center <= start + length;
    }

    // Places the copies of the badges and the like over the icon copy
    _updateDecorations(clone, {x, y}) {
        const sources = clone.container?.get_children()
            .filter(child => child._dtdIconDecoration) ?? [];
        const scale = clone.actor.scale_x;

        sources.forEach(source => {
            const {copy, label} = clone.decorations.get(source) ??
                this._addDecoration(clone, source);
            copy.visible = source.visible;
            if (!source.visible)
                return;

            const rect = getStageRect(label ?? source);
            if (!rect) {
                // Just added, not laid out yet
                this._needsFrames = true;
                return;
            }
            // Whole pixels once enlarged along with the icon
            copy.set_position(Math.round((rect.x - x) * scale) / scale,
                Math.round((rect.y - y) * scale) / scale);

            if (!label) {
                copy.set_size(rect.width, rect.height);
                return;
            }

            copy.text = label.text;
            // Drawn at its size on screen: undo the scaling of the parent
            copy.set_style(getScaledLabelStyle(label, scale));
            copy.set_size(Math.round(rect.width * scale),
                Math.round(rect.height * scale));
            copy.set_scale(1 / scale, 1 / scale);
        });
    }

    _addDecoration(clone, source) {
        // Text enlarged from its resting size gets blurry, so labels are drawn
        // again at their new size instead of being cloned.
        const label = source.child instanceof St.Label ? source.child : null;
        const copy = label
            ? new St.Label({reactive: false})
            : new Clutter.Clone({source, reactive: false});
        copy.clutter_text?.set({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            ellipsize: Pango.EllipsizeMode.NONE,
        });

        const signals = [[source, 'notify::visible']];
        if (label)
            signals.push([label, 'notify::text'], [label, 'style-changed']);

        const decoration = {
            copy, label,
            opacity: source.opacity,
            signals: signals.map(([object, signal]) =>
                [object, object.connect(signal, () => this._startFrames())]),
        };
        clone.decorations.set(source, decoration);
        // The copy is painted in its place
        source.opacity = 0;
        clone.actor.add_child(copy);
        return decoration;
    }

    _disconnectDecoration(decoration) {
        decoration.signals.forEach(([object, id]) => object.disconnect(id));
        decoration.signals = [];
    }

    _removeDecoration(clone, source) {
        const decoration = clone.decorations.get(source);
        if (!decoration)
            return;

        clone.decorations.delete(source);
        // A removed decoration is being destroyed, nothing to restore on it
        if (source.get_parent() === clone.container) {
            this._disconnectDecoration(decoration);
            source.opacity = decoration.opacity;
        }
        decoration.copy.destroy();
    }

    // Keeps the tooltip out of the way of the enlarged icon
    _updateLabel({item, actor}, rect) {
        const [pivotX, pivotY] = actor.get_pivot_point();
        const scale = actor.scale_x;
        item._dtdMagnifiedRect = {
            x: rect.x + pivotX * rect.width * (1 - scale) + actor.translation_x,
            y: rect.y + pivotY * rect.height * (1 - scale) + actor.translation_y,
            width: rect.width * scale,
            height: rect.height * scale,
        };

        if (item.label?.visible)
            AppIcons.positionItemLabel(item);
    }

    _disconnectClone(clone) {
        clone.signals.forEach(([object, id]) => object.disconnect(id));
        clone.signals = [];
        clone.decorations.forEach(
            decoration => this._disconnectDecoration(decoration));
        clone.bindings.forEach(binding => binding.unbind());
        clone.bindings = [];
    }

    _destroyClone(item) {
        const clone = this._clones.get(item);
        if (!clone)
            return;

        this._clones.delete(item);
        delete item._dtdMagnifiedRect;
        this._disconnectClone(clone);
        [...clone.decorations.keys()].forEach(
            source => this._removeDecoration(clone, source));
        clone.sourceIcon.opacity = clone.sourceOpacity;
        clone.baseIcon.set_style(clone.baseIconStyle);
        if (clone.container)
            clone.container[this._alignProperty] = clone.containerAlign;
        clone.actor.destroy();
    }
}
