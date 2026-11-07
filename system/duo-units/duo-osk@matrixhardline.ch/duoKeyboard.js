// Duo keyboard following the research «Duo keyboard design and typing feel» (31.10.2026), in the report's order:
//  1. Write on TOUCH-DOWN (the driver delays every release by 150 ms; GNOME only wrote on release and
//     opened the variants menu after 250 ms -> a normal tap became a long press). Long press now HOLD_MS from
//     touch-down; the already written character is replaced by the variant, without a choice it comes back.
//  2. Height in millimetres: rows ~57-60 lp (10 mm) instead of a fraction of the monitor height.
//  3. Feedback on touch-down: vibration tick (duo-haptik, /run/duo/haptik.sock) + click sound (MetaSoundPlayer,
//     respects «alert sounds»), backspace/shift with their own sound.
//  4. Backspace guard: continuous deleting ends after 8 s at the latest.
//  5. Look: rounded rectangles, pressed -20 %, shift second tone, Enter accent, labels 21 px/600.
// Loaded and torn down together with duoOverview.js (live reloadable).

const HOLD_MS = 350;          // Long press from touch-down (since duoheat 01.11. no more 150 ms delay on release; previously 450)
const DELETE_MAX_MS = 8000;   // guard for held deleting
const ROW = 58;               // row height in logical px (≈ 10 mm at scale 2.76)
const BARS = 70;              // suggestion bar + keyboard margins (measured)
const BARS_EMPTY = 22;        // margins only: without an input method (no ibus) the suggestion bar stays empty -> off
const KEY_HAPTIC_MS = 12;

