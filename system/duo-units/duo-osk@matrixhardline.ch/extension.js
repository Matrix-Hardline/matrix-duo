// Duo OSK v27: do not cut off the GNOME Shell keyboard on 3:4 panels (1350x1800, scale 2 -> 675x900 logical),
// and push the lock/login dialog up while the keyboard is visible (otherwise the password field lies underneath).
// Original keyboard.js _relayout: portrait = monitor.height / 4 -> 225 px; 4 rows + suggestion bar need ~320 px.
// UnlockDialogLayout puts the stack (avatar/name/field) at y = height/3 = 300; with a 321 px keyboard the field is covered.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as DuoOverview from './duoOverview.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/keyboard.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MARGIN = 24;

// Momentum from position samples {t, x, y}. The touch driver reports the release only 150 ms after the last movement
// (debouncing of the controller dropouts, duotouch.c) -> skip the silent trailing time up to 260 ms, measure
// in the 110 ms before the last real movement.
function duoFlingVelocity(samples) {
    if (samples.length < 3)
        return null;
    const end = samples[samples.length - 1];
    let li = samples.length - 1;
    while (li > 0 && Math.abs(samples[li - 1].x - end.x) < 1.5 && Math.abs(samples[li - 1].y - end.y) < 1.5)
        li--;
    const last = samples[li];
    if (end.t - last.t > 260)
        return null;   // really stopped, then released -> no fling
    let first = samples[0];
    for (const s of samples.slice(0, li + 1)) {
        if (last.t - s.t <= 110) {
            first = s;
            break;
        }
    }
    const dt = Math.max(1, last.t - first.t);
    const vx = (last.x - first.x) / dt * 1000, vy = (last.y - first.y) / dt * 1000;
    return {vx, vy, speed: Math.hypot(vx, vy)};
}


// stretching of the key pages (see _relayout): remember the base ratio per container, apply the target.
const duoStretch = {target: 1};

function duoApplyStretch(actor) {
    if (!actor)
        return;
    if (typeof actor.setRatio === 'function' && typeof actor._ratio === 'number') {
        if (actor._duoBaseRatio === undefined)
            actor._duoBaseRatio = actor._ratio;
        const want = actor._duoBaseRatio * duoStretch.target;
        if (Math.abs(actor._ratio - want) > 0.001) {
            actor._ratio = want;
            actor.queue_relayout();
        }
        if (!actor._duoPatched) {
            actor._duoPatched = true;
            const orig = actor.setRatio.bind(actor);
            actor.setRatio = (relWidth, relHeight) => {
                orig(relWidth, relHeight);
                actor._duoBaseRatio = actor._ratio;
                actor._ratio = actor._duoBaseRatio * duoStretch.target;
                actor.queue_relayout();
            };
        }
    }
    for (const child of actor.get_children?.() ?? [])
        duoApplyStretch(child);
}

const DUO_LAYOUTS = '/usr/local/share/duo-osk/duo-osk-layouts.gresource';

