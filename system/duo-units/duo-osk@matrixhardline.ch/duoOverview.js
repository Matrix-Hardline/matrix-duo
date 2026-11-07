// Duo overview (landscape and portrait; in landscape the lower panel is the main panel), app view (grid button in the dock):
//   top    : GNOME's own workspaces (Fit-All) as large as on the upper panel
//   middle : search field
//   bottom : original app tiles (AppDisplay.AppIcon) at dock size, continuous, scrollable vertically
// Window view and portrait stay GNOME original. Dragging a tile onto a workspace opens
// the app there (GNOME's own Workspace.acceptDrop). Only GNOME building blocks, only their arrangement is changed.
// Development: this module can be reloaded without logging in again via shell eval (see werkzeuge/ov-reload.sh).

const WINDOW_PICKER = 1, APP_GRID = 2;
const WS_RATIO = 0.36;      // Height of the workspace row (share of the overview height)
const ICON = 48;            // = dash-to-dock dash-max-icon-size
const TILE_W = 92;          // Kachelbreite: Symbol + zweizeiliger Name
// Touch grammar after Matrix (matrixkit-theme touch, R168/R59, measured from UIKit): long press 0.5 s with at most
// 10 pt drift; scrolling wins over buttons from 10 px; the tile lifts while the press charges (only after 150 ms).
const HOLD_MS = 500;        // Hold without movement -> drag, or context menu on release
const MOVE_PX = 10;         // from this distance before HOLD_MS: scroll (even slowly)
const LIFT_DELAY_MS = 150;  // a pure tap never lifts
const CARD = 72;            // Base size of the «+» and magnifier card (scales with the workspace)
const DRAG_PX = 10;         // after the hold: from this distance it is a drag, otherwise context menu

export function install(d) {
    // Safety net: if loading aborts, all signals connected so far (undo) and parts created
    // (failUndo: list, strips, redirections) are torn down again -- otherwise leftovers stay until the next login.
    const undo = [], failUndo = [];
    try {
        return installInner(d, undo, failUndo);
    } catch (e) {
        for (const f of [...undo.splice(0).reverse(), ...failUndo.splice(0).reverse()]) {
            try {
                f();
            } catch (err) {
                log(`duo-osk: Aufraeumen nach Ladefehler: ${err}`);
            }
        }
        throw e;
    }
}