export function installKeyboard(d) {
    globalThis.__duoKbDebug = false;   // trace only on request (the probe sets it)
    const dbg = msg => {
        if (globalThis.__duoKbDebug)
            log(`duo-osk: KB ${msg} | feld «${Main.overview._overview?._controls?._searchEntry?.get_text?.()}»`);
    };
    const {Main, St, Clutter, GLib} = d;
    const Gio = imports.gi.Gio;
    const undo = [];
    const extDir = GLib.path_get_dirname(d.selfPath);

    // ---- Rueckmeldung ----
    let hapticSock = null, hapticAddr = null;
    const haptic = ms => {
        try {
            hapticSock ??= Gio.Socket.new(Gio.SocketFamily.UNIX, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.DEFAULT);
            hapticAddr ??= Gio.UnixSocketAddress.new('/run/duo/haptik.sock');
            hapticSock.send_to(hapticAddr, new TextEncoder().encode(`${ms}`), null);
        } catch (e) {
            // helper not there: stay silent
        }
    };
    const sounds = {};
    const soundFile = name => (sounds[name] ??= Gio.File.new_for_path(`${extDir}/${name}.wav`));
    const click = name => {
        try {
            global.display.get_sound_player().play_from_file(soundFile(name), 'Tastenanschlag', null);
        } catch (e) {
            // continue without sound
        }
    };
    const feedback = key => {
        haptic(KEY_HAPTIC_MS);
        const icon = key._icon?.icon_name ?? '';
        if (/clear|backspace|delete/.test(icon))
            click('klick-loeschen');
        else if (key._hasAction || key._keyval)
            click('klick-umschalt');
        else
            click('klick-taste');
    };

    const controller = () => Main.keyboard?._keyboard?._keyboardController ?? null;
    let vkbd = null;

    // ---- Key prototype from a running instance (Key is not exported) ----
    let keyProto = null;
    const orig = {};
    const findKey = a => {
        if (!a)
            return null;
        if (a.keyButton && typeof a._press === 'function' && typeof a._release === 'function')
            return a;
        for (const c of a.get_children?.() ?? []) {
            const k = findKey(c);
            if (k)
                return k;
        }
        return null;
    };

    const patchKeys = () => {
        if (keyProto)
            return true;
        const k = findKey(Main.keyboard?._keyboard);
        if (!k)
            return false;
        keyProto = Object.getPrototypeOf(k);
        orig.press = keyProto._press;
        orig.release = keyProto._release;
        orig.hide = keyProto._hideSubkeys;
        orig.captured = keyProto._onCapturedEvent;
        // GNOME bug: touches without a target actor throw in _onCapturedEvent («descendant may not be null»);
        // without a target it lies outside the variants menu -> treat as outside
        keyProto._onCapturedEvent = function (actor, event) {
            if (global.stage.get_event_actor(event))
                return orig.captured.call(this, actor, event);
            const type = event.type();
            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN)
                this._capturedPress = true;
            else if ((type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) && this._capturedPress)
                this._hideSubkeys();
            return Clutter.EVENT_STOP;
        };

        keyProto._press = function (button, commitString) {
            // emoji keys (button mask 0) and action keys as before; only characters are written on touch-down
            const main = button === this.keyButton;
            if (GLib.file_test('/run/duo/tipplog', GLib.FileTest.EXISTS))
                log(`duo-osk: TASTE druck «${commitString ?? this.keyButton?.label}» haupt ${main} maske ${button?.get_pressed?.() ?? '?'}`);
            feedback(this);
            globalThis.__duoLastPress = GLib.get_monotonic_time();   // for recovering lost taps (safety net)
            this.emit('pressed');
            this._pressed = true;
            this._duoEarly = null;
            if (main)
                this._duoLong = false;
            if (main && commitString && !this._keyval && !this._hasAction && this.keyButton.get_button_mask() !== 0) {
                this.emit('commit', commitString);
                this._duoEarly = commitString;
            }
            if (main) {
                if (this._pressTimeoutId)
                    GLib.source_remove(this._pressTimeoutId);
                this._pressTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_MS, () => {
                    this._pressTimeoutId = 0;
                    dbg(`langdruck ${commitString} frueh ${this._duoEarly}`);
                    this.emit('long-press');
                    if (this._extendedKeys.length > 0) {
                        // the base character stays; only choosing a variant replaces it (see _release)
                        if (this._duoEarly) {
                            this._duoAwaitSub = this._duoEarly;
                            this._duoEarly = null;
                        }
                        dbg('nach loeschen');
                        this._duoLong = true;   // releasing this finger must neither write nor close
                        this._touchPressSlot = null;
                        this._ensureExtendedKeysPopup();
                        this.keyButton.set_hover(false);
                        this.keyButton.fake_release();
                        this._showSubkeys();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        };

        keyProto._release = function (button, commitString) {
            dbg(`release ${commitString} main ${button === this.keyButton} lang ${this._duoLong} pressed ${this._pressed}`);
            if (this._pressTimeoutId) {
                GLib.source_remove(this._pressTimeoutId);
                this._pressTimeoutId = 0;
            }
            if (button === this.keyButton && this._duoLong) {
                // finger lifts after the long press: the variants menu stays open, write nothing
                this._duoLong = false;
                this._pressed = false;
                this.emit('released');
                return;
            }
            if (this._pressed) {
                if (button === this.keyButton && this._duoEarly) {
                    // already written on touch-down
                } else if (this._keyval && button === this.keyButton) {
                    this.emit('keyval', this._keyval);
                } else if (commitString && button !== this.keyButton && this._duoAwaitSub) {
                    // variant chosen: remove the base character via GNOME's delete path (like backspace, in the
                    // event context of the tap), then write the variant
                    this._duoAwaitSub = null;
                    const c = controller();
                    c?.toggleDelete(true);
                    c?.toggleDelete(false);
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                        this.emit('commit', commitString);
                        return GLib.SOURCE_REMOVE;
                    });
                } else if (commitString) {
                    this.emit('commit', commitString);
                } else if (!this._hasAction) {
                    console.error('Need keyval, commitString or an action');
                }
            }
            this._duoEarly = null;
            this.emit('released');
            this._hideSubkeys();
            this._pressed = false;
        };

        keyProto._hideSubkeys = function () {
            orig.hide.call(this);
            if (globalThis.__duoKbDebug)
                log(`duo-osk: _hideSubkeys, warte auf Variante: ${this._duoAwaitSub}`);
            this._duoAwaitSub = null;   // closed without a choice: the base character simply stays
        };
        log(`duo-osk: Tastatur: Schreiben beim Aufsetzen, Langdruck ${HOLD_MS} ms, Rueckmeldung aktiv`);
        markKeys();
        return true;
    };

    // Enter in accent colour: GNOME has no class of its own for it
    const markKeys = () => {
        const walk = a => {
            if (a?.keyButton && a._keyval === 0xff0d)
                a.keyButton.add_style_class_name('duo-enter-key');
            for (const c of a?.get_children?.() ?? [])
                walk(c);
        };
        walk(Main.keyboard?._keyboard);
    };

    // ---- Ruecktasten-Waechter ----
    let ctrlProto = null, origToggleDelete = null, deleteGuard = 0;
    const patchController = () => {
        const c = controller();
        if (!c || ctrlProto)
            return;
        ctrlProto = Object.getPrototypeOf(c);
        origToggleDelete = ctrlProto.toggleDelete;
        ctrlProto.toggleDelete = function (enabled) {
            if (deleteGuard) {
                GLib.source_remove(deleteGuard);
                deleteGuard = 0;
            }
            if (enabled) {
                deleteGuard = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DELETE_MAX_MS, () => {
                    deleteGuard = 0;
                    log('duo-osk: Tastatur: Dauerloeschen nach 8 s beendet (Waechter)');
                    origToggleDelete.call(this, false);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return origToggleDelete.call(this, enabled);
        };
    };

    // ---- Hoehe in Millimetern ----
    const kbProto = () => Main.keyboard?._keyboard ? Object.getPrototypeOf(Main.keyboard._keyboard) : null;
    let relayoutProto = null, origRelayout = null, origCursor = null, origAnimWin = null;
    let target = 1;
    const applyStretch = actor => {
        if (!actor)
            return;
        if (typeof actor.setRatio === 'function' && typeof actor._ratio === 'number') {
            const base = actor._duoBaseRatio ?? actor._ratio;
            actor._duoBaseRatio ??= base;
            const want = base * target;
            if (Math.abs(actor._ratio - want) > 0.001) {
                actor._ratio = want;
                actor.queue_relayout();
            }
            if (!actor._duoKbPatched) {
                actor._duoKbPatched = true;
                const prev = actor.setRatio;
                // shared value (globalThis): after a reload the new one applies, after teardown the extension's again
                actor.setRatio = function (rw, rh) {
                    prev.call(this, rw, rh);
                    const t = globalThis.__duoKbTarget;
                    if (typeof t === 'number') {
                        this._ratio = (this._duoBaseRatio ?? this._ratio) * t;
                        this.queue_relayout();
                    }
                };
            }
        }
        for (const ch of actor.get_children?.() ?? [])
            applyStretch(ch);
    };
    const patchRelayout = () => {
        const p = kbProto();
        if (!p || relayoutProto)
            return;
        relayoutProto = p;
        origRelayout = p._relayout;
        origCursor = p.setCursorLocation;
        origAnimWin = p._animateWindow;
        // laptop posture: keyboard is on top -> only move the window if the text cursor would lie under the keyboard,
        // and then DOWN (below the keyboard) instead of up
        p.setCursorLocation = function (window, x, y, w, h) {
            if (!globalThis.__duoKbTopMode?.())
                return origCursor.call(this, window, x, y, w, h);
            const box = Main.layoutManager.keyboardBox;
            const [, by] = box.get_transformed_position();
            const y1 = by - this.height, y2 = by;   // sichtbarer Tastaturbereich
            if (window && y + h > y1 && y < y2) {
                if (this._focusWindow !== window)
                    this._setFocusWindow(window);
            } else if (!window || this._focusWindow !== window || y > y2 + this.height) {
                this._setFocusWindow(null);
            }
        };
        p._animateWindow = function (window, show) {
            if (!globalThis.__duoKbTopMode?.())
                return origAnimWin.call(this, window, show);
            const actor = window.get_compositor_private();
            if (!actor)
                return;
            const finalY = show ? this._focusWindowStartY + Math.round(this.height) : this._focusWindowStartY;
            actor.ease({
                y: finalY,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    if (window.get_compositor_private())
                        this._windowSlideAnimationComplete(window, finalY);
                },
            });
        };
        p._relayout = function () {
            const monitor = Main.layoutManager.keyboardMonitor;
            if (!monitor)
                return;
            this.width = monitor.width;
            // hide the empty suggestion bar (took ~50 px above the keys); when suggestions arrive, show it again
            const sg = this._suggestions;
            if (sg && !sg._duoWatch) {
                const sync = () => {
                    const has = sg.get_n_children() > 0;
                    if (sg.visible !== has) {
                        sg.visible = has;
                        this._relayout();
                    }
                };
                sg._duoWatch = [sg.connect('child-added', sync), sg.connect('child-removed', sync)];
            }
            if (sg)
                sg.visible = sg.get_n_children() > 0;
            const bars = sg?.visible ? BARS : BARS_EMPTY;
            const landscape = monitor.width > monitor.height;
            const single = GLib.file_test('/run/duo/single', GLib.FileTest.EXISTS);
            // 4 rows of ROW; landscape in single-panel mode at most half (text stays visible)
            let want = 4 * ROW + bars;
            if (landscape && single)
                want = Math.min(want, Math.round(monitor.height * 0.5));
            want = Math.min(want, Math.round(monitor.height * (landscape ? 0.62 : 0.48)));
            const pageH = Math.max(100, want - bars);
            target = Math.max(0.6, Math.min(1.6, (monitor.width / pageH) / 2.75));
            globalThis.__duoKbTarget = target;
            applyStretch(this);
            this.scale_y = 1;
            this.height = want;
            markKeys();
            lm._updateKeyboardBox();
        };
        Main.keyboard._keyboard._relayout();
    };

    // ---- Laptop posture: keyboard at the top of the lower panel (right below the bar at the hinge) ----
    // GNOME puts the keyboard area at the bottom edge and slides the keyboard in by its height; here the area
    // lies (bar + height) below the top edge, so the keyboard appears at the top. Only with both panels
    // stacked (landscape, not single-panel). Request by the owner 31.10.: search field/results at the top for this (duoOverview).
    const lm = Main.layoutManager;
    const topMode = () => {
        const mons = lm.monitors;
        const km = lm.keyboardMonitor;
        if (mons.length !== 2 || !km || GLib.file_test('/run/duo/single', GLib.FileTest.EXISTS))
            return false;
        const other = mons.find(m => m.index !== km.index);
        return other && other.x === km.x && km.y > other.y;   // stacked, keyboard on the lower one
    };
    globalThis.__duoKbTopMode = topMode;
    const origUKB = lm._updateKeyboardBox;
    lm._updateKeyboardBox = function () {
        origUKB.call(this);
        // only while the keyboard is open: when closed, the box stays below the screen edge as in GNOME,
        // otherwise the invisible keyboard lies on the panel and swallows every tap (Firefox search field, dock; 31.10.)
        if (!topMode() || !Main.keyboard?._keyboard?._keyboardVisible)
            return;
        const m = this.keyboardMonitor;
        const kb = Main.keyboard?._keyboard;
        const h = Math.round(kb?.height || 0);
        const bar = this.primaryIndex === m.index ? Math.round(Main.panel.height) : 0;
        this.keyboardBox.set_position(m.x, m.y + bar + h);
    };
    lm._updateKeyboardBox();
    let boxLater = 0;
    const visId = Main.keyboard.connect('visibility-changed', () => {
        if (boxLater)
            GLib.source_remove(boxLater);
        boxLater = 0;
        if (Main.keyboard.visible) {
            lm._updateKeyboardBox();
            return;
        }
        // after the hide animation, back below the edge
        boxLater = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            boxLater = 0;
            lm._updateKeyboardBox();
            return GLib.SOURCE_REMOVE;
        });
    });

    // ---- Reload the layout (Swiss character page): register a new resource (the last registered one wins) and
    // rebuild the keyboard; GNOME only reads the layout when building ----
    let layoutRes = null;
    try {
        layoutRes = Gio.Resource.load('/usr/local/share/duo-osk/duo-osk-layouts.gresource');
        Gio.resources_register(layoutRes);
        const km = Main.keyboard;
        if (km?._keyboard && !km._keyboard.visible) {
            km._keyboard.setCursorLocation(null);
            km._keyboard.destroy();
            km._keyboard = null;
            km._syncEnabled();   // neue Tastatur nutzt dieselben (gepatchten) Prototypen
        }
    } catch (e) {
        log(`duo-osk: Tastatur-Layout: ${e}`);
    }

    // Safety net: if a finger touch-down lands on the keyboard area instead of a key (gap between the keys, or
    // the shell briefly picks the area; measurement 31.10.: «r» and «o» right in the middle of the key were lost this way), it goes to
    // the nearest key (up to SNAP_PX away). The end of the same touch follows it there (the implicit touch
    // grab would otherwise deliver it to the area).
    const SNAP_PX = 16;
    const isKey = a => a?.has_style_class_name?.('keyboard-key');
    const keyOf = a => {
        for (let c = a; c; c = c.get_parent())
            if (isKey(c))
                return c;
        return null;
    };
    const inKeyboard = a => {
        const kb = Main.keyboard?._keyboard;
        for (let c = a; c; c = c.get_parent())
            if (c === kb)
                return true;
        return false;
    };
    const nearestKey = (x, y) => {
        const page = Main.keyboard?._keyboard?._currentPage;
        let best = null, bestD = SNAP_PX;
        const walk = a => {
            for (const c of a.get_children()) {
                if (!c.mapped)
                    continue;
                if (isKey(c)) {
                    const [cx, cy] = c.get_transformed_position();
                    const [w, h] = c.get_transformed_size();
                    const dx = Math.max(cx - x, 0, x - (cx + w));
                    const dy = Math.max(cy - y, 0, y - (cy + h));
                    const dd = Math.hypot(dx, dy);
                    if (dd <= bestD) {
                        bestD = dd;
                        best = c;
                    }
                } else {
                    walk(c);
                }
            }
        };
        if (page)
            walk(page);
        return best;
    };
    // Per finger (real multitouch since duoheat, 01.11.): otherwise events of the second thumb landed on the key of the
    // first (overlapping typing with two thumbs -> letters were dropped)
    const caughtBy = new Map();   // finger -> key its touch was redirected to
    const aufBy = new Map();      // finger -> {key, time} at touch-down (recovery in case no press came)
    const tippSpur = global.stage.connect('captured-event', (actor, ev) => {
        const t = ev.type();
        const begin = t === Clutter.EventType.TOUCH_BEGIN;
        const end = t === Clutter.EventType.TOUCH_END || t === Clutter.EventType.TOUCH_CANCEL;
        if (!begin && !end && t !== Clutter.EventType.TOUCH_UPDATE)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = ev.get_coords();
        const seq = ev.get_event_sequence?.() ?? 0;
        const src = ev.get_source?.() ?? global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        const spur = (begin || end) && GLib.file_test('/run/duo/tipplog', GLib.FileTest.EXISTS);
        let target = null;
        if (begin && !keyOf(src) && inKeyboard(src))
            target = nearestKey(x, y);
        if (spur) {
            log(`duo-osk: TIPP ${begin ? 'auf' : 'ab'} ${Math.round(x)},${Math.round(y)} ${src?.constructor?.name}` +
                `${src?.style_class ? `.${src.style_class}` : ''} taste «${keyOf(src)?.label ?? null}»` +
                `${target ? ` -> umgeleitet auf «${target.label}»` : ''}`);
        }
        // Recovery (measurement 31.10. evening): a finger touched down on a key, slid a little, and GNOME's key triggered no
        // press at all («w» down, «e» up, no KEY press) -> on release write the letter of the touch-down key
        if (begin) {
            const taste = (target ?? keyOf(src))?.get_parent?.() ?? null;
            if (taste)
                aufBy.set(seq, {taste, zeit: GLib.get_monotonic_time()});
            else
                aufBy.delete(seq);
        } else if (end && aufBy.has(seq)) {
            const {taste: k, zeit: aufZeit} = aufBy.get(seq);
            aufBy.delete(seq);
            // GNOME 48 keeps the key's text only in a closure; for character keys the label is the same text
            const lab = k.keyButton?.label ?? '';
            const cs = k._commitString ?? ([...lab].length === 1 ? lab : null);
            if (cs && !(k._keyval > 0) && (globalThis.__duoLastPress ?? 0) < aufZeit && typeof k._press === 'function') {
                if (spur)
                    log(`duo-osk: TIPP nachgeholt «${cs}»`);
                k._press(k.keyButton, cs);
                k._release(k.keyButton, cs);
            }
        }
        if (begin && target) {
            caughtBy.set(seq, target);
            target.event(ev, false);
            return Clutter.EVENT_STOP;
        }
        if (caughtBy.has(seq) && !begin) {
            const btn = caughtBy.get(seq);
            if (end)
                caughtBy.delete(seq);
            if (keyOf(src) !== btn || end) {
                btn.event(ev, false);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    });
    // trace: does the app request the keyboard? (only with __duoKbDebug)
    const panelSpur = Main.inputMethod.connect('input-panel-state', (o, st) => dbg(`input-panel-state ${st}`));

    // ---- Stil ----
    const css = Gio.File.new_for_path(`${extDir}/duo-keyboard.css`);
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    try {
        theme.load_stylesheet(css);
    } catch (e) {
        log(`duo-osk: Tastatur-Stil: ${e}`);
    }

    // the keyboard is only created on demand -> keep checking until it exists (and mark again after a rebuild)
    const tryAll = () => {
        patchKeys();
        patchController();
        patchRelayout();
    };
    tryAll();
    // until all prototypes are adjusted (the keyboard is only created on demand); after that the adjustments apply to every
    // new keyboard by themselves -> the timer ends (previously every 1.5 s forever)
    let pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        tryAll();
        if (keyProto && ctrlProto && relayoutProto) {
            pollId = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });

    return {
        uninstall() {
            global.stage.disconnect(tippSpur);
            Main.keyboard.disconnect(visId);
            if (boxLater)
                GLib.source_remove(boxLater);
            Main.inputMethod.disconnect(panelSpur);
            if (pollId)
                GLib.source_remove(pollId);
            lm._updateKeyboardBox = origUKB;
            globalThis.__duoKbTopMode = null;
            lm._updateKeyboardBox();
            if (keyProto) {
                keyProto._press = orig.press;
                keyProto._release = orig.release;
                keyProto._hideSubkeys = orig.hide;
                keyProto._onCapturedEvent = orig.captured;
            }
            if (ctrlProto)
                ctrlProto.toggleDelete = origToggleDelete;
            if (deleteGuard)
                GLib.source_remove(deleteGuard);
            globalThis.__duoKbTarget = null;
            if (relayoutProto) {
                relayoutProto._relayout = origRelayout;
                const sg = Main.keyboard?._keyboard?._suggestions;
                if (sg?._duoWatch) {
                    sg._duoWatch.forEach(id => sg.disconnect(id));
                    delete sg._duoWatch;
                    sg.show();
                }
                relayoutProto.setCursorLocation = origCursor;
                relayoutProto._animateWindow = origAnimWin;
                Main.keyboard?._keyboard?._relayout();
            }
            try {
                theme.unload_stylesheet(css);
            } catch (e) {
                // egal
            }
            hapticSock?.close();
            if (layoutRes) {
                try {
                    Gio.resources_unregister(layoutRes);
                } catch (e) {
                    // egal
                }
            }
        },
    };
}