export default class DuoOskExtension {
    enable() {
        // GNOME bug (keyboard.js maybeHandleEvent): with an open dialog GNOME checks every event against the
        // keyboard; touch events without a target actor throw «descendant may not be null» there, the event gets
        // lost (journal 30.10.: 9x). Without a target it cannot concern the keyboard -> false.
        const kbm = Main.keyboard;
        if (kbm && !kbm._duoOrigMaybeHandle) {
            kbm._duoOrigMaybeHandle = kbm.maybeHandleEvent;
            kbm.maybeHandleEvent = function (event) {
                if (!global.stage.get_event_actor(event))
                    return false;
                return this._duoOrigMaybeHandle(event);
            };
        }
        // lay the Matrix layout (Swiss QWERTZ like matrix-keyboard) over ch.json: the last registered resource wins
        try {
            this._layoutRes = Gio.Resource.load(DUO_LAYOUTS);
            Gio.resources_register(this._layoutRes);
        } catch (e) {
            log(`duo-osk: Layout-Ressource nicht geladen: ${e}`);
            this._layoutRes = null;
        }
        this._orig = Keyboard.Keyboard.prototype._relayout;
        Keyboard.Keyboard.prototype._relayout = function () {
            let monitor = Main.layoutManager.keyboardMonitor;
            if (!monitor)
                return;
            this.width = monitor.width;
            // The keyboard keeps its aspect ratio (AspectContainer, ~2.2:1 for 11 columns x 5 rows) and for that needs
            // width/2.2 plus the suggestion bar. Portrait (489 px): ~290 px; landscape (652 px, height 489): at most 46 %
            // of the height, the keys then get narrower. No scaling: the shell shifts up by this.height.
            // Matrix proportions (matrix-keyboard: key 56x48, 11 units, 4 rows): key pages with 11 columns
            // and 4 rows naturally have the ratio 2.75 (square cells). Landscape: cells 1.17x wider than
            // high (56/48) -> aspect ratio 3.2; portrait: cells 0.9x -> 2.5 (taller keys for the thumbs).
            // Large thumb keys: portrait 42 % of the height (rows ~60 px), landscape 50 % (rows ~52 px); the pages
            // are stretched via the aspect ratio so that they fill the width AND the height.
            const landscape = monitor.width > monitor.height;
            const want = Math.round(monitor.height * (landscape ? 0.5 : 0.42));
            const pageH = Math.max(100, want - 70);   // Tastenseite = Actor minus Leiste/Raender (gemessen: ~70 px)
            duoStretch.target = Math.max(0.6, Math.min(1.5, (monitor.width / pageH) / 2.75));
            duoApplyStretch(this);
            this.scale_y = 1;
            this.height = want;
            log(`duo-osk: relayout Monitor ${Main.layoutManager.keyboardIndex} (${monitor.x},${monitor.y} ${monitor.width}x${monitor.height}) height=${this.height} stretch=${duoStretch.target.toFixed(2)}`);
        };
        if (Main.keyboard?._keyboard)
            Main.keyboard._keyboard._relayout();

        // KeyboardManager (Main.keyboard) meldet 'visibility-changed'; Zustand in Main.keyboard.visible.
        this._kbId = Main.keyboard.connect('visibility-changed', () => {
            const box = Main.layoutManager.keyboardBox;
            log(`duo-osk: Tastatur sichtbar=${Main.keyboard.visible} Kasten (${box.x},${box.y} ${box.width}x${box.height}) Index ${Main.layoutManager.keyboardIndex}`);
            this._shiftDialog(Main.keyboard.visible);
        });
        this._fixDateMenu(true);
        this._watchSingle();
        this._watchRotate();
        this._watchKeyboardMonitor();
        this._watchFling();
        this._patchOsd();
        this._watchBackgrounds();
        this._watchOverviewFling();
        this._setupDuoOverview();
    }

    // Duo overview (module duoOverview.js). Development aid without re-login, only with /etc/duo/shell-dev:
    // create $XDG_RUNTIME_DIR/duo-dev/ov-reload -> reload the module from the extension folder; create /run/duo/ov-shot ->
    // open the app view, screenshot ov.png, measurements ov-info.txt (same folder). Nothing else.
    _setupDuoOverview() {
        globalThis.__duoDeps = {Main, St, Clutter, Shell, GLib, AppDisplay, DND};
        try {
            globalThis.__duoOv = DuoOverview.install(globalThis.__duoDeps);
        } catch (e) {
            log(`duo-osk: Uebersicht: ${e}\n${e.stack}`);
        }
        if (!GLib.file_test('/etc/duo/shell-dev', GLib.FileTest.EXISTS))
            return;
        this._devTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            for (const [f, fn] of [[`${GLib.get_user_runtime_dir()}/duo-dev/ov-reload`, () => this._devReload()], [`${GLib.get_user_runtime_dir()}/duo-dev/ov-shot`, () => this._devShot()]]) {
                if (GLib.file_test(f, GLib.FileTest.EXISTS)) {
                    GLib.unlink(f);
                    try {
                        fn();
                    } catch (e) {
                        this._devWrite(`${GLib.get_user_runtime_dir()}/duo-dev/ov-info.txt`, `FEHLER ${e}\n${e.stack}`);
                    }
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _devWrite(path, text) {
        GLib.file_set_contents(path, text);
    }

    _devReload() {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'duoOverview.js']));
        const src = new TextDecoder().decode(bytes).replace(/^export function /m, 'function ');
        // teardown may fail (e.g. after an aborted installation) -- never block loading the new version
        try {
            globalThis.__duoOv?.uninstall();
        } catch (e) {
            log(`duo-osk: alter Abbau: ${e}`);
        }
        globalThis.__duoOv = null;
        globalThis.__duoOv = new Function(`${src}\nreturn install;`)()(globalThis.__duoDeps);
        this._devWrite(`${GLib.get_user_runtime_dir()}/duo-dev/ov-info.txt`, 'neu geladen\n');
    }