function installInner(d, undo, failUndo) {
    const on = (obj, sig, fn) => {
        const id = obj.connect(sig, fn);
        undo.push(() => {   // Object may already be gone at unload (e.g. rebuilt Dash-to-Dock bars)
            try {
                obj.disconnect(id);
            } catch (e) {
            }
        });
        return id;
    };
    const {Main, St, Clutter, Shell, GLib, AppDisplay} = d;
    const MOTION = d.DND?.DragMotionResult ?? {NO_DROP: 0, COPY_DROP: 1, MOVE_DROP: 2, CONTINUE: 3};
    // Load the keyboard module (duoKeyboard.js) too: that way it can be reloaded without logging in again
    try {
        const extDir = Main.extensionManager.lookup('duo-osk@matrixhardline.ch')?.path;
        if (extDir) {
            const [, kb] = GLib.file_get_contents(`${extDir}/duoKeyboard.js`);
            const src = new TextDecoder().decode(kb).replace(/^export function /m, 'function ');
            const installKeyboard = new Function(`${src}\nreturn installKeyboard;`)();
            const kbMod = installKeyboard({...d, selfPath: `${extDir}/duoKeyboard.js`});
            undo.push(() => kbMod.uninstall());
        }
    } catch (e) {
        log(`duo-osk: Tastaturmodul: ${e}\n${e.stack}`);
    }
    // Memory guard (duoSpeicher.js): pause apps and let the user choose before memory runs out
    if (Main.overview._overview) {
        try {
            const extDir = Main.extensionManager.lookup('duo-osk@matrixhardline.ch')?.path;
            const [, sp] = GLib.file_get_contents(`${extDir}/duoSpeicher.js`);
            const src = new TextDecoder().decode(sp).replace(/^export function /m, 'function ');
            const installSpeicher = new Function(`${src}\nreturn installSpeicher;`)();
            const spMod = installSpeicher(d);
            undo.push(() => spMod.uninstall());
        } catch (e) {
            log(`duo-osk: Speicherwache: ${e}\n${e.stack}`);
        }
    }
    if (!Main.overview._overview)   // Login screen (gdm): no overview, only keyboard + login dialog
        return installGreeter(d, undo, on);
    installAuthPlacement(d, undo, on);   // lock screen
    // Paired windows of the Duo apps: «… – Steuerung» maximised onto the panel with the clock bar and keyboard (primary),
    // «… – Anzeige» onto the other one (GBA controls 31.10.; Duo LLM: conversation/input 01.11.). When rotating/folding
    // the main panel and posture change -> re-sort 1.2 s after monitors-changed (01.11.: Duo LLM otherwise stayed on the
    // wrong panel). Delayed and only for these windows: the earlier IMMEDIATE retrieval of all windows in the middle of the
    // monitor rebuild coincided with SIGSEGV (before the Mutter patch duo-id).
    const duoPairRole = mw => {
        const title = mw?.get_title?.() ?? '';
        if (!(mw?.get_wm_class?.() ?? '').startsWith('ch.matrixhardline.Duo'))
            return null;
        return title.endsWith('Steuerung') ? 'steuerung' : title.endsWith('Anzeige') ? 'anzeige' : null;
    };
    const placeDuoPair = mw => {
        const role = duoPairRole(mw);
        const mons = Main.layoutManager.monitors;
        if (!role || mons.length < 2 || mw.minimized)
            return;
        const prim = Main.layoutManager.primaryIndex;
        const target = role === 'steuerung' ? prim : mons.find(m => m.index !== prim).index;
        if (mw.get_monitor() !== target) {
            // move_to_monitor has no effect on maximised windows in portrait (measurement 01.11.):
            // unmaximise, move into the work area of the target panel, maximise again
            const wa = Main.layoutManager.getWorkAreaForMonitor(target);
            mw.unmaximize(imports.gi.Meta.MaximizeFlags.BOTH);
            mw.move_frame(true, wa.x + 10, wa.y + 10);
            if (mw.get_monitor() !== target)
                mw.move_to_monitor(target);
        }
        if (mw.get_maximized() !== imports.gi.Meta.MaximizeFlags.BOTH)
            mw.maximize(imports.gi.Meta.MaximizeFlags.BOTH);
    };
    on(global.display, 'window-created', (_disp, mw) => {
        const shownId = mw.connect('shown', () => {
            mw.disconnect(shownId);
            placeDuoPair(mw);
            // Mutter places new windows once more after «shown» (portrait: both landed on the same panel)
            if (duoPairRole(mw)) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                    try {
                        placeDuoPair(mw);
                    } catch (e) {
                        // Window already closed
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    });
    let pairTimer = 0;
    on(Main.layoutManager, 'monitors-changed', () => {
        if (pairTimer)
            GLib.source_remove(pairTimer);
        pairTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
            pairTimer = 0;
            for (const a of global.get_window_actors()) {
                try {
                    placeDuoPair(a.meta_window);
                } catch (e) {
                    log(`duo-osk: Paar-Fenster einordnen: ${e}`);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    });
    undo.push(() => {
        if (pairTimer)
            GLib.source_remove(pairTimer);
        pairTimer = 0;
    });
    // Double windows (Red Alert Duo and others): a window taller than one panel lies across both panels.
    // On first show place it at the origin, top left. Instead of a title bar at the top (the game starts without one)
    // the shell shows a white title bar with _ and ✕ on the lower panel directly below the date/clock bar,
    // like the controls of the GBA games (the owner'ss wish 31.10.). The Duo surface leaves room for it.
    const TITLE_H = 36;
    const uebernommen = new Set();   // each double window only once (reload + window-created)
    const losen = (obj, id) => {     // disconnect the signal, even if the object/connection is already gone
        try {
            obj.disconnect(id);
        } catch (e) {
        }
    };
    const doppel = mw => {
        if (uebernommen.has(mw))
            return;
        {
            const mons = Main.layoutManager.monitors;
            if (mons.length < 2 || mw.get_frame_rect().height < Math.max(...mons.map(m => m.height)) * 1.5)
                return;
            uebernommen.add(mw);
            mw.move_frame(true, 0, 0);
            const low = [...mons].sort((x, y) => (y.y - x.y) || (y.x - x.x))[0];
            const bar = new St.BoxLayout({
                reactive: true,
                style: 'background-color: #f6f5f4; border-bottom: 1px solid #d0cfcc; padding: 0 6px; spacing: 8px;',
            });
            const title = new St.Label({
                text: (mw.get_title() ?? '').replace(/^OpenRA - /, '') + ' Duo',
                x_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
                style: 'color: #2e3436; font-weight: bold; font-size: 11pt;',
            });
            const knopf = (label, fn) => {
                const k = new St.Button({
                    label, y_align: Clutter.ActorAlign.CENTER, can_focus: false,
                    style: 'color: #2e3436; background-color: #e3e2df; border-radius: 99px; width: 28px; height: 28px; ' +
                        'font-weight: bold; font-size: 11pt;',
                });
                k.connect('clicked', fn);
                // St.Button does not trigger on touch here (probe 31.10. with virtual finger) -> handle touch ourselves
                k.connect('touch-event', (_a, ev) => {
                    if (ev.type() === Clutter.EventType.TOUCH_END)
                        fn();
                    return Clutter.EVENT_STOP;
                });
                return k;
            };
            bar.add_child(new St.Widget({width: 64}));   // Offset so the title sits centred
            bar.add_child(title);
            bar.add_child(knopf('–', () => mw.minimize()));
            bar.add_child(knopf('✕', () => mw.delete(global.get_current_time())));
            const place = () => {
                const ph = Main.layoutManager.panelBox.height;
                bar.set_position(low.x, low.y + ph);
                bar.set_size(low.width, TITLE_H);
            };
            Main.layoutManager.addTopChrome(bar, {affectsInputRegion: true, affectsStruts: false});
            place();
            // The dock (Dash to Dock) on the lower panel otherwise covers the game's controls: hide it while the window is
            // open and not minimised (the owner'ss wish 31.10.)
            // Dash to Dock shows itself again on events (new input device, focus): watch the visibility
            const docks = () => Main.layoutManager.uiGroup.get_children().filter(c => c.name === 'dashtodockContainer');
            let dockHidden = false;
            const dockIds = [];
            const dock = show => {
                dockHidden = !show;
                docks().forEach(c => { c.visible = show; });
            };
            for (const c of docks())
                dockIds.push([c, c.connect('notify::visible', () => { if (dockHidden && c.visible) c.visible = false; })]);
            // Dash to Dock also rebuilds its containers on events (probe 31.10.: dock back again, the watcher hung on the
            // old container) -> additionally hide all current dock containers every half second
            const dockTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                if (dockHidden)
                    docks().forEach(c => { if (c.visible) c.visible = false; });
                return GLib.SOURCE_CONTINUE;
            });
            dock(false);
            // Touchpad (duo-touchpad) only while the game is in the foreground: overview, another app or minimised
            // -> «0», the touchpad releases the panel (otherwise you were trapped in the overview, the owner 31.10.)
            const aktivDatei = `${GLib.get_user_runtime_dir()}/duo-touchpad.aktiv`;
            let aktivZuletzt = null;
            const aktiv = () => {
                const a = !Main.overview.visible && !mw.minimized && global.display.focus_window === mw;
                if (a === aktivZuletzt)
                    return;
                aktivZuletzt = a;
                try {
                    GLib.file_set_contents(aktivDatei, a ? '1' : '0');
                } catch (e) {
                    log(`duo-osk: touchpad.aktiv: ${e}`);
                }
            };
            aktiv();
            const shellIds = [
                [Main.overview, Main.overview.connect('showing', aktiv)],
                [Main.overview, Main.overview.connect('hidden', aktiv)],
                [global.display, global.display.connect('notify::focus-window', aktiv)],
            ];
            const ids = [
                mw.connect('notify::minimized', () => { bar.visible = !mw.minimized; dock(mw.minimized); aktiv(); }),
                mw.connect('notify::title', () => { title.text = (mw.get_title() ?? '').replace(/^OpenRA - /, '') + ' Duo'; }),
            ];
            // Clean up exactly once (window closed OR module unloaded; before, it ran twice -> JS errors and
            // Clutter warnings «already disposed», finding 31.10.)
            let aufgeraeumt = false;
            const weg = () => {
                if (aufgeraeumt)
                    return;
                aufgeraeumt = true;
                uebernommen.delete(mw);
                shellIds.forEach(([o, i]) => losen(o, i));
                GLib.source_remove(dockTimer);
                GLib.unlink(aktivDatei);
                dock(true);
                dockIds.forEach(([c, i]) => losen(c, i));
                ids.forEach(i => losen(mw, i));
                Main.layoutManager.removeChrome(bar);
                bar.destroy();
            };
            const goneId = mw.connect('unmanaged', () => { losen(mw, goneId); weg(); });
            undo.push(() => { losen(mw, goneId); weg(); });
        }
    };
    on(global.display, 'window-created', (_disp, mw) => {
        const shownId = mw.connect('shown', () => { mw.disconnect(shownId); doppel(mw); });
    });
    // take over double windows that are already open (module reload, login with a game running)
    global.get_window_actors().forEach(a => doppel(a.meta_window));
    // Lock and unlock sound (the owner'ss wish 31.10.): descending on lock (also folding shut), ascending on unlock
    {
        const dir = Main.extensionManager.lookup('duo-osk@matrixhardline.ch')?.path;
        let wasLocked = Main.screenShield?.locked ?? false;
        if (dir && Main.screenShield) {
            on(Main.screenShield, 'locked-changed', () => {
                const locked = Main.screenShield.locked;
                if (locked === wasLocked)
                    return;
                wasLocked = locked;
                try {
                    const f = imports.gi.Gio.File.new_for_path(`${dir}/${locked ? 'ton-sperren' : 'ton-entsperren'}.wav`);
                    global.display.get_sound_player().play_from_file(f, locked ? 'Gesperrt' : 'Entsperrt', null);
                } catch (e) {
                    log(`duo-osk: Sperrton: ${e}`);
                }
            });
        }
    }
    const controls = Main.overview._overview._controls;
    // Remove leftovers of an aborted installation (e.g. error during reload)
    for (const c of controls.get_children()) {
        if (c.name === 'duoAppList')
            c.destroy();
    }
    const layout = controls.layout_manager;
    const proto = Object.getPrototypeOf(layout);
    const orig = {alloc: proto.vfunc_allocate, ws: proto._computeWorkspacesBoxForState};

    // Applies in both orientations (landscape: panels stacked, portrait: side by side) and in single-panel mode (both
    // monitors stay active, the main panel is the visible one). Only with a single monitor GNOME original.
    const active = () => Main.layoutManager.monitors.length === 2;
    const lerp = (a, b, t) => a + (b - a) * t;

    // ---- Tile list: vertical box of rows (column count from the width) ----
    const view = new St.BoxLayout({vertical: true, x_expand: true, style: 'spacing: 4px; padding: 2px 8px 12px 8px;'});
    const scroll = new St.ScrollView({
        name: 'duoAppList',
        style_class: 'vfade',
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: true,
        child: view,
    });
    controls.add_child(scroll);
    failUndo.push(() => scroll.destroy());

    const appSys = Shell.AppSystem.get_default();
    let tiles = [], cols = 0, arrangePending = 0, tileTouch = null;
    let collapse = 0, wsFull = 0;
    const arrange = width => {
        const c = Math.max(1, Math.floor((width - 16) / TILE_W));
        if (c === cols && view.get_n_children() > 0)
            return;
        cols = c;
        for (const t of tiles)
            t.get_parent()?.remove_child(t);
        view.destroy_all_children();
        for (let i = 0; i < tiles.length; i += cols) {
            const row = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER});
            for (const t of tiles.slice(i, i + cols))
                row.add_child(t);
            view.add_child(row);
        }
    };
    const fill = () => {
        for (const t of tiles)
            t.destroy();
        tiles = appSys.get_installed()
            .filter(i => i.should_show())
            .map(i => appSys.lookup_app(i.get_id()))
            .filter(Boolean)
            .sort((x, y) => x.get_name().localeCompare(y.get_name()))
            .map(app => {
                const tile = new AppDisplay.AppIcon(app, {isDraggable: true});
                tile.icon.setIconSize(ICON);
                tile.set_width(TILE_W);
                // GNOME opens the menu after 600 ms while holding; here only on release without a drag
                tile._setPopupTimeout = () => {};
                if (tile._draggable)
                    tile._draggable._dragTimeoutThreshold = HOLD_MS;
                if (tileTouch)
                    tile.connect('captured-event', tileTouch);
                return tile;
            });
        cols = 0;
        arrange(scroll.width || 652);
    };
    fill();
    const installedId = on(appSys, 'installed-changed', fill);
    const allTiles = () => tiles;

    // Swiping scrolls (with momentum). The tile grabs the touch (DND); a short fast swipe releases it
    // by GNOME's 200 ms rule, hold + drag pulls the tile onto a workspace. The movement is therefore
    // tracked in the list's capture phase; after 12 px of travel the touched tile is let go (no start).
    const adj = () => scroll.vadjustment;
    const clampAdj = v => Math.max(adj().lower, Math.min(adj().upper - adj().page_size, v));
    // Distribute the finger travel: upwards first collapse the workspaces down to half, then scroll the list;
    // downwards first scroll the list back, then expand the workspaces again.
    const applyDelta = d => {      // d > 0: content upwards
        if (d > 0) {
            const c = Math.min(d, Math.max(0, wsFull / 2 - collapse));
            collapse += c;
            d -= c;
            if (d > 0)
                adj().value = clampAdj(adj().value + d);
        } else if (d < 0) {
            const a = Math.max(d, -adj().value);
            adj().value = clampAdj(adj().value + a);
            d -= a;
            if (d < 0)
                collapse = Math.max(0, collapse + d);
        }
        controls.queue_relayout();
    };
    const releaseTiles = () => {
        for (const t of allTiles()) {
            if (t.pressed)
                t.fake_release();
        }
    };
    let track = null, kinetic = 0, lastMenu = '';
    const devLog = GLib.file_test('/etc/duo/shell-dev', GLib.FileTest.EXISTS);
    const gestLog = (tr, how, e) => {
        if (!devLog || !tr)
            return;
        const line = `${new Date().toISOString().slice(11, 23)} ${how} dauer=${e.get_time() - tr.t0}ms ` +
            `updates=${tr.n} maxluecke=${tr.gap}ms weg=${Math.round(tr.maxDist)} dy=${Math.round(e.get_coords()[1] - tr.y0)} ` +
            `kachel=${tr.tile?.app?.get_name() ?? '-'} gehalten=${tr.held} bewegt=${tr.moved}\n`;
        try {
            const f = `${GLib.get_user_runtime_dir()}/duo-dev/gesten.txt`;
            let old = '';
            if (GLib.file_test(f, GLib.FileTest.EXISTS))
                old = new TextDecoder().decode(GLib.file_get_contents(f)[1]);
            GLib.file_set_contents(f, (old + line).split('\n').slice(-300).join('\n'));
        } catch (err) {
            log(`duo-osk: gesten ${err}`);
        }
    };
    const dbg = {b: 0, u: 0, e: 0, moved: 0};
    const stopKinetic = () => {
        if (kinetic)
            GLib.source_remove(kinetic);
        kinetic = 0;
    };
    const startKinetic = v => {   // v in px/ms, positive = finger downwards
        stopKinetic();
        kinetic = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            const before = adj().value + collapse;
            applyDelta(-v * 16);
            const hitEdge = Math.abs(adj().value + collapse - before) < 0.01;
            v *= 0.94;
            if (hitEdge || Math.abs(v) < 0.02) {
                kinetic = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    };
    const ET = Clutter.EventType;
    // Sequence objects are new JS wrappers per event -> compare via the slot
    const slotOf = e => e.get_event_sequence()?.get_slot?.() ?? 0;
    const lift = (tile, on) => {
        if (!tile)
            return;
        tile.set_pivot_point(0.5, 0.5);
        tile.remove_transition?.('scale-x');
        tile.remove_transition?.('scale-y');
        tile.ease({
            scale_x: on ? 1.12 : 1, scale_y: on ? 1.12 : 1,
            duration: on ? HOLD_MS - LIFT_DELAY_MS : 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    };
    let liftTimer = 0;
    const stopLift = tr => {
        if (liftTimer)
            GLib.source_remove(liftTimer);
        liftTimer = 0;
        if (tr?.lifted) {
            tr.lifted = false;
            lift(tr.tile, false);
        }
    };
    let lastKey = '';
    const tileOf = e => {
        let a = global.stage.get_event_actor(e);
        while (a && !tiles.includes(a))
            a = a.get_parent();
        return a;
    };
    const onTouch = (actor, e) => {
        const type = e.type();
        if (type !== ET.TOUCH_BEGIN && type !== ET.TOUCH_UPDATE && type !== ET.TOUCH_END && type !== ET.TOUCH_CANCEL)
            return Clutter.EVENT_PROPAGATE;
        // List and tile may both see the same event (without a grab) -> process only once
        const [ex, ey] = e.get_coords();
        const key = `${type}:${e.get_time()}:${ex}:${ey}`;
        if (key === lastKey)
            return track?.moved ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        lastKey = key;
        if (type === ET.TOUCH_BEGIN) dbg.b++;
        else if (type === ET.TOUCH_UPDATE) dbg.u++;
        else if (type === ET.TOUCH_END) dbg.e++;

        if (type === ET.TOUCH_BEGIN) {
            stopKinetic();
            track = {x0: ex, y0: ey, last: ey, t0: e.get_time(), moved: false, held: false, maxDist: 0,
                tile: tileOf(e), seq: slotOf(e), samples: [{t: e.get_time(), y: ey}], n: 0, gap: 0, lastT: e.get_time()};
            stopLift(null);
            const tr0 = track;
            if (tr0.tile) {
                liftTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LIFT_DELAY_MS, () => {
                    liftTimer = 0;
                    if (track === tr0 && !tr0.moved) {
                        tr0.lifted = true;
                        lift(tr0.tile, true);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (!track || slotOf(e) !== track.seq)
            return Clutter.EVENT_PROPAGATE;
        const dist = Math.hypot(ex - track.x0, ey - track.y0);
        track.maxDist = Math.max(track.maxDist, dist);

        if (type === ET.TOUCH_UPDATE) {
            // Switch off GNOME's own drag decision (on finger jitter before the hold time runs out it gives up
            // for good); we start it ourselves below as soon as held and moved > DRAG_PX.
            const dr = track.tile?._draggable;
            if (dr && !track.dragging)
                dr._dragThresholdIgnored = true;
            track.n++;
            track.gap = Math.max(track.gap, e.get_time() - track.lastT);
            track.lastT = e.get_time();
            if (!track.moved && !track.held) {
                if (e.get_time() - track.t0 >= HOLD_MS) {
                    track.held = true;           // Hold detected: GNOME's drag takes over the movement
                } else if (Math.abs(ey - track.y0) > MOVE_PX) {
                    track.moved = true;          // Movement before the hold: scroll, no matter how slowly
                    dbg.moved++;
                    stopLift(track);
                    const dr = track.tile?._draggable;
                    if (dr) {                    // switch dragging off for good for this touch
                        dr._dragThresholdIgnored = true;
                        dr._ungrabActor?.();
                    }
                    releaseTiles();
                }
            }
            if (track.held) {
                if (!track.dragging && track.tile && dist > DRAG_PX) {
                    const d = track.tile._draggable;
                    if (d) {
                        track.dragging = true;
                        stopLift(track);
                        d._dragThresholdIgnored = false;
                        gestLog(track, 'ZIEHEN-START', e);
                        d.startDrag(ex, ey, e.get_time(), d._touchSequence ?? e.get_event_sequence(), e.get_device());
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            }
            if (track.moved)
                applyDelta(-(ey - track.last));
            track.last = ey;
            track.samples.push({t: e.get_time(), y: ey});
            if (track.samples.length > 6)
                track.samples.shift();
            return track.moved ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }

        // Release
        const tr = track;
        track = null;
        stopLift(tr);
        if (type === ET.TOUCH_CANCEL) {
            gestLog(tr, 'ABBRUCH', e);
            return Clutter.EVENT_PROPAGATE;
        }
        if (tr.moved) {
            gestLog(tr, 'SCROLL', e);
            releaseTiles();
            const f = tr.samples[0], l = tr.samples[tr.samples.length - 1];
            if (l.t > f.t && l.t - f.t < 150 + 16 * tr.samples.length)
                startKinetic((l.y - f.y) / (l.t - f.t));
            return Clutter.EVENT_STOP;
        }
        const heldNow = tr.held || e.get_time() - tr.t0 >= HOLD_MS;
        if (heldNow && tr.tile && tr.maxDist <= DRAG_PX) {
            // Held and not dragged -> normal context menu; tapping beside it closes it (GNOME menu)
            gestLog(tr, 'MENUE', e);
            tr.tile.fake_release();
            tr.tile.popupMenu();
            lastMenu = `${tr.tile.app.get_name()}`;
            return Clutter.EVENT_STOP;
        }
        gestLog(tr, tr.held ? 'GEHALTEN-LOS' : 'TIPPEN', e);
        return Clutter.EVENT_PROPAGATE;
    };
    scroll.connect('captured-event', onTouch);
    tileTouch = onTouch;
    for (const t of tiles)
        t.connect('captured-event', onTouch);

    // ---- Window previews: same grammar as the tiles ----
    // GNOME starts dragging a preview only on immediate movement (ClickAction long-press CANCEL); whoever holds
    // first gets the close overlay and the drag is ignored (probe «windrag ... halten»: no start).
    // Here: held (>= HOLD_MS) and moved > DRAG_PX -> start the drag ourselves.
    const previewOf = e => {
        let a = global.stage.get_event_actor(e);
        while (a && !(a._draggable && a.metaWindow))
            a = a.get_parent();
        return a;
    };
    let ptrack = null;
    const onPreviewTouch = (actor, e) => {
        const type = e.type();
        if (type !== ET.TOUCH_BEGIN && type !== ET.TOUCH_UPDATE && type !== ET.TOUCH_END && type !== ET.TOUCH_CANCEL)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = e.get_coords();
        if (type === ET.TOUCH_BEGIN) {
            const pv = previewOf(e);
            ptrack = pv ? {pv, x0: x, y0: y, t0: e.get_time(), seq: slotOf(e), started: false} : null;
            return Clutter.EVENT_PROPAGATE;
        }
        if (!ptrack || slotOf(e) !== ptrack.seq)
            return Clutter.EVENT_PROPAGATE;
        if (type !== ET.TOUCH_UPDATE) {
            ptrack = null;
            return Clutter.EVENT_PROPAGATE;
        }
        if (ptrack.started)
            return Clutter.EVENT_PROPAGATE;
        const pv = ptrack.pv;
        if (e.get_time() - ptrack.t0 >= HOLD_MS && Math.hypot(x - ptrack.x0, y - ptrack.y0) > DRAG_PX &&
            pv._draggable && !pv.inDrag) {
            ptrack.started = true;
            for (const a of pv.get_actions()) {
                if (a instanceof Clutter.ClickAction)
                    a.release();
            }
            pv.hideOverlay?.(false);
            pv._draggable.startDrag(x, y, e.get_time(), e.get_event_sequence(), e.get_device());
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    };
    const ovGroup = Main.layoutManager.overviewGroup;
    const ovGroupId = on(ovGroup, 'captured-event', onPreviewTouch);
    // Tapping a free spot of the overview closes it (only if no element took the event)
    let emptyTap = null;
    const ovEmptyId = on(ovGroup, 'event', (actor, e) => {
        const type = e.type();
        const src = global.stage.get_event_actor(e);
        if (src !== ovGroup && src !== controls)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = e.get_coords();
        if (type === ET.TOUCH_BEGIN || type === Clutter.EventType.BUTTON_PRESS) {
            emptyTap = {x, y, t: e.get_time()};
        } else if ((type === ET.TOUCH_END || type === Clutter.EventType.BUTTON_RELEASE) && emptyTap) {
            const short = e.get_time() - emptyTap.t < 400 && Math.hypot(x - emptyTap.x, y - emptyTap.y) < 15;
            emptyTap = null;
            if (short && !controls._searchController.searchActive) {
                Main.overview.hide();
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    });
    const kbBox = Main.layoutManager.keyboardBox;
    const kbVisId = on(kbBox, 'notify::visible', () => controls.queue_relayout());

    // Bottom edge for the list and search results: top edge of the dock on this monitor (if visible)
    const dockTop = (monitor, fallback) => {
        // Dash-to-Dock containers (one per monitor); the visible one in the lower half of this monitor counts
        let top = fallback;
        for (const a of Main.layoutManager.uiGroup.get_children()) {
            if (a.name !== 'dashtodockContainer' || !a.visible)
                continue;
            const [x, y] = a.get_transformed_position();
            const inside = x >= monitor.x && x < monitor.x + monitor.width &&
                y >= monitor.y + monitor.height / 2 && y < monitor.y + monitor.height;
            if (inside)
                top = Math.min(top, Math.round(y - monitor.y));
        }
        return top;
    };

    // ---- Search via the magnifier ----
    let searchShown = false;
    const entry = controls._searchEntry;
    const closeSearch = () => {
        searchShown = false;
        entry.set_text('');
        if (global.stage.key_focus === entry.clutter_text || global.stage.key_focus === entry)
            global.stage.set_key_focus(null);
        try {
            Main.keyboard?.close?.();
        } catch (e) {
            log(`duo-osk: Tastatur: ${e}`);
        }
        controls.queue_relayout();
    };
    const toggleSearch = () => (searchShown || controls._searchController.searchActive ? closeSearch() : openSearch());
    const openSearch = () => {
        searchShown = true;
        controls.queue_relayout();
        entry.grab_key_focus();
        try {
            Main.keyboard?.open?.(Main.layoutManager.primaryIndex);
        } catch (e) {
            log(`duo-osk: Tastatur: ${e}`);
        }
    };
    // Reset only on a real change active -> inactive. GNOME also reports notify::search-active when the magnifier
    // puts the cursor into the empty field -> that hid the field again immediately (test run 31.10.: cursor in an
    // invisible field).
    let searchWasActive = controls._searchController.searchActive;
    const searchActiveId = on(controls._searchController, 'notify::search-active', () => {
        const act = controls._searchController.searchActive;
        if (searchWasActive && !act && !entry.get_text())
            searchShown = false;
        searchWasActive = act;
        controls.queue_relayout();
    });

    // ---- Workspaces: show no empty ones, the last empty one is the «+» card ----
    // With dynamic-workspaces Mutter keeps exactly one empty workspace at the end and deletes empty ones in between.
    // This last one is drawn as «+»: tap = switch there (new empty workspace), an app dragged onto it
    // is opened there by GNOME's Workspace.acceptDrop (the card belongs to the workspace actor).
    const wsActors = () => {
        const out = [];
        for (const v of controls._workspacesDisplay?._workspacesViews ?? []) {
            const wv = v._workspaces ? v : v._workspacesView;
            for (const w of wv?._workspaces ?? [])
                out.push(w);
        }
        return out;
    };
    // Fetch the next new window after Mutter's initial placement ('shown') onto workspace idx and monitor mon:
    // the workspace hint at launch is ignored by some apps (foot), Mutter puts new windows next to the focus.
    const placeNextWindow = (idx, mon) => {
        let createdId = 0, giveUp = 0;
        const done = () => {
            if (createdId)
                global.display.disconnect(createdId);
            if (giveUp)
                GLib.source_remove(giveUp);
            createdId = giveUp = 0;
        };
        createdId = global.display.connect('window-created', (disp, mw) => {
            if (mw.get_window_type() !== 0)   // normal windows only
                return;
            done();
            const shownId = mw.connect('shown', () => {
                mw.disconnect(shownId);
                if (idx < global.workspace_manager.n_workspaces && mw.get_workspace()?.index() !== idx)
                    mw.change_workspace_by_index(idx, false);
                if (mw.get_monitor() !== mon)
                    mw.move_to_monitor(mon);
                if (devLog)
                    log(`duo-osk: Abwurf: ${mw.get_wm_class()} -> ws${idx}/m${mon} (jetzt ws${mw.get_workspace()?.index()}/m${mw.get_monitor()})`);
            });
        });
        giveUp = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            giveUp = 0;
            done();
            return GLib.SOURCE_REMOVE;
        });
    };
    // Track GNOME's drop of an app onto an existing workspace (Workspace.acceptDrop) the same way
    let wsProto = null, origWsAccept = null;
    const hookWorkspaceDrop = () => {
        if (wsProto)
            return;
        const any = wsActors()[0];
        if (!any)
            return;
        wsProto = Object.getPrototypeOf(any);
        origWsAccept = wsProto.acceptDrop;
        wsProto.acceptDrop = function (source, ...rest) {
            const ok = origWsAccept.call(this, source, ...rest);
            if (ok && source?.app && this.metaWorkspace)
                placeNextWindow(this.metaWorkspace.index(), this.monitorIndex);
            return ok;
        };
    };
    const plusCards = new Set();
    let closing = false;   // overview is closing right now
    let plusIdle = 0;
    const cardStyle = 'border-radius: 18px; background-color: rgba(255,255,255,0.10); ' +
        'border: 2px solid rgba(255,255,255,0.22);';
    const iconStyle = 'color: rgba(255,255,255,0.85);';
    const normalWindows = () => global.get_window_actors().map(a => a.meta_window)
        .filter(mw => mw.get_window_type() === 0 && !mw.is_skip_taskbar());
    const makePlus = w => {
        const box = new St.BoxLayout({
            name: 'duoPlus',
            vertical: true,
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px;',
        });
        const row = new St.BoxLayout({style: 'spacing: 12px;', x_align: Clutter.ActorAlign.CENTER});
        const plus = new St.Button({reactive: true, can_focus: true, style: cardStyle, width: CARD, height: CARD,
            child: new St.Icon({icon_name: 'list-add-symbolic', icon_size: 30, style: iconStyle})});
        row.add_child(plus);
        // Drop onto «+»: first switch to the new workspace, then launch (the workspace hint at
        // launch is ignored by some apps, e.g. foot). Windows from the overview move there.
        plus._delegate = {
            handleDragOver: source => (source?.app || source?.metaWindow)
                ? MOTION.COPY_DROP : MOTION.CONTINUE,
            acceptDrop: source => {
                const ws = w.metaWorkspace;
                if (!ws)
                    return false;
                const idx = ws.index();
                if (source?.metaWindow) {
                    source.metaWindow.change_workspace_by_index(idx, false);
                    return true;
                }
                if (!source?.app)
                    return false;
                ws.activate(global.get_current_time());
                placeNextWindow(idx, w.monitorIndex);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                    if (source.app.can_open_new_window())
                        source.app.open_new_window(idx);
                    else
                        source.app.activate();
                    return GLib.SOURCE_REMOVE;
                });
                return true;
            },
        };
        plus.connect('clicked', () => {
            plusOut();
            w.metaWorkspace?.activate(global.get_current_time());
            Main.overview.hide();
        });
        // Magnifier (main panel only): shows the search field and sets the focus (keyboard comes)
        if (w.monitorIndex === Main.layoutManager.primaryIndex) {
            const lupe = new St.Button({reactive: true, can_focus: true, style: cardStyle, width: CARD, height: CARD,
                child: new St.Icon({icon_name: 'system-search-symbolic', icon_size: 26, style: iconStyle})});
            lupe.connect('clicked', () => toggleSearch());
            row.add_child(lupe);
            w._duoLupe = lupe;
            // «Close all» as a pill above «+» and the magnifier; the first tap asks (red, «Really?»), the second closes
            const label = new St.Label({text: 'Alle schliessen', y_align: Clutter.ActorAlign.CENTER,
                style: 'font-weight: bold; color: rgba(255,255,255,0.9);'});
            const closeAll = new St.Button({reactive: true, can_focus: true, width: 2 * CARD + 12, height: 44,
                style: `${cardStyle} border-radius: 22px;`, child: label});
            let armed = 0;
            const disarm = () => {
                if (armed)
                    GLib.source_remove(armed);
                armed = 0;
                label.text = 'Alle schliessen';
                closeAll.style = `${cardStyle} border-radius: 22px;`;
            };
            closeAll.connect('clicked', () => {
                const wins = normalWindows();
                if (!wins.length)
                    return;
                if (!armed) {
                    label.text = `Wirklich? (${wins.length})`;
                    closeAll.style = `${cardStyle} border-radius: 22px; background-color: rgba(220,60,60,0.55); ` +
                        'border-color: rgba(255,120,120,0.8);';
                    armed = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                        armed = 0;
                        disarm();
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                }
                disarm();
                const t = global.get_current_time();
                for (const mw of wins)
                    mw.delete(t);
            });
            closeAll.connect('destroy', () => { if (armed) GLib.source_remove(armed); armed = 0; });
            const sync = () => { closeAll.opacity = normalWindows().length ? 255 : 90; };
            sync();
            // track only while the card is visible (before, constantly every 0.5 s, even with the overview closed)
            closeAll._syncId = 0;
            const syncTimer = () => {
                if (closeAll.mapped && !closeAll._syncId) {
                    sync();
                    closeAll._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { sync(); return GLib.SOURCE_CONTINUE; });
                } else if (!closeAll.mapped && closeAll._syncId) {
                    GLib.source_remove(closeAll._syncId);
                    closeAll._syncId = 0;
                }
            };
            closeAll.connect('notify::mapped', syncTimer);
            closeAll.connect('destroy', () => { if (closeAll._syncId) GLib.source_remove(closeAll._syncId); closeAll._syncId = 0; });
            box.add_child(closeAll);
            w._duoCloseAll = closeAll;
        }
        box.add_child(row);
        w.add_child(box);
        // Size follows the workspace in the same frame: scaling only (no re-layout, no lagging behind)
        box.set_pivot_point(0.5, 0.5);
        const fit = () => {
            if (closing)   // when closing, do not grow along with the zooming workspace
                return;
            // the whole group must fit into the area: main panel 2 cards + pill (156 x 126), otherwise one card
            const natW = w._duoLupe ? 2 * CARD + 12 : CARD;
            const natH = w._duoCloseAll ? CARD + 10 + 44 : CARD;
            const k = w._duoLupe
                ? Math.max(0.3, Math.min(1.4, w.width * 0.8 / natW, w.height * 0.8 / natH))
                : Math.max(0.3, Math.min(1.6, w.width * 0.36 / CARD, w.height * 0.55 / CARD));
            box.set_scale(k, k);
        };
        fit();
        box._fitId = w.connect('notify::allocation', fit);
        box.connect('destroy', () => {
            if (box._fitId && !w._duoGone)
                w.disconnect(box._fitId);
        });
        if (!w._duoDestroyHook) {   // GNOME deletes workspace actors including the card -> only unregister
            w._duoDestroyHook = true;
            w.connect('destroy', () => {
                w._duoGone = true;
                plusCards.delete(w);
            });
        }
        w._duoPlus = box;
        w._duoPlusBtn = plus;
        plusCards.add(w);
    };
    const dropPlus = w => {
        if (w._duoGone) {
            plusCards.delete(w);
            return;
        }
        w._duoPlus?.destroy();
        w._duoPlus = w._duoPlusBtn = w._duoLupe = w._duoCloseAll = null;
        w._background.remove_transition?.('opacity');
        w._background.opacity = 255;
        plusCards.delete(w);
    };
    const syncPlus = () => {
        if (closing)
            return;
        const wm = global.workspace_manager;
        const last = wm.n_workspaces - 1;
        for (const w of wsActors()) {
            const isPlus = Main.layoutManager.monitors.length === 2 && w.metaWorkspace &&
                w.metaWorkspace.index() === last && last > 0 && w._windows.length === 0 &&
                // the active empty workspace is also «+» (there is only the app view; otherwise «+» and the magnifier were missing)
                w.metaWorkspace.list_windows().filter(mw => !mw.is_on_all_workspaces()).length === 0;
            if (isPlus && !w._duoPlus)
                makePlus(w);
            else if (!isPlus && w._duoPlus)
                dropPlus(w);
            if (w._duoPlus) {
                w._background.opacity = 0;

            }
        }
    };
    let plusTimer = 0;
    const startPlus = () => {
        hookWorkspaceDrop();
        syncPlus();
        if (!plusTimer) {
            plusTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                syncPlus();
                return GLib.SOURCE_CONTINUE;
            });
        }
    };
    const stopPlus = () => {
        if (plusTimer)
            GLib.source_remove(plusTimer);
        plusTimer = 0;
    };
    // Dock only on the canvas: hide when the overview opens, back when it closes
    const docks = () => Main.layoutManager.uiGroup.get_children().filter(a => a.name === 'dashtodockContainer');
    const dockOut = () => {
        for (const a of docks()) {
            a.remove_transition?.('opacity');
            a.ease({opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => { if (Main.overview.visible) a.hide(); }});
        }
    };
    const dockIn = () => {
        for (const a of docks()) {
            a.remove_transition?.('opacity');
            a.show();
            a.ease({opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    };
    // When the overview closes, the (new) workspace zooms to full screen: fade the cards out softly,
    // fade the background in, so it grows into a normal canvas (video 22:04: the cards grew along, doubled).
    const plusOut = () => {
        closing = true;
        stopPlus();
        for (const w of [...plusCards]) {
            if (w._duoGone)
                continue;
            w._duoPlus?.ease({opacity: 0, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            w._background.ease({opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    };
    const plusClear = () => {
        for (const w of [...plusCards])
            dropPlus(w);
        closing = false;
    };
    const ovIds = [
        on(Main.overview, 'showing', () => {
            closing = false;
            // Reopened before «hidden» came: bring back the faded-out cards
            for (const w of [...plusCards]) {
                if (w._duoGone || !w._duoPlus)
                    continue;
                w._duoPlus.remove_transition?.('opacity');
                w._duoPlus.opacity = 255;
                w._background.remove_transition?.('opacity');
                w._background.opacity = 0;
            }
            dockOut();
        }),
        on(Main.overview, 'hiding', () => {
            dockIn();
            plusOut();
        }),
        on(Main.overview, 'showing', startPlus),
        on(Main.overview, 'hidden', () => {
            stopPlus();
            plusClear();
            searchShown = false;
            entry.set_text('');
            scroll.vadjustment.value = 0;
            collapse = 0;
        }),
    ];
    failUndo.push(() => {   // reset cards, timers, dock and search field when loading aborts
        stopPlus();
        if (plusIdle)
            GLib.source_remove(plusIdle);
        for (const w of [...plusCards])
            dropPlus(w);
        dockIn();
        layout._searchEntry.opacity = 255;
        layout._searchEntry.reactive = true;
    });
    if (Main.overview.visible) {
        startPlus();
        dockOut();
    }

    // ---- Swipe from the bottom panel edge: the overview follows the finger (like app switching on a phone) ----
    // GNOME drives the overview through a progress 0 (canvas) .. 2 (app view) and animates every
    // intermediate value itself (windows shrink into their workspaces, tiles slide in). The finger drives this
    // value directly; releasing with momentum or far enough snaps in, otherwise it springs back. In the overview
    // the same gesture closes it again.
    // The controller never reports the bottom ~4 mm: a swipe from the bezel always starts at y = 1735 of 1800 (raw data
    // 31.10., 20 swipes, all 23 logical px above the edge). Hence a zone of 32 px (≈ 5.5 mm), like the gesture bar on a phone.
    const EDGE = 32;
    const FULL = 0.55;          // Share of the panel height for the full travel 0 -> 2
    const fakeTracker = {confirmSwipe: () => {}};
    // The shell's own gesture strip per panel (like the gesture bar on a phone): touches there do NOT go to
    // app windows (otherwise e.g. the resize edge of Files grabbed the finger and the gesture broke off, video 09:05).
    // With a subtle grip line, so you can see where to swipe.
    // GNOME 48: colours are Cogl.Color (Clutter.Color no longer exists)
    const Cogl = imports.gi.Cogl;
    const schwarz = alpha => {
        const [ok, c] = Cogl.Color.from_string(`#000000${alpha.toString(16).padStart(2, '0')}`);
        return ok ? c : null;
    };
    const strips = [];
    const buildStrips = () => {
        for (const st of strips.splice(0))
            st.destroy();
        if (Main.layoutManager.monitors.length !== 2)
            return;
        for (const m of Main.layoutManager.monitors) {
            // Our own black bar like the top bar; reserves space (strut), maximised windows end above it.
            // Transparent in the overview, like GNOME's top bar.
            const st = new St.Widget({
                name: 'duoGestenstreifen', reactive: true,
                x: m.x, y: m.y + m.height - EDGE, width: m.width, height: EDGE,
                layout_manager: new Clutter.BinLayout(),
            });
            // Set the colour directly (a style rule would override the cross-fade in the overview)
            st.background_color = schwarz(Main.overview.visible ? 0 : 255);
            st.add_child(new St.Widget({
                width: 64, height: 5, y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER,
                style: 'border-radius: 3px; background-color: rgba(255,255,255,0.55);',
            }));
            Main.layoutManager.addTopChrome(st, {affectsInputRegion: true, affectsStruts: true, trackFullscreen: true});
            strips.push(st);
        }
    };
    // With the on-screen keyboard open, no strip on its panel (it would lie over space/enter). GNOME never hides the
    // keyboard area, it pushes the keyboard out instead -> Main.keyboard.visible + 'visibility-changed'.
    const syncStrips = () => {
        const kbOpen = !!Main.keyboard?.visible;
        const kbMon = Main.layoutManager.keyboardIndex;
        const mons = Main.layoutManager.monitors;
        strips.forEach((st, i) => {
            // not over full screen either (video): our making it visible otherwise overrode trackFullscreen (31.10.)
            st.visible = !(kbOpen && (kbMon === i || kbMon < 0)) && !mons[i]?.inFullscreen;
        });
    };
    // LayoutManager recomputes inFullscreen in the same signal -> reconcile afterwards
    on(global.display, 'in-fullscreen-changed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        syncStrips();
        return GLib.SOURCE_REMOVE;
    }));
    const stripLook = inOverview => {
        for (const st of strips) {
            st.remove_transition?.('background-color');
            st.ease({background_color: schwarz(inOverview ? 0 : 255), duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    };
    // Lift the dock above the bar (Dash-to-Dock sets y = monitor bottom edge and shifts by -dock height;
    // we add the bar height instead of overwriting its own shift)
    const liftDocks = () => {
        const on = strips.length > 0;
        for (const a of Main.layoutManager.uiGroup.get_children()) {
            if (a.name === 'dashtodockContainer')
                a.translation_y = -a.height - (on ? EDGE : 0);   // Dash-to-Dock: y = monitor bottom edge, shift = -height
        }
    };
    buildStrips();
    failUndo.push(() => { for (const st of strips.splice(0)) st.destroy(); });
    syncStrips();
    liftDocks();
    // Dash-to-Dock rebuilds itself on rotation/settings or changes its height -> lift immediately then; before, polled every
    // 2 s (constant wake-ups), now by event plus a rare fallback every 15 s
    const dockHooks = [];
    const hookDocks = () => {
        for (const a of Main.layoutManager.uiGroup.get_children()) {
            if (a.name !== 'dashtodockContainer' || a._duoLiftId)
                continue;
            a._duoLiftId = a.connect('notify::height', liftDocks);
            dockHooks.push(a);
            // Dash to Dock rebuilds its bars: remove destroyed ones from the list (otherwise it grows and unloading
            // touches dead objects, finding 31.10.)
            a.connect('destroy', () => {
                const i = dockHooks.indexOf(a);
                if (i >= 0)
                    dockHooks.splice(i, 1);
            });
        }
        liftDocks();
    };
    on(Main.layoutManager.uiGroup, 'child-added', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        hookDocks();
        return GLib.SOURCE_REMOVE;
    }));
    hookDocks();
    undo.push(() => {
        for (const a of dockHooks.splice(0)) {
            try {
                a.disconnect(a._duoLiftId);
            } catch (e) {
                // Dock already destroyed
            }
            delete a._duoLiftId;
        }
    });
    const dockLiftTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => { liftDocks(); return GLib.SOURCE_CONTINUE; });
    failUndo.push(() => {
        GLib.source_remove(dockLiftTimer);
        for (const a of Main.layoutManager.uiGroup.get_children()) {
            if (a.name === 'dashtodockContainer')
                a.translation_y = -a.height;
        }
    });
    const stripOvIds = [on(Main.overview, 'showing', () => stripLook(true)),
        on(Main.overview, 'hiding', () => stripLook(false))];
    const stripMonId = on(Main.layoutManager, 'monitors-changed', () => { buildStrips(); syncStrips(); });
    const stripKbId = on(Main.keyboard, 'visibility-changed', syncStrips);
    // Touch driver: two-thumb detection only while the on-screen keyboard is open (otherwise it chopped fast
    // swipes into single taps -> dock icon «tapped», VLC started on an edge swipe, 31.10.)
    const kbFlag = '/run/duo/frei/tastatur';
    const syncKbFlag = () => {
        try {
            if (Main.keyboard.visible)
                GLib.file_set_contents(kbFlag, '1');
            else if (GLib.file_test(kbFlag, GLib.FileTest.EXISTS))
                GLib.unlink(kbFlag);
        } catch (e) {
            // Directory missing (old driver)
        }
    };
    on(Main.keyboard, 'visibility-changed', syncKbFlag);
    syncKbFlag();
    undo.push(() => {
        if (GLib.file_test(kbFlag, GLib.FileTest.EXISTS))
            GLib.unlink(kbFlag);
    });
    // Element under the finger WITHOUT the strip (for clicks forwarded to the dock)
    const pickBelowStrip = (x, y) => {
        for (const st of strips)
            st.reactive = false;
        const a = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        for (const st of strips)
            st.reactive = true;
        return a;
    };
    // Short tap in the strip over an app window: hide the strip briefly and repeat the tap with a virtual finger at
    // the same spot (app buttons at the bottom edge, e.g. Back/Forward in Files, stay usable)
    let replaying = false, replayDev = null, replayBusy = false;
    const replayTap = (x, y) => {
        // never two virtual fingers in the same slot: a second touch-down before the release = Mutter crash
        // (meta_seat_impl_acquire_touch_state_in_impl, 31.10.)
        if (replayBusy)
            return;
        replayBusy = true;
        replayDev ??= Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
        for (const st of strips)
            st.hide();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {   // have the input region recomputed
            replaying = true;
            replayDev.notify_touch_down(GLib.get_monotonic_time(), 0, x, y);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                replayDev.notify_touch_up(GLib.get_monotonic_time(), 0);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                    replaying = false;
                    replayBusy = false;
                    for (const st of strips)
                        st.show();
                    syncStrips();
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    };
    let edge = null, edgeWatch = 0;
    const progNow = () => controls._stateAdjustment.value;
    // ALWAYS finish a started gesture (otherwise the overview stays stuck half open)
    const finishEdge = (ed, why) => {
        if (edgeWatch)
            GLib.source_remove(edgeWatch);
        edgeWatch = 0;
        if (!ed?.begun || ed.done)
            return;
        ed.done = true;
        const last = ed.samples[ed.samples.length - 1];
        let first = ed.samples[0];
        for (const sm of ed.samples) {
            if (last.t - sm.t <= 120) {
                first = sm;
                break;
            }
        }
        const v = why === 'ende' || ed.ended ? (last.p - first.p) / Math.max(1, last.t - first.t) : 0;
        let target;
        if (ed.opening)
            target = v > 0.004 || (last.p > 0.7 && v > -0.004) ? APP_GRID : 0;
        else
            target = v < -0.004 || (last.p < 1.3 && v < 0.004) ? 0 : APP_GRID;
        const duration = Math.round(Math.max(160, Math.min(380, Math.abs(target - last.p) * 220)));
        Main.overview._gestureEnd(fakeTracker, duration, target);
        if (devLog)
            log(`duo-osk: Randwisch ${ed.opening ? 'auf' : 'zu'} (${why}): stand ${last.p.toFixed(2)} schwung ${v.toFixed(4)} -> ${target} in ${duration} ms`);
    };
    const armWatch = () => {
        if (edgeWatch)
            GLib.source_remove(edgeWatch);
        edgeWatch = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            edgeWatch = 0;
            const ed = edge;
            edge = null;
            finishEdge(ed, 'waechter');
            return GLib.SOURCE_REMOVE;
        });
    };
    // Self-healing on load: clean up a stuck gesture overview
    if (controls._stateAdjustment.gestureInProgress) {
        const pv = progNow();
        Main.overview._gestureEnd(fakeTracker, 200, pv > 1 ? APP_GRID : 0);
        log(`duo-osk: haengende Gesten-Uebersicht (${pv.toFixed(2)}) aufgeraeumt`);
    }
    const edgeId = on(global.stage, 'captured-event', (actor, e) => {
        const ty = e.type();
        if (ty !== ET.TOUCH_BEGIN && ty !== ET.TOUCH_UPDATE && ty !== ET.TOUCH_END && ty !== ET.TOUCH_CANCEL)
            return Clutter.EVENT_PROPAGATE;
        if (replaying)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = e.get_coords();
        if (ty === ET.TOUCH_BEGIN) {
            // Controller dropout (> 150 ms) in the middle of a swipe: a new finger near the last spot = same gesture
            if (edge?.begun && !edge.done) {
                if (e.get_time() - edge.lastT < 450 && Math.abs(y - edge.lastY) < 90) {
                    edge.seq = slotOf(e);
                    edge.ended = false;
                    edge.y0 += y - edge.lastY;   // compensate the jump, progress stays continuous
                    edge.lastY = y;
                    edge.lastT = e.get_time();
                    armWatch();
                    return Clutter.EVENT_STOP;
                }
                const ed = edge;
                edge = null;
                finishEdge(ed, 'neuer finger');
            }
            edge = null;
            if (Main.layoutManager.monitors.length !== 2 || Main.keyboard?.visible || Main.modalCount > 0 && !Main.overview.visible)
                return Clutter.EVENT_PROPAGATE;
            // Overview still in its show/hide animation: no new gesture (otherwise «Invalid overview shown
            // transition from SHOWING to SHOWING», 31.10.)
            if (Main.overview.animationInProgress)
                return Clutter.EVENT_PROPAGATE;
            const m = Main.layoutManager.monitors.find(mo => x >= mo.x && x < mo.x + mo.width && y >= mo.y && y < mo.y + mo.height);
            if (m) {   // remember the tap's panel here too (this gesture stops the event before the remembering function)
                lastTap.mon = m.index;
                lastTap.t = GLib.get_monotonic_time();
            }
            if (!m || y < m.y + m.height - EDGE)
                return Clutter.EVENT_PROPAGATE;
            // The bottom strip always belongs to the gesture (also over the dock, which in portrait sits exactly there).
            // A short tap without movement on a shell element is then forwarded as a click.
            let shellBtn = null;
            const hit = pickBelowStrip(x, y);
            if (hit && hit !== global.stage && !global.window_group.contains(hit)) {
                for (let a = hit; a; a = a.get_parent()) {
                    if (a instanceof St.Button) {
                        shellBtn = a;
                        break;
                    }
                }
            }
            const p0 = Main.overview.visible ? progNow() : 0;
            edge = {y0: y, p0, opening: p0 < 1, dist: m.height * FULL, seq: slotOf(e), samples: [{t: e.get_time(), p: p0}], begun: false,
                lastY: y, lastT: e.get_time(), done: false, t0: e.get_time(), shellBtn, maxDy: 0, x0: x,
                overWindow: !!hit && global.window_group.contains(hit)};
            return Clutter.EVENT_STOP;
        }
        if (!edge || slotOf(e) !== edge.seq)
            return Clutter.EVENT_PROPAGATE;
        if (ty === ET.TOUCH_UPDATE) {
            edge.lastY = y;
            edge.lastT = e.get_time();
            if (edge.begun)
                armWatch();
            const dy = edge.y0 - y;                       // upwards positive
            edge.maxDy = Math.max(edge.maxDy, Math.abs(dy));
            let p = edge.opening ? edge.p0 + 2 * dy / edge.dist : edge.p0 - 2 * dy / edge.dist;
            p = Math.max(0, Math.min(2, p));
            if (!edge.begun && Math.abs(dy) > 6) {
                edge.begun = true;
                Main.overview._gestureBegin(fakeTracker);
                armWatch();
            }
            if (edge.begun) {
                Main.overview._gestureUpdate(fakeTracker, Math.max(0.0001, p));
                edge.samples.push({t: e.get_time(), p});
                if (edge.samples.length > 8)
                    edge.samples.shift();
            }
            return Clutter.EVENT_STOP;
        }
        // Release: target from position and momentum. Controller dropouts also end here -> wait briefly whether the
        // finger comes right back (continuation above), otherwise finish.
        const ed = edge;
        if (!ed.begun) {
            edge = null;
            // Short tap without a swipe on a shell element (e.g. dock icon): forward the click
            if (ty === ET.TOUCH_END && ed.maxDy < 12 && e.get_time() - ed.t0 < 600) {
                if (ed.shellBtn) {
                    try {
                        ed.shellBtn.emit('clicked', 1);
                    } catch (err) {
                        log(`duo-osk: Klick nachreichen: ${err}`);
                    }
                } else if (ed.overWindow && !Main.overview.visible) {
                    replayTap(ed.x0, ed.y0);
                } else if (Main.overview.visible) {
                    Main.overview.hide();   // like any free spot of the overview
                }
            }
            return Clutter.EVENT_STOP;
        }
        if (ty === ET.TOUCH_CANCEL) {
            edge = null;
            finishEdge(ed, 'abbruch');
            return Clutter.EVENT_STOP;
        }
        // A release can be a dropout that lasts longer than the debounce in the driver (up to 200 ms measured):
        // wait briefly for the continuation (TOUCH_BEGIN above), otherwise finish with the momentum so far.
        ed.ended = true;
        if (edgeWatch)
            GLib.source_remove(edgeWatch);
        // since duoheat (01.11.) the controller no longer drops out mid-swipe -> only a short wait now (before 120 ms)
        edgeWatch = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
            edgeWatch = 0;
            if (edge === ed) {
                edge = null;
                finishEdge(ed, 'ende');
            }
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
    });

    // ---- Window on the finger: long press on the top edge ----
    // Apps with a self-drawn title bar that only reacts to the mouse (Qt/KDE, e.g. Red, wish 31.10.) can
    // neither be moved nor nudged to the other panel with the finger. A long press (450 ms, still) on the top
    // 44 px of such a window starts Mutter's own move with this finger: the app gets a cancel instead of a
    // tap, and the nudge from extension.js (grab-op-begin/-end) works as with GNOME title bars.
    const LIFT_MS = 450, LIFT_TOP = 44, LIFT_SLOP = 12;
    let winLift = null;
    const liftHaptic = () => {
        try {
            const Gio = imports.gi.Gio;
            const sock = Gio.Socket.new(Gio.SocketFamily.UNIX, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.DEFAULT);
            sock.send_to(Gio.UnixSocketAddress.new('/run/duo/haptik.sock'), new TextEncoder().encode('25'), null);
            sock.close();
        } catch (e) {
            // Helper not there
        }
    };
    // After release: the window fills the panel its centre lies in (otherwise it hangs across the hinge;
    // Qt windows like Red cannot be maximised). The app's minimum size wins (Red at the bottom: sticks out 6 px).
    // Applies to every move of such windows (also when the app starts it itself).
    const snapIntoPanel = win => {
        try {
            const r = win.get_frame_rect();
            const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
            const m = Main.layoutManager.monitors.find(mo => cx >= mo.x && cx < mo.x + mo.width &&
                cy >= mo.y && cy < mo.y + mo.height) ?? Main.layoutManager.monitors[win.get_monitor()];
            // not: maximised, fixed (games) and windows spanning both panels (Red Alert Duo, doppel())
            if (!m || win.get_maximized() || !win.allows_resize() || r.height > m.height * 1.5)
                return;
            // Fill the panel completely (such windows cannot be maximised, wish 31.10.): width and height of the
            // panel below the clock bar; ignore the 32 px strip of the gesture grip at the bottom (it only lies on top).
            const wa = Main.layoutManager.getWorkAreaForMonitor(m.index);
            // Qt draws a 1 px border with rounded corners inside, and 652 logical px at 2.76x scaling do not end on
            // whole pixels: 2 px beyond the panel edges, so no gap remains (photo 31.10.)
            const B = 2, topFree = wa.y === m.y;
            const x = wa.x - B, y = topFree ? wa.y - B : wa.y, ww = wa.width + 2 * B, wh = m.y + m.height + B - y;
            if (x !== r.x || y !== r.y)
                win.move_frame(true, x, y);
            if (ww !== r.width || wh !== r.height)
                win.move_resize_frame(true, x, y, ww, wh);
            if (devLog)
                log(`duo-osk: Einrasten ${win.get_wm_class()} ${r.x},${r.y} ${r.width}x${r.height} -> ${x},${y} ${ww}x${wh} (Monitor ${m.index})`);
        } catch (e) {
            log(`duo-osk: Einrasten: ${e}`);
        }
    };
    on(global.display, 'grab-op-end', (d, w, op) => {
        const Meta = imports.gi.Meta;
        if (!w || w.decorated || w.get_gtk_application_id() ||
            (op !== Meta.GrabOp.MOVING && op !== Meta.GrabOp.MOVING_UNCONSTRAINED))
            return;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {   // measure after a nudge (extension.js, +40 ms)
            snapIntoPanel(w);
            return GLib.SOURCE_REMOVE;
        });
    });
    const liftCancel = () => {
        if (winLift?.timer)
            GLib.source_remove(winLift.timer);
        winLift = null;
    };
    const liftWindowAt = (x, y) => {
        const actors = global.get_window_actors().filter(a => a.visible);
        for (let i = actors.length - 1; i >= 0; i--) {
            const w = actors[i].meta_window;
            if (!w || w.minimized || w.get_window_type() !== imports.gi.Meta.WindowType.NORMAL)
                continue;
            const r = w.get_frame_rect();
            if (x < r.x || x >= r.x + r.width || y < r.y || y >= r.y + r.height)
                continue;
            // only windows without a Mutter title bar (self-drawn), top strip
            // GTK apps (header bar) drag with the finger themselves -> do not touch
            return !w.decorated && !w.get_gtk_application_id() && y < r.y + LIFT_TOP ? w : null;
        }
        return null;
    };
    on(global.stage, 'captured-event', (actor, e) => {
        const ty = e.type();
        if (ty === ET.TOUCH_BEGIN) {
            liftCancel();
            if (Main.overview.visible || Main.modalCount > 0)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = e.get_coords();
            const win = liftWindowAt(x, y);
            if (devLog && GLib.file_test('/run/duo/frei/liftlog', GLib.FileTest.EXISTS))
                log(`duo-osk: Langdruck-Pruefung ${Math.round(x)},${Math.round(y)} -> ${win?.get_wm_class() ?? '-'}`);
            if (!win)
                return Clutter.EVENT_PROPAGATE;
            const l = {win, x0: x, y0: y, x, y, seq: e.get_event_sequence(), device: e.get_device(), slot: slotOf(e)};
            l.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LIFT_MS, () => {
                l.timer = 0;
                if (winLift !== l)
                    return GLib.SOURCE_REMOVE;
                winLift = null;
                try {
                    const ok = l.win.begin_grab_op(imports.gi.Meta.GrabOp.MOVING, l.device, l.seq,
                        global.get_current_time(), new imports.gi.Graphene.Point({x: l.x, y: l.y}));
                    if (ok)
                        liftHaptic();
                    if (devLog)
                        log(`duo-osk: Fenster am Finger ${l.win.get_wm_class()}: ${ok}`);
                } catch (err) {
                    log(`duo-osk: Fenster am Finger: ${err}`);
                }
                return GLib.SOURCE_REMOVE;
            });
            winLift = l;
            return Clutter.EVENT_PROPAGATE;
        }
        if (!winLift || slotOf(e) !== winLift.slot)
            return Clutter.EVENT_PROPAGATE;
        if (ty === ET.TOUCH_UPDATE) {
            const [x, y] = e.get_coords();
            winLift.x = x;
            winLift.y = y;
            if (Math.hypot(x - winLift.x0, y - winLift.y0) > LIFT_SLOP)
                liftCancel();
        } else if (ty === ET.TOUCH_END || ty === ET.TOUCH_CANCEL) {
            liftCancel();
        }
        return Clutter.EVENT_PROPAGATE;
    });
    undo.push(liftCancel);

    // ---- Keyboard for Qt apps ----
    // Mutter switches the on-screen keyboard on only at the SECOND «enable» of a text field (text-input-v3: the first
    // is only focus). GTK sends it again on tap, Qt (Red, KDE apps) only once -> the keyboard never came
    // (31.10.). After a tap into a non-GTK window: if a text field then has input focus, open the keyboard.
    // Only after a TAP (short, still), never after scrolling/swiping: otherwise the keyboard came back on every scroll
    // as long as a text field held the focus (01.11.).
    let oskTimer = 0;
    const oskDown = new Map();   // Slot -> {x, y, t, focus}
    on(global.stage, 'captured-event', (actor, e) => {
        const ty = e.type();
        if (ty === ET.TOUCH_BEGIN) {
            const [bx, by] = e.get_coords();
            oskDown.set(slotOf(e), {x: bx, y: by, t: e.get_time()});
            return Clutter.EVENT_PROPAGATE;
        }
        if (ty !== ET.TOUCH_END)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = e.get_coords();
        const down = oskDown.get(slotOf(e));
        oskDown.delete(slotOf(e));
        if (!down || Math.hypot(x - down.x, y - down.y) > 12 || e.get_time() - down.t > 450)
            return Clutter.EVENT_PROPAGATE;
        const fw = global.display.get_focus_window();
        if (!fw || fw.get_gtk_application_id() || fw.get_client_type() !== imports.gi.Meta.WindowClientType.WAYLAND)
            return Clutter.EVENT_PROPAGATE;
        const r = fw.get_frame_rect();
        if (x < r.x || x >= r.x + r.width || y < r.y || y >= r.y + r.height || Main.overview.visible)
            return Clutter.EVENT_PROPAGATE;
        if (oskTimer)
            GLib.source_remove(oskTimer);
        oskTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            oskTimer = 0;
            try {
                if (Main.inputMethod?._currentFocus && !Main.keyboard.visible && global.display.get_focus_window() === fw) {
                    Main.keyboard.open(Main.layoutManager.focusIndex);
                    if (devLog)
                        log(`duo-osk: Tastatur fuer ${fw.get_wm_class()} geoeffnet (Qt-Textfeld)`);
                }
            } catch (err) {
                log(`duo-osk: Qt-Tastatur: ${err}`);
            }
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_PROPAGATE;
    });
    undo.push(() => {
        if (oskTimer)
            GLib.source_remove(oskTimer);
        oskTimer = 0;
    });

    // ---- No keyboard from scroll fragments ----
    // In the middle of scrolling the sensor sometimes briefly reports «finger gone»; the short tail piece after that acts on
    // GTK text fields (Iotas) like a tap and opens the on-screen keyboard (01.11.: it kept coming while scrolling). A
    // touch that begins up to 350 ms after the end of a movement near its end point is a fragment: when
    // it ends, the keyboard may not open for 600 ms.
    const frag = {lastMoveEnd: null, starts: new Map(), blockUntil: 0};
    const kbPatch = () => {
        const kb = Main.keyboard?._keyboard;
        if (!kb)
            return;
        const proto = Object.getPrototypeOf(kb);
        if (proto.__duoOrigOpen)
            return;
        proto.__duoOrigOpen = proto.open;
        proto.open = function (...args) {
            if ((globalThis.__duoOskBlockUntil ?? 0) > GLib.get_monotonic_time()) {
                if (devLog)
                    log('duo-osk: Tastatur nach Scroll-Bruchstueck unterdrueckt');
                return undefined;
            }
            return proto.__duoOrigOpen.apply(this, args);
        };
        undo.push(() => {
            if (proto.__duoOrigOpen) {
                proto.open = proto.__duoOrigOpen;
                delete proto.__duoOrigOpen;
            }
        });
    };
    kbPatch();
    on(global.stage, 'captured-event', (actor, e) => {
        const ty = e.type();
        if (ty !== ET.TOUCH_BEGIN && ty !== ET.TOUCH_UPDATE && ty !== ET.TOUCH_END)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = e.get_coords(), slot = slotOf(e), t = e.get_time();
        if (ty === ET.TOUCH_BEGIN) {
            kbPatch();
            const lm = frag.lastMoveEnd;
            const isFrag = !!lm && t - lm.t < 350 && Math.hypot(x - lm.x, y - lm.y) < 150;
            frag.starts.set(slot, {x, y, max: 0, isFrag});
        } else if (frag.starts.has(slot)) {
            const st = frag.starts.get(slot);
            st.max = Math.max(st.max, Math.hypot(x - st.x, y - st.y));
            if (ty === ET.TOUCH_END) {
                frag.starts.delete(slot);
                if (st.max > 25)
                    frag.lastMoveEnd = {t, x, y};
                if (st.isFrag || st.max > 25)   // also the scroll end itself (GTK opens on release)
                    globalThis.__duoOskBlockUntil = GLib.get_monotonic_time() + 600 * 1000;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    });
    undo.push(() => {
        globalThis.__duoOskBlockUntil = 0;
    });

    // ---- New windows where you last tapped ----
    // Mutter places new windows at the pointer; touch does not move the pointer -> a launch from the dock of one
    // panel opened on the other. Remember the last tap per monitor; fetch a new app window (normal, without a parent
    // window) onto that monitor up to 8 s later (after Mutter's initial placement).
    const lastTap = {mon: -1, t: 0};
    const tapId = on(global.stage, 'captured-event', (actor, e) => {
        const ty = e.type();
        if (ty === ET.TOUCH_BEGIN || ty === Clutter.EventType.BUTTON_PRESS) {
            const [x, y] = e.get_coords();
            const mons = Main.layoutManager.monitors;
            const m = mons.find(mo => x >= mo.x && x < mo.x + mo.width && y >= mo.y && y < mo.y + mo.height);
            if (m) {
                lastTap.mon = m.index;
                lastTap.t = GLib.get_monotonic_time();
            }
        }
        return Clutter.EVENT_PROPAGATE;
    });
    const newWinId = on(global.display, 'window-created', (disp, mw) => {
        if (mw.get_window_type() !== 0 || mw.get_transient_for() || Main.layoutManager.monitors.length !== 2)
            return;
        const mon = lastTap.mon;
        if (mon < 0 || GLib.get_monotonic_time() - lastTap.t > 8000000)
            return;
        const shownId = mw.connect('shown', () => {
            mw.disconnect(shownId);
            if (mw.get_monitor() !== mon) {
                const wasMax = mw.get_maximized();
                mw.move_to_monitor(mon);
                if (wasMax && !mw.get_maximized())
                    mw.maximize(3);
                if (devLog)
                    log(`duo-osk: neues Fenster ${mw.get_wm_class()} -> Monitor ${mon} (letzter Tipp)`);
            }
        });
    });

    // ---- One overview: every opening (top bar, hot corner, Super key, dock) leads into the app view ----
    const ov = Main.overview;
    const origShow = ov.show;
    ov.show = function (state, ...rest) {
        if (active() && (state === undefined || state === WINDOW_PICKER))
            state = APP_GRID;
        return origShow.call(this, state, ...rest);
    };
    failUndo.push(() => { ov.show = origShow; });

    // ---- Layout ----
    failUndo.push(() => {
        proto.vfunc_allocate = orig.alloc;
        proto._computeWorkspacesBoxForState = orig.ws;
    });
    proto._computeWorkspacesBoxForState = function (state, box, searchHeight, dashHeight, thumbnailsHeight, spacing) {
        const searchingNow = searchShown || controls._searchController.searchActive;
        // Window view without a search bar: its space goes to the windows (search appears only when typing)
        if (state === WINDOW_PICKER && active() && !searchingNow)
            return orig.ws.call(this, state, box, 0, dashHeight, thumbnailsHeight, spacing);
        if (state !== APP_GRID || !active())
            return orig.ws.call(this, state, box, searchHeight, dashHeight, thumbnailsHeight, spacing);
        const [width, height] = box.get_size();
        const full = Math.round(height * WS_RATIO);
        wsFull = full;
        collapse = Math.min(collapse, full / 2);   // scroll along down to half size (applyDelta)
        const wb = box.copy();
        wb.set_origin(0, this._workAreaBox.y1 + spacing);
        wb.set_size(width, Math.round(full - collapse));
        return wb;
    };

    proto.vfunc_allocate = function (container, box) {
        orig.alloc.call(this, container, box);
        if (!active()) {
            if (scroll.visible)
                scroll.visible = false;
            this._searchEntry.opacity = 255;
            this._searchEntry.reactive = true;
            return;
        }
        if (!scroll.visible)
            scroll.visible = true;
        const startY = this._workAreaBox.y1;
        const width = box.get_width();
        const height = box.get_height() - startY;
        const spacing = Math.round(height * 0.02);
        const p = this._stateAdjustment.getStateTransitionParams();
        const monitor = Main.layoutManager.primaryMonitor;
        const bottom = Math.min(startY + height, dockTop(monitor, startY + height) - spacing);

        // Search field: window view at the top (original); app view only after magnifier/active search, below the workspaces
        const [searchH] = this._searchEntry.get_preferred_height(width);
        const ws = this._cachedWorkspaceBoxes.get(APP_GRID);
        const appGridF = Math.max(0, Math.min(1, this._stateAdjustment.value - WINDOW_PICKER));
        const searching = searchShown || this._searchController.searchActive;
        const cb = new Clutter.ActorBox();
        // When searching, GNOME hides the workspaces: search field up, results above the keyboard
        // (otherwise the on-screen keyboard on the lower panel covers field and results, test 30.10. 23:47).
        // Laptop posture (keyboard at the top of the lower panel): search field and results onto the UPPER panel.
        const upMon = Main.layoutManager.monitors.find(mo => mo.index !== monitor.index);
        const searchUp = searching && globalThis.__duoKbTopMode?.() && upMon && upMon.y < monitor.y;
        const upOff = searchUp ? upMon.y - monitor.y : 0;   // negative offset in overview coordinates
        // The overview is clipped to the main panel (clip_to_allocation) -> lift that for the search at the top
        if (controls.clip_to_allocation === searchUp)
            controls.clip_to_allocation = !searchUp;
        // Workspaces of the upper panel lie above the overview -> hide them when searching at the top
        for (const v of this._workspacesDisplay?._workspacesViews ?? []) {
            if (v._monitorIndex !== undefined && v._monitorIndex !== monitor.index) {
                const op = searchUp ? 0 : 255;
                if (v.opacity !== op)
                    v.opacity = op;
            }
        }
        const entryY = searchUp ? upOff + spacing + 6
            : searching ? startY + spacing : Math.round(lerp(startY, ws.y2 + spacing, appGridF));
        cb.set_origin(0, entryY);
        cb.set_size(width, searchH);
        this._searchEntry.allocate(cb);
        // Search bar only while searching (magnifier or typing), in no other view
        this._searchEntry.opacity = searching ? 255 : 0;
        this._searchEntry.reactive = searching;
        // Move the window view's workspace bar to the top edge (GNOME puts it below the search bar)
        const th = this._workspacesThumbnails;
        if (!searching && th.visible && th.allocation.get_height() > 0) {
            const tb = th.allocation.copy();
            const ty = startY + Math.round(spacing * 0.6);
            tb.set_origin(tb.x1, ty);
            th.allocate(tb);
        }

        // Search results below the search field, down to the top edge of the on-screen keyboard (if open on this panel)
        const resY = entryY + searchH + spacing;
        let resBottom = searchUp ? upOff + upMon.height - EDGE - spacing : bottom;
        const kb = Main.layoutManager.keyboardBox;
        if (!searchUp && searching && kb?.visible && Main.keyboard?.visible) {
            const [, ky] = kb.get_transformed_position();
            const kyLocal = ky - monitor.y;
            if (kyLocal > resY + 40 && kyLocal < startY + height)
                resBottom = Math.min(resBottom, Math.round(kyLocal - spacing));
        }
        cb.set_origin(0, resY);
        cb.set_size(width, Math.max(40, resBottom - resY));
        this._searchController.allocate(cb);

        // Take GNOME's page grid out of the picture, our own tile list in its place
        const off = new Clutter.ActorBox();
        off.set_origin(0, startY + height + 2000);
        off.set_size(width, Math.max(40, bottom - resY));
        this._appDisplay.allocate(off);

        const listY = Math.round(ws.y2 + spacing + (searching ? searchH + spacing : 0));
        const appGrid = appGridF;
        // Never toggle visibility only after allocation (hidden actors get no allocation ->
        // flood of «needs an allocation» warnings, ~120 per opening). The list stays visible; it is hidden via opacity and
        // a position below the panel (no touch possible), also during search (the results lie beneath it).
        const away = searching ? 1 : 1 - appGrid;
        cb.set_origin(0, listY + Math.round(away * (startY + height + 40 - listY)));
        cb.set_size(width, Math.max(40, bottom - listY));
        scroll.allocate(cb);
        // Never rebuild rows during layout: on a changed column count, when idle
        if (!arrangePending && Math.max(1, Math.floor((width - 16) / TILE_W)) !== cols) {
            arrangePending = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                arrangePending = 0;
                arrange(width);
                return GLib.SOURCE_REMOVE;
            });
        }
        scroll.opacity = searching ? 0 : Math.round(255 * appGrid);
    };
    controls.queue_relayout();

    // Development probe (only with /etc/duo/shell-dev): $XDG_RUNTIME_DIR/duo-dev/ov-swipe -> a simulated finger swipes
    // up in the list; result (scroll value before/after, window count) to ov-info.txt.
    const devDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'duo-dev']);
    const devInfo = t => GLib.file_set_contents(`${devDir}/ov-info.txt`, t);
    const swipeTest = (dist, ms) => {
        const vd = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
        const [sx, sy] = scroll.get_transformed_position();
        const [sw, sh] = scroll.get_transformed_size();
        const onTile = dist < 0;
        const x = onTile ? sx + 60 : sx + sw / 2 + 40, y0 = onTile ? sy + 40 : sy + sh - 12;
        dist = Math.abs(dist);
        if (onTile)
            scroll.vadjustment.value = 0;
        const before = scroll.vadjustment.value, wins = global.get_window_actors().length;
        dbg.b = dbg.u = dbg.e = dbg.moved = 0;
        const hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y0);
        const N = 10;
        let i = 0;
        vd.notify_touch_down(GLib.get_monotonic_time(), 0, x, y0);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(ms / N), () => {
            i++;
            vd.notify_touch_motion(GLib.get_monotonic_time(), 0, x, y0 - i * dist / N);
            if (i < N)
                return GLib.SOURCE_CONTINUE;
            vd.notify_touch_up(GLib.get_monotonic_time(), 0);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                devInfo(`wisch ${dist}px/${ms}ms bei ${Math.round(x)},${Math.round(y0)}: scroll ${before} -> ` +
                    `${Math.round(scroll.vadjustment.value)} (max ${scroll.vadjustment.upper - scroll.vadjustment.page_size}), eingeklappt ${Math.round(collapse)}/${Math.round(wsFull / 2)}, ` +
                    `fenster ${wins} -> ${global.get_window_actors().length}, uebersicht ${Main.overview.visible}\n` +
                    `ereignisse ${JSON.stringify(dbg)} ziel ${hit?.constructor?.name} ${hit?.name ?? ''} ${hit?.style_class ?? ''}\n`);
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    };
    // Probe 2: "tap <App>" or "drag <App>" -> the finger taps the tile, or holds 500 ms and drags it onto
    // the second workspace (main panel). Result: new windows with workspace.
    const tileTest = (mode, name, ready = false) => {
        if (!ready) {   // list up, wait one frame, then measure the tile position
            scroll.vadjustment.value = 0;
            collapse = 0;
            controls.queue_relayout();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => { tileTest(mode, name, true); return GLib.SOURCE_REMOVE; });
            return;
        }
        if (mode === 'fling') {   // nudge a window (wm_class contains name) by its title bar towards the other panel
            const mw = global.get_window_actors().map(a => a.meta_window)
                .find(x => (x.get_wm_class() ?? '').toLowerCase().includes(name.toLowerCase()));
            if (!mw)
                return devInfo(`kein Fenster ${name}\n`);
            Main.overview.hide();
            const vdf = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
            const now = () => GLib.get_monotonic_time();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
                const r = mw.get_frame_rect();
                const mons = Main.layoutManager.monitors;
                const cur = mons[mw.get_monitor()];
                const other = mons.find(m => m !== cur);
                const dirY = other.y > cur.y ? 1 : -1;
                const x0 = r.x + r.width * 0.62, y0 = r.y + 14;
                const before = mw.get_monitor();
                vdf.notify_touch_down(now(), 0, x0, y0);
                let i = 0;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 12, () => {
                        i++;
                        vdf.notify_touch_motion(now(), 0, x0, y0 + dirY * 22 * i);
                        if (i < 9)
                            return GLib.SOURCE_CONTINUE;
                        // 150 ms of silence like the debounced driver, then release
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                            vdf.notify_touch_up(now(), 0);
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                                devInfo(`fling ${mw.get_wm_class()}: monitor ${before} -> ${mw.get_monitor()}\n`);
                                return GLib.SOURCE_REMOVE;
                            });
                            return GLib.SOURCE_REMOVE;
                        });
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'stress') {   // open the overview n times (app view) and close it, 1.2 s each
            const n = Number(name) || 20;
            let k = 0;
            const step = () => {
                if (k >= 2 * n) {
                    devInfo(`stress ${n}: fertig, uebersicht ${Main.overview.visible}, plus ${plusCards.size}, ` +
                        `kacheln ${tiles.length}, reihen ${view.get_n_children()}\n`);
                    return GLib.SOURCE_REMOVE;
                }
                if (k % 2 === 0)
                    Main.overview.showApps();
                else
                    Main.overview.hide();
                k++;
                return GLib.SOURCE_CONTINUE;
            };
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, step);
            return;
        }
        if (mode === 'plustap') {   // tap «+» on the main panel; measure the card state while closing
            const btn = wsActors().find(w => w._duoPlusBtn && w.monitorIndex === Main.layoutManager.primaryIndex)?._duoPlusBtn;
            if (!btn)
                return devInfo('kein Plus\n');
            const vdp = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
            const [bx, by] = btn.get_transformed_position();
            const [bw, bh] = btn.get_transformed_size();
            const lines = [];
            const snap = tag => {
                const cards = wsActors().filter(w => w._duoPlus)
                    .map(w => `m${w.monitorIndex}:karte ${w._duoPlus.opacity}/x${w._duoPlus.scale_x.toFixed(2)} hg ${w._background.opacity}`);
                lines.push(`${tag}: uebersicht ${Main.overview.visible} aktiv ${global.workspace_manager.get_active_workspace_index()} ` +
                    `[${cards.join('; ')}]`);
            };
            vdp.notify_touch_down(GLib.get_monotonic_time(), 0, bx + bw / 2, by + bh / 2);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                vdp.notify_touch_up(GLib.get_monotonic_time(), 0);
                for (const ms of [60, 140, 300, 1200]) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                        snap(`+${ms}ms`);
                        if (ms === 1200)
                            devInfo(`${lines.join('\n')}\n`);
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        // Tap at point (x,y) with a virtual finger, then report
        const tapAt = (x, y, tag, after = 1500) => {
            const vt = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
            const hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            vt.notify_touch_down(GLib.get_monotonic_time(), 0, x, y);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                vt.notify_touch_up(GLib.get_monotonic_time(), 0);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, after, () => {
                    const fw = global.display.focus_window;
                    devInfo(`${tag}: getroffen ${hit?.constructor?.name} ${hit?.name ?? ''}, uebersicht ${Main.overview.visible}, ` +
                        `zustand ${controls._stateAdjustment.value.toFixed(2)}, fokus ${fw?.get_wm_class()}@ws${fw?.get_workspace()?.index()}, ` +
                        `aktiv ${global.workspace_manager.get_active_workspace_index()}, suche ${controls._searchController.searchActive}\n`);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
        };
        const centerOfA = a => { const [ax, ay] = a.get_transformed_position(); const [aw, ah] = a.get_transformed_size();
            return [ax + aw / 2, ay + ah / 2]; };
        if (mode === 'wintap') {
            const pv = wsActors().flatMap(w => w._windows)
                .find(p => (p.metaWindow?.get_wm_class() ?? '').toLowerCase().includes(name.toLowerCase()));
            if (!pv)
                return devInfo('wintap: keine Vorschau\n');
            const [x, y] = centerOfA(pv);
            return tapAt(x, y, `wintap ${name}`);
        }
        if (mode === 'streifentipp') {   // «streifentipp <monitor> <x-Versatz>»: short tap in the gesture strip
            const [mS, dxS] = name.split(' ');
            const m = Main.layoutManager.monitors[Number(mS)];
            const fw0 = global.display.focus_window;
            const x = m.x + m.width / 2 + Number(dxS || 0), y = m.y + m.height - 23;
            const below = pickBelowStrip(x, y);
            const vt = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
            vt.notify_touch_down(GLib.get_monotonic_time(), 0, x, y);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, () => {
                vt.notify_touch_up(GLib.get_monotonic_time(), 0);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                    const fw = global.display.focus_window;
                    devInfo(`streifentipp m${mS}: darunter ${below?.constructor?.name}, fokus vorher ${fw0?.get_wm_class()} ` +
                        `nachher ${fw?.get_wm_class()}@m${fw?.get_monitor()}, streifen sichtbar ${strips.map(st => st.visible).join('/')}, ` +
                        `uebersicht ${Main.overview.visible}\n`);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'osk') {   // «osk a b lang:a neben lang:e sub:é ...»: on-screen keyboard with a virtual finger
            const steps = name.split(' ').filter(Boolean);
            openSearch();
            entry.set_text('');
            const vo = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
            const now = () => GLib.get_monotonic_time();
            const findLabel = (a, lab) => {
                if (!a)
                    return null;
                if (a.keyButton && a.keyButton.mapped && a.keyButton.label === lab)
                    return a.keyButton;
                if (a.extendedKey === lab && a.mapped)
                    return a;
                for (const c of a.get_children?.() ?? []) {
                    const f = findLabel(c, lab);
                    if (f)
                        return f;
                }
                return null;
            };
            const log2 = [];
            let i = 0;
            const next = () => {
                if (i >= steps.length) {
                    const kb = Main.keyboard?._keyboard;
                    devInfo(`osk: ${log2.join(' | ')} || tastatur ${kb ? `${Math.round(kb.width)}x${Math.round(kb.height)}` : '-'}\n`);
                    return;
                }
                const st = steps[i++];
                let lab = st, hold = 70;
                if (st.startsWith('lang:')) {
                    lab = st.slice(5);
                    hold = 800;
                } else if (st.startsWith('sub:')) {
                    lab = st.slice(4);
                }
                let x, y;
                if (st === 'neben') {
                    const m = Main.layoutManager.primaryMonitor;
                    x = m.x + 20;
                    y = m.y + 60;
                } else {
                    const btn = findLabel(st.startsWith('sub:') ? global.stage : Main.keyboard?._keyboard, lab);
                    if (!btn) {
                        log2.push(`${st}: nicht gefunden`);
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { next(); return GLib.SOURCE_REMOVE; });
                        return;
                    }
                    [x, y] = centerOfA(btn);
                }
                vo.notify_touch_down(now(), 0, x, y);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, hold, () => {
                    vo.notify_touch_up(now(), 0);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                        log2.push(`${st} -> «${entry.get_text()}»`);
                        next();
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
            };
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => { next(); return GLib.SOURCE_REMOVE; });
            return;
        }
        if (mode === 'loeschtest') {   // test the delete paths in isolation: set text, then delete one character per path
            openSearch();
            const res = [];
            const vk = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                entry.set_text('abcd');
                entry.clutter_text.set_cursor_position(-1);
                const im = Main.inputMethod;
                res.push(`start «${entry.get_text()}» imFokus ${!!im.currentFocus} fokusIstFeld ${global.stage.key_focus === entry.clutter_text}`);
                im.delete_surrounding(-1, 1);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    res.push(`delete_surrounding «${entry.get_text()}»`);
                    const t = GLib.get_monotonic_time();
                    vk.notify_keyval(t, Clutter.KEY_BackSpace, Clutter.KeyState.PRESSED);
                    vk.notify_keyval(t + 1000, Clutter.KEY_BackSpace, Clutter.KeyState.RELEASED);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                        res.push(`virtuelle Ruecktaste «${entry.get_text()}»`);
                        const c = Main.keyboard?._keyboard?._keyboardController;
                        c?.toggleDelete(true);
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                            c?.toggleDelete(false);
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                                res.push(`toggleDelete mit Pause «${entry.get_text()}»`);
                                devInfo(`loeschtest: ${res.join(' | ')}\n`);
                                return GLib.SOURCE_REMOVE;
                            });
                            return GLib.SOURCE_REMOVE;
                        });
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'fensternach') {   // «fensternach <n> <monitor>»: n-th window onto a monitor (test helper)
            const [n, m] = name.split(' ').map(Number);
            const w = global.display.list_all_windows().filter(x => x.get_window_type() === 0)[n];
            w?.move_to_monitor(m);
            devInfo(`fensternach ${n} -> ${m}: ${!!w}\n`);
            return;
        }
        if (mode === 'fenster') {   // per window: class, monitor, frame, maximised
            const out = global.display.list_all_windows().filter(w => w.get_window_type() === 0).map(w => {
                const r = w.get_frame_rect();
                return `#${w.get_id() % 1000} ${w.get_wm_class()} m${w.get_monitor()} ${r.x},${r.y} ${r.width}x${r.height} max${w.get_maximized()} ws${w.get_workspace()?.index()}`;
            });
            devInfo(`fenster: ${out.join(' | ')} || monitore ${Main.layoutManager.monitors.map(m => `${m.index}:${m.x},${m.y} ${m.width}x${m.height}`).join(' ')} primaer ${Main.layoutManager.primaryIndex}\n`);
            return;
        }
        if (mode === 'sperre') {   // «sperre an|aus»: lock screen for testing (aus = without password, development only)
            if (name === 'an')
                Main.screenShield.lock(false);
            else
                Main.screenShield.deactivate(false);
            devInfo(`sperre ${name}\n`);
            return;
        }
        if (mode === 'kbtasten') {   // key rectangles of the current page (screen coordinates)
            const out = [];
            const walk = a => {
                for (const c of a.get_children()) {
                    if (c.has_style_class_name?.('keyboard-key') && c.mapped) {
                        const [x, y] = c.get_transformed_position();
                        const [w, h] = c.get_transformed_size();
                        out.push(`${c.label ?? '?'}:${Math.round(x)},${Math.round(y)} ${Math.round(w)}x${Math.round(h)}`);
                    } else {
                        walk(c);
                    }
                }
            };
            const pg = Main.keyboard?._keyboard?._currentPage;
            if (pg)
                walk(pg);
            devInfo(`kbtasten: ${out.join(' | ')}\n`);
            return;
        }
        if (mode === 'kbzustand') {   // Why does the keyboard not appear? State of the chain
            const km = Main.keyboard, im = Main.inputMethod;
            const seat = Clutter.get_default_backend().get_default_seat();
            const dev = km._lastDevice;
            devInfo(`kbzustand: tastatur ${!!km._keyboard} sichtbar ${km.visible} touchmodus ${seat.get_touch_mode()} ` +
                `letztesGeraet ${dev?.get_device_name?.()}/${dev?.get_device_type?.()} imFokus ${!!im.currentFocus} ` +
                `imPurpose ${im._purpose} panelSichtbar ${im._inputPanelVisible ?? '?'} fokusFenster ${global.display.focus_window?.get_wm_class?.()} ` +
                `keyFokus ${global.stage.key_focus?.constructor?.name} showKb ${km._a11yApplicationsSettings?.get_boolean('screen-keyboard-enabled')}\n`);
            return;
        }
        if (mode === 'tipp') {   // «tipp x y»: tap at a screen coordinate (logical)
            const [xs, ys] = name.split(' ').map(Number);
            return tapAt(xs, ys, `tipp ${xs},${ys}`);
        }
        if (mode === 'balken') {   // short tap on the gesture bar of the main panel (off centre)
            const m = Main.layoutManager.primaryMonitor;
            return tapAt(m.x + 40, m.y + m.height - 16, 'balken');
        }
        if (mode === 'leer') {   // free spot at the bottom of the main panel (below the tiles)
            const m = Main.layoutManager.primaryMonitor;
            return tapAt(m.x + m.width - 20, m.y + m.height - 20, 'leer');
        }
        if (mode === 'obenplus') {
            const w = wsActors().find(x => x._duoPlusBtn && x.monitorIndex !== Main.layoutManager.primaryIndex);
            if (!w)
                return devInfo('obenplus: keins\n');
            const [x, y] = centerOfA(w._duoPlusBtn);
            return tapAt(x, y, 'obenplus');
        }
        if (mode === 'suche') {   // open the magnifier, type text, report the result
            openSearch();
            const vk = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            let i = 0;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                    const ch = name.codePointAt(i);
                    const kv = imports.gi.Clutter.unicode_to_keysym(ch);
                    const t = GLib.get_monotonic_time();
                    vk.notify_keyval(t, kv, Clutter.KeyState.PRESSED);
                    vk.notify_keyval(t + 1000, kv, Clutter.KeyState.RELEASED);
                    i++;
                    if (i < name.length)
                        return GLib.SOURCE_CONTINUE;
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                        const [lx, ly] = scroll.get_transformed_position();
                        devInfo(`suche «${entry.get_text()}»: aktiv ${controls._searchController.searchActive}, ` +
                            `ergebnisse sichtbar ${controls._searchController.visible} op ${controls._searchController.opacity}, ` +
                            `liste op ${scroll.opacity} y ${Math.round(ly)}\n`);
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'suchezu') {
            closeSearch();
            return GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                devInfo(`suchezu: text «${entry.get_text()}» aktiv ${controls._searchController.searchActive} liste op ${scroll.opacity}\n`);
                return GLib.SOURCE_REMOVE;
            });
        }
        if (mode === 'groesse') {   // maximise/restore a window (wm_class contains name) 6x, 700 ms each
            const mw = normalWindows().find(m => (m.get_wm_class() ?? '').toLowerCase().includes(name.toLowerCase()));
            if (!mw)
                return devInfo('groesse: kein Fenster\n');
            let k = 0;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                if (mw.get_maximized())
                    mw.unmaximize(3);
                else
                    mw.maximize(3);
                k++;
                if (k < 6)
                    return GLib.SOURCE_CONTINUE;
                devInfo(`groesse ${mw.get_wm_class()}: 6x umgeschaltet\n`);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'groessen') {   // send a window through 6 different sizes (900 ms each)
            const mw = normalWindows().find(m => (m.get_wm_class() ?? '').toLowerCase().includes(name.toLowerCase()));
            if (!mw)
                return devInfo('groessen: kein Fenster\n');
            if (mw.get_maximized())
                mw.unmaximize(3);
            const wa = Main.layoutManager.getWorkAreaForMonitor(mw.get_monitor());
            const sizes = [[360, 300], [420, 340], [480, 380], [540, 400], [380, 420], [600, 360]];
            let k = 0;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
                const [w, h] = sizes[k];
                mw.move_resize_frame(true, wa.x + 10, wa.y + 10, Math.min(w, wa.width - 20), Math.min(h, wa.height - 20));
                k++;
                if (k < sizes.length)
                    return GLib.SOURCE_CONTINUE;
                devInfo(`groessen ${mw.get_wm_class()}: 6 Groessen\n`);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'randwisch') {   // «randwisch <monitor> <px> <ms> [halten]»: swipe up from the bottom edge
            const [mS, dS, msS, hold, xS] = name.split(' ');
            const m = Main.layoutManager.monitors[Number(mS)];
            const holdOn = hold === 'halten';
            const dist = Number(dS), dur = Number(msS);
            const vr = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
            const x = xS ? Number(xS) : m.x + m.width / 2, y0 = m.y + m.height - 23;   // like the real finger (lowest reportable row)
            const now = () => GLib.get_monotonic_time();
            const N = 20;
            let i = 0;
            vr.notify_touch_down(now(), 0, x, y0);
            const states = [];
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(8, Math.round(dur / N)), () => {
                i++;
                vr.notify_touch_motion(now(), 0, x, y0 - dist * i / N);
                if (i === N / 2)
                    states.push(`mitte ${progNow().toFixed(2)}`);
                if (i < N)
                    return GLib.SOURCE_CONTINUE;
                states.push(`vor loslassen ${progNow().toFixed(2)}`);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, holdOn ? 1500 : 20, () => {
                    vr.notify_touch_up(now(), 0);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
                        const wins = normalWindows().map(w => { const r = w.get_frame_rect(); return `${w.get_wm_class()} ${r.x},${r.y} ${r.width}x${r.height} max ${w.get_maximized()}`; });
                        devInfo(`randwisch m${mS} ${dist}px/${dur}ms${holdOn ? ' halten' : ''}: ${states.join(', ')}, ` +
                            `danach ${progNow().toFixed(2)} sichtbar ${Main.overview.visible} | ${wins.join(' ; ')}\n`);
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'docktap') {   // «docktap <App> <monitor>»: tap the dock icon on a monitor, report the new window
            const [appName, monStr] = name.split(' ');
            const monI = Number(monStr);
            const mons = Main.layoutManager.monitors;
            const found = [];
            const walk = a => {
                for (const c of a.get_children()) {
                    const app = c._delegate?.app ?? c.app;
                    if (app && app.get_name().toLowerCase().includes(appName.toLowerCase()) && c.mapped)
                        found.push(c);
                    walk(c);
                }
            };
            for (const a of Main.layoutManager.uiGroup.get_children()) {
                if (a.name === 'dashtodockContainer')
                    walk(a);
            }
            const target = found.find(c => {
                const [x, y] = c.get_transformed_position();
                const m = mons[monI];
                return x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height;
            });
            if (!target)
                return devInfo(`docktap: kein ${appName} im Dock auf Monitor ${monI} (gefunden ${found.length})\n`);
            const before = new Set(normalWindows().map(m => m.get_id()));
            let [x, y] = centerOfA(target);
            if (name.includes('unten'))   // tap in the gesture strip (23 px above the edge, like the real finger)
                y = mons[monI].y + mons[monI].height - 23;
            tapAt(x, y, 'docktap', 100);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                const neu = normalWindows().filter(m => !before.has(m.get_id()))
                    .map(m => `${m.get_wm_class()} pid=${m.get_pid()} m${m.get_monitor()}`);
                devInfo(`docktap ${appName} auf Monitor ${monI}: neue Fenster [${neu.join('; ')}]\n`);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'zustand') {   // report all workspace actors and their previews
            const lines = [];
            for (const w of wsActors()) {
                const pv = w._windows.map(p => {
                    const r = p.metaWindow?.get_frame_rect();
                    const [px, py] = p.get_transformed_position();
                    const wa = p.metaWindow?.get_compositor_private();
                    return `${p.metaWindow?.get_wm_class()}[vis ${p.visible} op ${p.opacity} mapped ${p.mapped} inDrag ${p.inDrag} ` +
                        `min ${p.metaWindow?.minimized} ${Math.round(p.width)}x${Math.round(p.height)} @${Math.round(px)},${Math.round(py)} ` +
                        `rahmen ${r?.x},${r?.y} ${r?.width}x${r?.height} aktor vis ${wa?.visible} op ${wa?.opacity}]`;
                });
                lines.push(`m${w.monitorIndex} ws${w.metaWorkspace?.index()} plus ${!!w._duoPlus} vis ${w.visible} op ${w.opacity}: ${pv.join(' ')}`);
            }
            devInfo(`${lines.join('\n')}\n`);
            return;
        }
        if (mode === 'fensterinfo') {   // details on windows whose wm_class contains name
            const out = normalWindows().filter(m => (m.get_wm_class() ?? '').toLowerCase().includes(name.toLowerCase()))
                .map(m => `${m.get_wm_class()} titel «${m.get_title()}» pid ${m.get_pid()} hidden ${m.is_hidden()} ` +
                    `showing ${m.showing_on_its_workspace()} wayland ${m.get_client_type()} skip ${m.is_skip_taskbar()} ` +
                    `focus ${m.has_focus()} benutzerzeit ${m.get_user_time()} sandbox ${m.get_sandboxed_app_id?.()}`);
            devInfo(`${out.join('\n')}\n`);
            return;
        }
        if (mode === 'foto') {   // screenshot without opening anything -> ov.png
            const Gio = imports.gi.Gio;
            const stream = Gio.File.new_for_path(`${devDir}/ov.png`).replace(null, false, Gio.FileCreateFlags.NONE, null);
            new Shell.Screenshot().screenshot(false, stream).then(() => {
                stream.close(null);
                devInfo(`foto: uebersicht ${Main.overview.visible}, zustand ${controls._stateAdjustment.value}, ` +
                    `fenster ${normalWindows().map(m => `${m.get_wm_class()}@ws${m.get_workspace()?.index()}/m${m.get_monitor()}`).join(' ')}, ` +
                    `arbeitsflaechen ${global.workspace_manager.n_workspaces} aktiv ${global.workspace_manager.get_active_workspace_index()}\n`);
            }).catch(err => devInfo(`FEHLER ${err}\n`));
            return;
        }
        if (mode === 'fensterfoto') {   // open the window view and photograph it -> ov.png
            Main.overview.show();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                const Gio = imports.gi.Gio;
                const file = Gio.File.new_for_path(`${devDir}/ov.png`);
                const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                new Shell.Screenshot().screenshot(false, stream).then(() => {
                    stream.close(null);
                    const e = controls._searchEntry;
                    const [ex, ey] = e.get_transformed_position();
                    devInfo(`fensterfoto: suchleiste ${e.constructor.name} deckkraft ${e.opacity} sichtbar ${e.visible} bei ${Math.round(ex)},${Math.round(ey)}, ` +
                        `suche aktiv ${controls._searchController.searchActive}, lupe ${searchShown}, zustand ${controls._stateAdjustment.value}\n`);
                }).catch(err => devInfo(`FEHLER ${err}\n`));
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'dock') {   // dock state
            const out = Main.layoutManager.uiGroup.get_children().filter(a => a.name === 'dashtodockContainer').map(a => {
                const [x, y] = a.get_transformed_position();
                return `vis ${a.visible} op ${a.opacity} ty ${a.translation_y} @${Math.round(x)},${Math.round(y)} ${Math.round(a.width)}x${Math.round(a.height)} mapped ${a.mapped}`;
            });
            const wa = Main.layoutManager.monitors.map(m => { const r = Main.layoutManager.getWorkAreaForMonitor(m.index); return `m${m.index} ${r.x},${r.y} ${r.width}x${r.height}`; });
            devInfo(`dock: ${out.join(' | ')} || arbeitsbereich ${wa.join(' ; ')}\n`);
            return;
        }
        if (mode === 'zu') {   // close the overview, then report the dock state
            Main.overview.hide();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                devInfo(`zu: uebersicht ${Main.overview.visible}, docks ${docks().map(a => `${a.visible}/${a.opacity}`).join(' ')}\n`);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'windrag') {   // drag a window preview (wm_class contains name) onto «+» on the main panel
            const prim = Main.layoutManager.primaryIndex;
            let prev = null;
            for (const w of wsActors()) {
                if (w.monitorIndex !== prim)
                    continue;
                prev = prev ?? w._windows.find(pv => (pv.metaWindow?.get_wm_class() ?? '').toLowerCase().includes(name.split(' ')[0].toLowerCase()));
            }
            const wsN = name.match(/ws(\d)/);
            const target = wsN
                ? wsActors().find(w => w.monitorIndex === prim && w.metaWorkspace?.index() === Number(wsN[1]))
                : wsActors().find(w => w._duoPlusBtn && w.monitorIndex === prim)?._duoPlusBtn;
            if (!prev || !target)
                return devInfo(`windrag: vorschau ${!!prev} plus ${!!target}\n`);
            const mw = prev.metaWindow;
            const before = `ws${mw.get_workspace().index()}/m${mw.get_monitor()}`;
            const hit0 = (() => { const [px, py] = prev.get_transformed_position(); const [pw, ph] = prev.get_transformed_size();
                return [px + pw / 2, py + ph / 2]; })();
            const hitActor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, hit0[0], hit0[1]);
            const [tx, ty] = target.get_transformed_position();
            const [tw, th] = target.get_transformed_size();
            const x1 = tx + tw / 2, y1 = ty + th / 2;
            const holdFirst = /halten/.test(name);
            const vdw = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
            const now = () => GLib.get_monotonic_time();
            let began = false;
            const bId = Main.overview.connect('window-drag-begin', () => { began = true; });
            vdw.notify_touch_down(now(), 0, hit0[0], hit0[1]);
            let i = 0;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, holdFirst ? 700 : 120, () => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
                    i++;
                    vdw.notify_touch_motion(now(), 0, hit0[0] + (x1 - hit0[0]) * i / 20, hit0[1] + (y1 - hit0[1]) * i / 20);
                    if (i < 20)
                        return GLib.SOURCE_CONTINUE;
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                        vdw.notify_touch_up(now(), 0);
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                            Main.overview.disconnect(bId);
                            devInfo(`windrag ${mw.get_wm_class()}: ${before} -> ws${mw.get_workspace()?.index()}/m${mw.get_monitor()}, ` +
                                `ziehen begonnen ${began}, getroffen ${hitActor?.constructor?.name} ${hitActor?.name ?? ''}, ` +
                                `arbeitsflaechen ${global.workspace_manager.n_workspaces}, ws0 hat ` +
                                `${global.workspace_manager.get_workspace_by_index(0).list_windows().map(m => m.get_wm_class()).join('+')}\n`);
                            return GLib.SOURCE_REMOVE;
                        });
                        return GLib.SOURCE_REMOVE;
                    });
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'allezu') {   // tap «Close all» once (only test the arming) and report the state
            const btn = wsActors().find(w => w._duoCloseAll)?._duoCloseAll;
            if (!btn)
                return devInfo('kein Alle-schliessen\n');
            const vda = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
            const [ax, ay] = btn.get_transformed_position();
            const [aw, ah] = btn.get_transformed_size();
            vda.notify_touch_down(GLib.get_monotonic_time(), 0, ax + aw / 2, ay + ah / 2);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                vda.notify_touch_up(GLib.get_monotonic_time(), 0);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    devInfo(`allezu: beschriftung «${btn.child.text}», fenster ${normalWindows().map(m => m.get_wm_class()).join(', ')}\n`);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (mode === 'lupe') {   // tap the magnifier
            const lupe = wsActors().find(w => w._duoLupe)?._duoLupe;
            if (!lupe)
                return devInfo('keine Lupe\n');
            const vdl = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
            const [lx, ly] = lupe.get_transformed_position();
            const [lw, lh] = lupe.get_transformed_size();
            vdl.notify_touch_down(GLib.get_monotonic_time(), 0, lx + lw / 2, ly + lh / 2);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
                vdl.notify_touch_up(GLib.get_monotonic_time(), 0);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                    devInfo(`lupe: suchfeld sichtbar ${searchShown}, fokus ${global.stage.key_focus?.constructor?.name}\n`);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        const tile = tiles.find(t => t.app.get_name() === name);
        if (!tile)
            return devInfo(`keine Kachel ${name}\n`);
        const vd = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
        const [tx, ty] = tile.get_transformed_position();
        const [tw, th] = tile.get_transformed_size();
        const x0 = tx + tw / 2, y0 = ty + th / 3;
        const before = new Set(global.get_window_actors().map(a => a.meta_window.get_id()));
        const report = () => {
            const neu = global.get_window_actors().map(a => a.meta_window)
                .filter(w => !before.has(w.get_id()))
                .map(w => `${w.get_wm_class()} pid=${w.get_pid()} ws=${w.get_workspace()?.index()} mon=${w.get_monitor()}`);
            devInfo(`${mode} ${name}: neue Fenster [${neu.join('; ')}], uebersicht ${Main.overview.visible}, ` +
                `menue ${tile._menu?.isOpen ?? false} (${lastMenu}), arbeitsflaechen ${global.workspace_manager.n_workspaces}, plus ${plusCards.size}\n`);
        };
        const now = () => GLib.get_monotonic_time();
        const later = (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { fn(); return GLib.SOURCE_REMOVE; });
        const finish = () => later(3500, report);
        const scrollBefore = scroll.vadjustment.value;
        // Movement in steps: from (xa,ya) to (xb,yb), n steps at interval dt
        const move = (xa, ya, xb, yb, n, dt, done) => {
            let i = 0;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, dt, () => {
                i++;
                vd.notify_touch_motion(now(), 0, xa + (xb - xa) * i / n, ya + (yb - ya) * i / n);
                if (i < n)
                    return GLib.SOURCE_CONTINUE;
                done();
                return GLib.SOURCE_REMOVE;
            });
        };
        const centerOf = actor => {
            const [ax, ay] = actor.get_transformed_position();
            const [aw, ah] = actor.get_transformed_size();
            return [ax + aw / 2, ay + ah / 2];
        };
        const primaryWs = () => {
            const v = controls._workspacesDisplay._workspacesViews[Main.layoutManager.primaryIndex];
            return v?._workspaces ?? [];
        };
        vd.notify_touch_down(now(), 0, x0, y0);
        if (mode === 'tap') {
            later(80, () => { vd.notify_touch_up(now(), 0); finish(); });
        } else if (mode === 'hold') {
            later(800, () => { vd.notify_touch_up(now(), 0); later(600, report); });
        } else if (mode === 'slow') {
            // slow: 60 px upwards in 1.5 s, starting on the tile
            move(x0, y0, x0, y0 - 60, 30, 50, () => {
                vd.notify_touch_up(now(), 0);
                later(1500, () => {
                    devInfo(`slow ${name}: scroll ${Math.round(scrollBefore)} -> ${Math.round(scroll.vadjustment.value)}, ` +
                        `fenster unveraendert ${global.get_window_actors().length}, menue ${tile._menu?.isOpen ?? false}, ` +
                        `uebersicht ${Main.overview.visible}\n`);
                });
            });
        } else {
            // drag: onto the first workspace, plus: onto the «+» card
            const wsl = primaryWs();
            const target = mode === 'plus' || mode === 'zplus' ? wsl.find(w => w._duoPlusBtn)?._duoPlusBtn
                : mode === 'drag1' ? wsl[1] : wsl[0];
            if (mode === 'zplus') {   // trembling finger: while holding, up to 8 px off every 30 ms
                let k = 0;
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                    k++;
                    vd.notify_touch_motion(now(), 0, x0 + (k % 2 ? 8 : -6), y0 + (k % 3 ? 5 : -7));
                    return k < 18 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
                });
            }
            if (!target) {
                vd.notify_touch_up(now(), 0);
                return devInfo(`kein Ziel fuer ${mode}\n`);
            }
            const [x1, y1] = centerOf(target);
            later(600, () => move(x0, y0, x1, y1, 20, 20, () => later(300, () => {
                vd.notify_touch_up(now(), 0);
                finish();
            })));
        }
    };
    let devTimer = 0;
    if (GLib.file_test('/etc/duo/shell-dev', GLib.FileTest.EXISTS)) {
        failUndo.push(() => { if (devTimer) GLib.source_remove(devTimer); });
        devTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            const ft = `${devDir}/ov-tile`;
            if (GLib.file_test(ft, GLib.FileTest.EXISTS)) {
                const [, tb] = GLib.file_get_contents(ft);
                const [mode, ...rest] = new TextDecoder().decode(tb).trim().split(/\s+/);
                GLib.unlink(ft);
                try {
                    tileTest(mode, rest.join(' '));
                } catch (e) {
                    devInfo(`FEHLER ${e}\n${e.stack}`);
                }
            }
            // ov-eval: run a JS probe from ov-eval.js (development only, /etc/duo/shell-dev), result to ov-info.txt
            if (GLib.file_test(`${devDir}/ov-eval.js`, GLib.FileTest.EXISTS)) {
                try {
                    const [, eb] = GLib.file_get_contents(`${devDir}/ov-eval.js`);
                    GLib.unlink(`${devDir}/ov-eval.js`);
                    const res = new Function('Main', 'global', 'Meta', 'GLib', new TextDecoder().decode(eb))(Main, global, imports.gi.Meta, GLib);
                    devInfo(`${res}\n`);
                } catch (e) {
                    devInfo(`FEHLER ${e}\n${e.stack}`);
                }
            }
            // ov-win: all windows (type, frame, monitor, maximisable) + the keyboard's input focus to ov-info.txt
            if (GLib.file_test(`${devDir}/ov-win`, GLib.FileTest.EXISTS)) {
                GLib.unlink(`${devDir}/ov-win`);
                try {
                    const lines = global.get_window_actors().map(a => {
                        const w = a.meta_window, r = w.get_frame_rect(), b = w.get_buffer_rect();
                        return `${w.get_wm_class()} «${w.get_title()}» typ=${w.get_client_type() ? 'x11' : 'wayland'} dekor=${w.decorated} ` +
                            `rahmen=${r.x},${r.y} ${r.width}x${r.height} puffer=${b.width}x${b.height} mon=${w.get_monitor()} ` +
                            `max=${w.can_maximize()} groesse=${w.allows_resize()} maxh=${w.maximized_horizontally} maxv=${w.maximized_vertically}`;
                    });
                    const mons = Main.layoutManager.monitors.map(m => `mon${m.index} ${m.x},${m.y} ${m.width}x${m.height} s${m.geometry_scale}`);
                    const im = Main.inputMethod;
                    lines.push(...mons, `im: fokus=${!!im?._currentFocus} hints=${im?._hints} purpose=${im?._purpose} ` +
                        `osk=${Main.keyboard?._keyboardVisible ?? Main.keyboard?.visible}`);
                    devInfo(`${lines.join('\n')}\n`);
                } catch (e) {
                    devInfo(`FEHLER ${e}\n${e.stack}`);
                }
            }
            const f = `${devDir}/ov-swipe`;
            if (GLib.file_test(f, GLib.FileTest.EXISTS)) {
                const [, b] = GLib.file_get_contents(f);
                const [dist, ms] = new TextDecoder().decode(b).trim().split(/\s+/).map(Number);
                GLib.unlink(f);
                try {
                    swipeTest(dist || 100, ms || 120);
                } catch (e) {
                    devInfo(`FEHLER ${e}\n${e.stack}`);
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---- Windows stay on their panel (the owner'ss wish 31.10.) ----
    // Solved in Mutter (bau-mutter-42.sh «duo-id»: connector in the logical monitor id; both panels report the same
    // EDID). The earlier retrieval here (move_to_monitor around monitors-changed) coincided with three SIGSEGVs of the shell
    // and has been removed.

    return {
        scroll, view,
        uninstall() {
            if (this._done)   // tearing down more than once is harmless
                return;
            this._done = true;
            // all signals connected via on() (overview, stage, display, layout, keyboard, app system)
            for (const f of undo.splice(0).reverse()) {
                try {
                    f();
                } catch (err) {
                    log(`duo-osk: Abbau: ${err}`);
                }
            }
            GLib.source_remove(dockLiftTimer);
            for (const a of Main.layoutManager.uiGroup.get_children()) {
                if (a.name === 'dashtodockContainer')
                    a.translation_y = -a.height;
            }
            for (const st of strips.splice(0))
                st.destroy();
            if (edgeWatch)
                GLib.source_remove(edgeWatch);
            if (wsProto)
                wsProto.acceptDrop = origWsAccept;
            ov.show = origShow;
            if (arrangePending)
                GLib.source_remove(arrangePending);
            stopKinetic();
            stopPlus();
            if (plusIdle)
                GLib.source_remove(plusIdle);
            layout._searchEntry.opacity = 255;   // the frame (Bin) that the layout hides
            controls.clip_to_allocation = true;
            layout._searchEntry.reactive = true;
            for (const w of [...plusCards])
                dropPlus(w);
            dockIn();
            if (devTimer)
                GLib.source_remove(devTimer);
            proto.vfunc_allocate = orig.alloc;
            proto._computeWorkspacesBoxForState = orig.ws;
            scroll.destroy();
            controls.queue_relayout();
        },
    };
}

// Login and lock screen in laptop posture: user list/password field onto the UPPER panel, the keyboard sits at the top
// of the lower one (duoKeyboard). the owner'ss wish 31.10.: otherwise the keyboard lies over the field while typing the password.
// The dialog (gdm: LoginDialog, lock: UnlockDialog) hangs on a MonitorConstraint {primary}; that one is switched over.
function installAuthPlacement(d, undo, on) {
    const {Main, GLib} = d;
    const lm = Main.layoutManager;
    const findConstraint = () => {
        const dlg = Main.screenShield?._dialog;
        if (!dlg)
            return null;
        const queue = [[dlg, 0]];
        while (queue.length) {
            const [a, depth] = queue.shift();
            const c = a.get_constraints?.().find(k => 'primary' in k && 'index' in k);
            if (c)
                return c;
            if (depth < 3)
                for (const ch of a.get_children?.() ?? [])
                    queue.push([ch, depth + 1]);
        }
        return null;
    };
    const touched = new Set();
    const sync = () => {
        const constraint = findConstraint();
        if (!constraint)
            return false;
        const up = globalThis.__duoKbTopMode?.()
            ? lm.monitors.reduce((m1, m2) => (m2.y < m1.y ? m2 : m1), lm.monitors[0]) : null;
        if (up) {
            constraint.primary = false;
            constraint.index = up.index;
        } else {
            constraint.primary = true;
        }
        if (!touched.has(constraint))
            log(`duo-osk: Anmeldung/Sperre auf ${up ? `Monitor ${up.index} (oben)` : 'Hauptmonitor'}`);
        touched.add(constraint);
        return true;
    };
    let poll = 0;
    const startPoll = () => {
        if (poll)
            return;
        let tries = 0;
        poll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            if (sync() || ++tries > 20) {
                poll = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    };
    on(lm, 'monitors-changed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        sync();
        return GLib.SOURCE_REMOVE;
    }));
    if (Main.screenShield) {
        on(Main.screenShield, 'active-changed', startPoll);
        on(Main.screenShield, 'locked-changed', startPoll);
    }
    startPoll();
    undo.push(() => {
        if (poll)
            GLib.source_remove(poll);
        for (const c of touched)
            c.primary = true;
    });
}

function installGreeter(d, undo, on) {
    const {GLib, Shell} = d;
    installAuthPlacement(d, undo, on);
    // Development: a photo after every load (the greeter has no overview for ov-shot)
    if (GLib.file_test('/etc/duo/shell-dev', GLib.FileTest.EXISTS)) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            const dir = `${GLib.get_user_runtime_dir()}/duo-dev`;
            if (GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
                const file = imports.gi.Gio.File.new_for_path(`${dir}/ov.png`);
                const stream = file.replace(null, false, imports.gi.Gio.FileCreateFlags.NONE, null);
                new Shell.Screenshot().screenshot(false, stream).then(() => stream.close(null))
                    .catch(e => log(`duo-osk: Foto ${e}`));
            }
            return GLib.SOURCE_REMOVE;
        });
    }
    return {
        uninstall() {
            for (const f of undo.splice(0).reverse())
                f();
        },
    };
}