    _devShot() {
        Main.overview.showApps();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            const lines = [];
            const box = a => {
                if (!a)
                    return 'null';
                const [x, y] = a.get_transformed_position();
                return `${a.visible ? '' : '(unsichtbar) '}${Math.round(x)},${Math.round(y)} ${Math.round(a.width)}x${Math.round(a.height)}`;
            };
            const c = Main.overview._overview._controls;
            lines.push(`suche ${box(c._searchEntryBin)}`, `appDisplay ${box(c._appDisplay)}`,
                `liste ${box(globalThis.__duoOv?.scroll)} kacheln=${globalThis.__duoOv?.view.get_n_children()}`,
                `arbeitsflaechen ${box(c._workspacesDisplay)}`, `ergebnisse ${box(c._searchController)}`);
            for (const a of Main.layoutManager.uiGroup.get_children()) {
                if (a.name === 'dashtodockContainer')
                    lines.push(`dock m${a._monitorIndex} ${box(a)}`);
            }
            const t = globalThis.__duoOv?.view.get_first_child();
            lines.push(`kachel ${box(t)}`);
            this._devWrite(`${GLib.get_user_runtime_dir()}/duo-dev/ov-info.txt`, `${lines.join('\n')}\n`);
            const file = Gio.File.new_for_path(`${GLib.get_user_runtime_dir()}/duo-dev/ov.png`);
            const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
            new Shell.Screenshot().screenshot(false, stream).then(() => stream.close(null)).catch(e => log(`duo-osk: Foto ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    // At session start (_startingUp) GNOME hides the backgrounds of the secondary monitors and shows them again after the
    // start animation. If the posture service rotates the display in this window, the shell rebuilds the backgrounds
    // - hidden - and nobody shows them again: grey screen. Therefore make all backgrounds visible after every monitor
    // change and after the end of startup.
    _watchBackgrounds() {
        const lm = Main.layoutManager;
        const showAll = () => {
            if (lm._startingUp)
                return;
            for (const m of lm._bgManagers ?? []) {
                if (m.backgroundActor && !m.backgroundActor.visible) {
                    m.backgroundActor.show();
                    log('duo-osk: Hintergrund wieder sichtbar gemacht');
                }
            }
        };
        this._bgShowAll = () => { showAll(); this._dockOnLowerOnly(); };
        this._bgMonId = lm.connect('monitors-changed', () =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => { this._bgShowAll(); return GLib.SOURCE_REMOVE; }));
        this._bgStartId = lm.connect('startup-complete', () =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => { this._bgShowAll(); return GLib.SOURCE_REMOVE; }));
        this._bgShowAll();
    }

    // Landscape (panels stacked): show Dash-to-Dock only on the lower panel. The docks are only
    // hidden (visible=false), not rebuilt via gsettings - the rebuild destroyed the shell display.
    async _dockOnLowerOnly() {
        let docks;
        try {
            const mod = await import('file:///usr/share/gnome-shell/extensions/dash-to-dock@micxgx.gmail.com/docking.js');
            docks = mod.DockManager.allDocks ?? mod.DockManager.getDefault()?._allDocks ?? [];
        } catch (e) {
            return;
        }
        const mons = Main.layoutManager.monitors;
        const stacked = mons.length === 2 && mons[0].y !== mons[1].y;
        const upper = stacked ? (mons[0].y < mons[1].y ? 0 : 1) : -1;
        for (const d of docks) {
            const hide = d.monitorIndex === upper;
            if (d.visible === hide)
                d.visible = !hide;
        }
    }

    // OSD window (volume, brightness): GNOME shows it on all monitors. If the panels are stacked
    // (landscape), show it only on the upper panel; side by side (portrait) GNOME's behaviour stays.
    _patchOsd() {
        const mgr = Main.osdWindowManager;
        if (!mgr || typeof mgr.show !== 'function')
            return;
        this._osdShowOrig = mgr.show;
        mgr.show = (monitorIndex, icon, label, level, maxLevel) => {
            const mons = Main.layoutManager.monitors;
            if (monitorIndex === -1 && mons.length === 2 && mons[0].y !== mons[1].y)
                monitorIndex = mons[0].y < mons[1].y ? 0 : 1;
            return this._osdShowOrig.call(mgr, monitorIndex, icon, label, level, maxLevel);
        };
    }

    // Window fling: while a window is being dragged (Mutter grab MOVING), its position is measured every frame.
    // If the drag ends with momentum (>= 1100 px/s) towards the other panel, the window flies there: it is moved
    // immediately and the actor glides from the old spot to the new one with overshoot (EASE_OUT_BACK), slightly
    // tilted and shrunk. If it was maximised, it is maximised again on the other panel.
    _watchFling() {
        this._flingSamples = [];
        this._flingWindow = null;
        this._flingWasMax = 0;
        this._grabBeginId = global.display.connect('grab-op-begin', (display, win, op) => {
            if (!win || (op !== Meta.GrabOp.MOVING && op !== Meta.GrabOp.MOVING_UNCONSTRAINED))
                return;
            this._flingWindow = win;
            this._flingWasMax = win.get_maximized();
            this._flingSamples = [];
            if (this._flingTimer)
                GLib.source_remove(this._flingTimer);
            this._flingTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                const r = win.get_frame_rect();
                this._flingSamples.push({t: GLib.get_monotonic_time() / 1000, x: r.x, y: r.y});
                if (this._flingSamples.length > 30)
                    this._flingSamples.shift();
                return GLib.SOURCE_CONTINUE;
            });
        });
        this._grabEndId = global.display.connect('grab-op-end', (display, win, op) => {
            if (this._flingTimer) {
                GLib.source_remove(this._flingTimer);
                this._flingTimer = 0;
            }
            if (!win || win !== this._flingWindow)
                return;
            this._flingWindow = null;
            // fling only 40 ms later: after the grab ends Mutter still applies its last drag position
            const samples = this._flingSamples, wasMax = this._flingWasMax;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
                this._maybeFling(win, samples, wasMax);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // target of a fling from position samples {t, x, y}: the monitor in the throw direction, or null
    _flingTarget(win, samples) {
        if (samples.length < 3)
            return null;
        const v = duoFlingVelocity(samples);
        if (!v)
            return null;
        const {vx, vy, speed} = v;
        if (speed < 900)
            return null;
        const monitors = Main.layoutManager.monitors;
        const cur = monitors[win.get_monitor()];
        if (!cur)
            return null;
        let target = null, best = 0.6;
        for (const m of monitors) {
            if (m === cur)
                continue;
            const dx = (m.x + m.width / 2) - (cur.x + cur.width / 2);
            const dy = (m.y + m.height / 2) - (cur.y + cur.height / 2);
            const cos = (dx * vx + dy * vy) / (Math.hypot(dx, dy) * speed);
            if (cos > best) {
                best = cos;
                target = m;
            }
        }
        return target ? {target, speed} : null;
    }

    // Overview: release a thumbnail with momentum towards the other panel -> the window moves there instead of
    // snapping back. The drag monitor collects the positions, dragDrop takes over the drop when there is momentum.
    _watchOverviewFling() {
        this._ovWin = null;
        this._ovSamples = [];
        this._ovMonitor = {
            dragMotion: e => {
                if (this._ovWin) {
                    this._ovSamples.push({t: GLib.get_monotonic_time() / 1000, x: e.x, y: e.y});
                    if (this._ovSamples.length > 30)
                        this._ovSamples.shift();
                }
                return DND.DragMotionResult.CONTINUE;
            },
            dragDrop: () => {
                const win = this._ovWin;
                if (!win)
                    return DND.DragDropResult.CONTINUE;
                const hit = this._flingTarget(win, this._ovSamples);
                if (!hit)
                    return DND.DragDropResult.CONTINUE;
                // Do NOT return SUCCESS: dnd.js then does not end the drag (_dragComplete is skipped), the
                // input grab hangs and every further event throws «currentDraggable is null» (journal 30.10.: 19x).
                // GNOME completes the drop normally; the window moves afterwards when idle.
                const wasMax = win.get_maximized();
                const idx = hit.target.index;
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (win.get_monitor() !== idx)
                        win.move_to_monitor(idx);
                    if (wasMax && !win.get_maximized())
                        win.maximize(Meta.MaximizeFlags.BOTH);
                    return GLib.SOURCE_REMOVE;
                });
                log(`duo-osk: Uebersicht-Schubs ${hit.speed.toFixed(0)} px/s -> Monitor ${idx}`);
                return DND.DragDropResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._ovMonitor);
        this._ovBeginId = Main.overview.connect('window-drag-begin', (o, win) => {
            this._ovWin = win;
            this._ovSamples = [];
        });
        this._ovEndId = Main.overview.connect('window-drag-end', () => { this._ovWin = null; });
        this._ovCancelId = Main.overview.connect('window-drag-cancelled', () => { this._ovWin = null; });
    }

    _maybeFling(win, samples, wasMax) {
        if (samples.length < 3)
            return;
        const v = duoFlingVelocity(samples);
        if (!v)
            return;
        const {vx, vy, speed} = v;
        if (speed < 900)
            return;
        const monitors = Main.layoutManager.monitors;
        const cur = monitors[win.get_monitor()];
        if (!cur)
            return;
        let target = null, best = 0.6;
        for (const m of monitors) {
            if (m === cur)
                continue;
            const dx = (m.x + m.width / 2) - (cur.x + cur.width / 2);
            const dy = (m.y + m.height / 2) - (cur.y + cur.height / 2);
            const cos = (dx * vx + dy * vy) / (Math.hypot(dx, dy) * speed);
            if (cos > best) {
                best = cos;
                target = m;
            }
        }
        if (!target)
            return;
        const rect = win.get_frame_rect();
        const work = Main.layoutManager.getWorkAreaForMonitor(target.index);
        let tx = target.x + (rect.x - cur.x), ty = target.y + (rect.y - cur.y);
        tx = Math.max(work.x, Math.min(tx, work.x + work.width - rect.width));
        ty = Math.max(work.y, Math.min(ty, work.y + work.height - rect.height));
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        const dirX = Math.sign(vx), dirY = Math.sign(vy);
        const place = () => {
            win.move_frame(true, tx, ty);
            if (wasMax) {
                win.move_to_monitor(target.index);
                win.maximize(Meta.MaximizeFlags.BOTH);
            }
        };
        place();
        // The actor starts at the old spot (translation = old minus new position) and flies with overshoot to
        // the new one; midway it shrinks to 88 %, tilts in the flight direction and lands softly.
        const after = win.get_frame_rect();
        const D = 620;
        actor.remove_all_transitions();
        actor.set_pivot_point(0.5, 0.5);
        actor.translation_x = rect.x - after.x;
        actor.translation_y = rect.y - after.y;
        actor.scale_x = actor.scale_y = 1;
        actor.rotation_angle_z = wasMax ? 0 : (dirX !== 0 ? dirX * 5 : dirY * 5);
        actor.ease({
            translation_x: 0, translation_y: 0,
            duration: D, mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        actor.ease({
            scale_x: 0.88, scale_y: 0.88,
            duration: Math.round(D * 0.35), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => actor.ease({
                scale_x: 1, scale_y: 1,
                duration: Math.round(D * 0.65), mode: Clutter.AnimationMode.EASE_OUT_BACK,
            }),
        });
        actor.ease({
            rotation_angle_z: 0,
            duration: D, mode: Clutter.AnimationMode.EASE_OUT_QUINT,
        });
        // secure the landing: if a late update from Mutter throws the window back, set it again (without a jump)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, () => {
            const r = win.get_frame_rect();
            if (!wasMax && (Math.abs(r.x - tx) > 2 || Math.abs(r.y - ty) > 2)) {
                actor.translation_x += r.x - tx;
                actor.translation_y += r.y - ty;
                place();
                log('duo-osk: Schubs: Position nachgesetzt');
            }
            return GLib.SOURCE_REMOVE;
        });
        log(`duo-osk: Schubs ${speed.toFixed(0)} px/s -> Monitor ${target.index}${wasMax ? ' (maximiert)' : ''}`);
    }

    // Laptop posture: /run/duo/keyboard contains the connector of the lower panel (e.g. DSI-2). Then the keyboard shows
    // there, no matter which panel is the main panel or where the focused window is. Without the file: GNOME behaviour.
    _watchKeyboardMonitor() {
        const lm = Main.layoutManager;
        const proto = Object.getPrototypeOf(lm);
        const desc = Object.getOwnPropertyDescriptor(proto, 'keyboardIndex');
        if (!desc) {
            log('duo-osk: keyboardIndex nicht am Prototyp gefunden');
            return;
        }
        this._kbDesc = desc;
        this._kbForced = -1;
        Object.defineProperty(lm, 'keyboardIndex', {
            configurable: true,
            get: () => {
                if (this._kbForced >= 0 && this._kbForced < lm.monitors.length)
                    return this._kbForced;
                return desc.get.call(lm);
            },
            set: v => desc.set.call(lm, v),
        });
        this._kbFile = Gio.File.new_for_path('/run/duo/keyboard');
        try {
            this._kbMon = this._kbFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._kbMon.connect('changed', (m, f, o, ev) => {
                if (ev === Gio.FileMonitorEvent.CHANGES_DONE_HINT || ev === Gio.FileMonitorEvent.CREATED || ev === Gio.FileMonitorEvent.DELETED)
                    this._applyKeyboardMonitor();
            });
        } catch (e) {
            log(`duo-osk: keyboard-Wache: ${e}`);
        }
        this._kbMonitorsId = Main.layoutManager.connect('monitors-changed', () => this._applyKeyboardMonitor());
        this._applyKeyboardMonitor();
    }

    _applyKeyboardMonitor() {
        let forced = -1;
        try {
            if (this._kbFile.query_exists(null)) {
                const [ok, bytes] = this._kbFile.load_contents(null);
                const connector = ok ? new TextDecoder().decode(bytes).trim() : '';
                if (connector) {
                    const idx = global.backend.get_monitor_manager().get_monitor_for_connector(connector);
                    if (idx >= 0)
                        forced = idx;
                }
            }
        } catch (e) {
            log(`duo-osk: Tastatur-Monitor: ${e}`);
            forced = -1;
        }
        log(`duo-osk: Tastatur-Monitor erzwungen = ${forced} (Monitore: ${Main.layoutManager.monitors.length}, primaer ${Main.layoutManager.primaryIndex})`);
        if (forced === this._kbForced)
            return;
        this._kbForced = forced;
        const lm = Main.layoutManager;
        // call the original's setter with the current value -> the keyboard box is repositioned
        lm.keyboardIndex = lm.keyboardIndex;
        if (Main.keyboard?._keyboard)
            Main.keyboard._keyboard._relayout();
    }

    // Rotation animation: before switching, the posture service writes "<old> <new>" (Mutter transform 0..3) to /run/duo/rotate.
    // We freeze the stage image and lay it over everything; after the switch (monitors-changed) it is still in the old
    // physical orientation (rotated) and swings upright in 350 ms while it fades and the new image grows in slightly.
    _watchRotate() {
        this._rotateFile = Gio.File.new_for_path('/run/duo/rotate');
        try {
            this._rotateMon = this._rotateFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._rotateMon.connect('changed', (m, f, o, ev) => {
                if (ev === Gio.FileMonitorEvent.CHANGES_DONE_HINT || ev === Gio.FileMonitorEvent.CREATED)
                    this._prepareRotate();
            });
        } catch (e) {
            log(`duo-osk: rotate-Wache: ${e}`);
        }
    }

    async _prepareRotate() {
        let text;
        try {
            const [ok, bytes] = this._rotateFile.load_contents(null);
            if (!ok)
                return;
            text = new TextDecoder().decode(bytes).trim();
        } catch (e) {
            return;
        }
        const [tOld, tNew] = text.split(' ').map(Number);
        if (Number.isNaN(tOld) || Number.isNaN(tNew) || tOld === tNew)
            return;
        this._cleanupRotate();
        let content;
        try {
            const shot = new Shell.Screenshot();
            [content] = await shot.screenshot_stage_to_content();   // GNOME 48: asynchron, liefert [content, scale, ...]
        } catch (e) {
            log(`duo-osk: Stagebild: ${e}`);
            return;
        }
        if (this._rotateOverlay)
            return;
        const stage = global.stage;
        // lay the old image as an opaque copy over everything: from now on only the copy is visible (seamless, same image),
        // the surface underneath becomes invisible and may rebuild itself.
        const overlay = new Clutter.Actor({
            content, width: stage.width, height: stage.height,
            reactive: false, x: 0, y: 0,
        });
        overlay.set_pivot_point(0.5, 0.5);
        stage.add_child(overlay);
        stage.set_child_above_sibling(overlay, null);
        this._rotateOverlay = overlay;
        Main.uiGroup.opacity = 0;
        let angle = ((tNew - tOld) * 90) % 360;
        if (angle > 180)
            angle -= 360;
        if (angle <= -180)
            angle += 360;
        this._rotateAngle = angle;
        this._rotateChangedId = Main.layoutManager.connect('monitors-changed', () => this._runRotate());
        this._rotateTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            this._rotateTimeout = 0;
            this._cleanupRotate();
            return GLib.SOURCE_REMOVE;
        });
    }

    _runRotate() {
        const overlay = this._rotateOverlay;
        if (!overlay)
            return;
        if (this._rotateChangedId) {
            Main.layoutManager.disconnect(this._rotateChangedId);
            this._rotateChangedId = 0;
        }
        if (this._rotateTimeout) {
            GLib.source_remove(this._rotateTimeout);
            this._rotateTimeout = 0;
        }
        const stage = global.stage;
        const D = 450;
        // old image: same physical centre, rotated as last seen -> swings upright, fades out late
        overlay.set_position(Math.round((stage.width - overlay.width) / 2), Math.round((stage.height - overlay.height) / 2));
        overlay.rotation_angle_z = this._rotateAngle;
        overlay.opacity = 255;
        overlay.set_scale(1, 1);
        stage.set_child_above_sibling(overlay, null);
        overlay.ease({
            rotation_angle_z: 0, scale_x: 0.94, scale_y: 0.94,
            duration: D, mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
        });
        overlay.ease({
            opacity: 0, delay: Math.round(D * 0.35), duration: Math.round(D * 0.65),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._cleanupRotate(),
        });
        // new image: grows in gently and emerges from under the swinging old one
        const ui = Main.uiGroup;
        ui.set_pivot_point(0.5, 0.5);
        ui.set_scale(0.94, 0.94);
        ui.opacity = 0;
        ui.ease({
            scale_x: 1, scale_y: 1,
            duration: D, mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
        });
        ui.ease({
            opacity: 255, delay: Math.round(D * 0.2), duration: Math.round(D * 0.6),
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
        });
    }

    _cleanupRotate() {
        if (this._rotateChangedId) {
            Main.layoutManager.disconnect(this._rotateChangedId);
            this._rotateChangedId = 0;
        }
        if (this._rotateTimeout) {
            GLib.source_remove(this._rotateTimeout);
            this._rotateTimeout = 0;
        }
        if (this._rotateOverlay) {
            this._rotateOverlay.remove_all_transitions();
            this._rotateOverlay.destroy();
            this._rotateOverlay = null;
        }
        const ui = Main.uiGroup;
        ui.remove_all_transitions();
        ui.set_scale(1, 1);
        ui.opacity = 255;
    }

    // Posture service (duo-haltung): /run/duo/single contains the connector of the front panel. Then bring all windows to the
    // main panel (the rear one is dark and touch-muted, windows lying there would be unreachable).
    _watchSingle() {
        this._singleFile = Gio.File.new_for_path('/run/duo/single');
        try {
            this._singleMon = this._singleFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._singleMon.connect('changed', (m, f, o, ev) => {
                if (ev === Gio.FileMonitorEvent.CHANGES_DONE_HINT || ev === Gio.FileMonitorEvent.CREATED)
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => { this._gatherWindows(); return GLib.SOURCE_REMOVE; });
            });
        } catch (e) {
            log(`duo-osk: single-Wache: ${e}`);
        }
        if (this._singleFile.query_exists(null))
            this._gatherWindows();
    }

    _gatherWindows() {
        if (!this._singleFile.query_exists(null))
            return;
        const idx = Main.layoutManager.primaryIndex;
        for (const actor of global.get_window_actors()) {
            const w = actor.meta_window;
            if (!w || w.get_monitor() === idx || w.is_skip_taskbar())
                continue;
            w.move_to_monitor(idx);
        }
    }

    // Date/notification menu for narrow panels (< 600 logical px): one column at panel width.
    // Date + compact calendar at the top, the notifications below; their height is computed on opening from the
    // available space (monitor height - panel - margins - calendar column) so that nothing sticks out over the edge.
    _fixDateMenu(enable) {
        const dm = Main.panel?.statusArea?.dateMenu;
        if (!dm?._messageList || !dm._calendar)
            return;
        const hbox = dm._messageList.get_parent();
        const vbox = dm._calendar.get_parent();
        const mon = Main.layoutManager.primaryMonitor;
        if (!hbox || !vbox || !mon)
            return;
        if (enable && mon.width < 600) {
            hbox.orientation = Clutter.Orientation.VERTICAL;
            hbox.set_child_above_sibling(dm._messageList, null);
            hbox.set_width(mon.width - 56);   // Popover hat eigene Innenraender + Pfeil
            vbox.set_style('font-size: 0.78em; padding: 0;');
            vbox.x_expand = true;
            dm._displaysSection?.hide();
            dm._messageList.set_style('width: 100%; min-width: 0; min-height: 0;');
            dm._messageList.x_expand = true;
            this._dateMenuFixed = true;
            this._dateMenuOpenId = dm.menu.connect('open-state-changed', (menu, isOpen) => {
                dm.menu.actor.translation_x = 0;
                if (!isOpen)
                    return;
                // After layout, measure the real width and centre the popover on the panel.
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    const [ax] = dm.menu.actor.get_transformed_position();
                    const aw = dm.menu.actor.width;
                    dm.menu.actor.translation_x = Math.round(mon.x + (mon.width - aw) / 2 - ax);
                    return GLib.SOURCE_REMOVE;
                });
                const avail = mon.height - Main.panel.height - 28;
                const [, vboxH] = vbox.get_preferred_height(hbox.width);
                const h = Math.max(100, Math.floor(avail - vboxH - 12));
                dm._messageList.set_height(h);
            });
        } else if (this._dateMenuFixed) {
            if (this._dateMenuOpenId)
                dm.menu.disconnect(this._dateMenuOpenId);
            this._dateMenuOpenId = null;
            hbox.orientation = Clutter.Orientation.HORIZONTAL;
            hbox.set_child_below_sibling(dm._messageList, null);
            hbox.set_width(-1);
            dm.menu.actor.translation_x = 0;
            vbox.set_style(null);
            dm._displaysSection?.show();
            dm._messageList.set_style(null);
            dm._messageList.set_height(-1);
            this._dateMenuFixed = false;
        }
    }

    // Push dialog parts up if their bottom edge would lie under the keyboard.
    _shiftDialog(visible) {
        let dialog = Main.screenShield?._dialog;
        if (!dialog)
            return;
        // Lock screen: stack (avatar, name, field) in the main box; greeter: AuthPrompt + user list.
        let actors = [];
        if (dialog._promptBox)
            actors.push(dialog._promptBox.get_parent());   // Shell.Stack
        if (dialog._authPrompt)
            actors.push(dialog._authPrompt);
        if (dialog._userSelectionBox)
            actors.push(dialog._userSelectionBox);
        let monitor = Main.layoutManager.keyboardMonitor ?? Main.layoutManager.primaryMonitor;
        let kbH = visible && Main.keyboard?._keyboard ? Main.keyboard._keyboard.height : 0;
        for (let actor of actors) {
            if (!actor)
                continue;
            if (!visible) {
                actor.translation_y = 0;
                continue;
            }
            let [, y] = actor.get_transformed_position();
            let h = actor.get_height();
            let bottom = y - monitor.y + h - actor.translation_y;
            let overlap = bottom - (monitor.height - kbH) + MARGIN;
            actor.translation_y = overlap > 0 ? -Math.min(overlap, y - monitor.y) : 0;
        }
    }

    disable() {
        const kbm = Main.keyboard;
        if (kbm?._duoOrigMaybeHandle) {
            kbm.maybeHandleEvent = kbm._duoOrigMaybeHandle;
            delete kbm._duoOrigMaybeHandle;
        }
        if (this._devTimer) {
            GLib.source_remove(this._devTimer);
            this._devTimer = 0;
        }
        globalThis.__duoOv?.uninstall();
        globalThis.__duoOv = null;
        if (this._ovMonitor) {
            DND.removeDragMonitor(this._ovMonitor);
            this._ovMonitor = null;
        }
        for (const id of [this._ovBeginId, this._ovEndId, this._ovCancelId]) {
            if (id)
                Main.overview.disconnect(id);
        }
        this._ovBeginId = this._ovEndId = this._ovCancelId = 0;
        for (const id of [this._bgMonId, this._bgStartId]) {
            if (id)
                Main.layoutManager.disconnect(id);
        }
        this._bgMonId = this._bgStartId = 0;
        if (this._osdShowOrig) {
            Main.osdWindowManager.show = this._osdShowOrig;
            this._osdShowOrig = null;
        }
        if (this._flingTimer) {
            GLib.source_remove(this._flingTimer);
            this._flingTimer = 0;
        }
        if (this._grabBeginId) {
            global.display.disconnect(this._grabBeginId);
            this._grabBeginId = 0;
        }
        if (this._grabEndId) {
            global.display.disconnect(this._grabEndId);
            this._grabEndId = 0;
        }
        if (this._layoutRes) {
            Gio.resources_unregister(this._layoutRes);
            this._layoutRes = null;
        }
        if (this._kbMon) {
            this._kbMon.cancel();
            this._kbMon = null;
        }
        if (this._kbMonitorsId) {
            Main.layoutManager.disconnect(this._kbMonitorsId);
            this._kbMonitorsId = 0;
        }
        if (this._kbDesc) {
            delete Main.layoutManager.keyboardIndex;
            this._kbDesc = null;
        }
        this._cleanupRotate();
        if (this._rotateMon) {
            this._rotateMon.cancel();
            this._rotateMon = null;
        }
        if (this._singleMon) {
            this._singleMon.cancel();
            this._singleMon = null;
        }
        this._fixDateMenu(false);
        if (this._kbId) {
            Main.keyboard.disconnect(this._kbId);
            this._kbId = null;
        }
        this._shiftDialog(false);
        if (this._orig)
            Keyboard.Keyboard.prototype._relayout = this._orig;
        this._orig = null;
        if (Main.keyboard?._keyboard)
            Main.keyboard._keyboard._relayout();
    }
}
