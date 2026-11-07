// Memory guard (request 31.10.): before memory runs out, the Duo pauses the apps and lets the user
// choose which one to close -- instead of everything getting sluggish, earlyoom killing at random, or the session dying.
//   1. Watcher: /proc/meminfo + /proc/pressure/memory every second.
//   2. Alarm: stop all apps (units under app.slice with a window app or > 150 MB) via SIGSTOP; kernel
//      4.14 has no cgroup.freeze, hence signals to all processes of the cgroup. Mutter's «not responding» check
//      is off meanwhile (check-alive-timeout 0).
//   3. Choice: list with memory use per app, «Schliessen» (close; SIGKILL, works on stopped processes too),
//      «Weiter» (continue) resumes the rest. Once there is enough room again, it continues by itself.
// The last line stays earlyoom (set later, shell excluded); the shell itself is protected by duo-shellschutz
// (oom_score_adj -900). Dev probe: $XDG_RUNTIME_DIR/duo-dev/speicher-test forces the alarm.
export function installSpeicher(d) {
    const {Main, St, Clutter, GLib, Shell} = d;
    const Gio = imports.gi.Gio;
    const devDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'duo-dev']);
    const APPS = `/sys/fs/cgroup/user.slice/user-${new Gio.Credentials().get_unix_user()}.slice/user@${new Gio.Credentials().get_unix_user()}.service/app.slice`;
    // never stop: services the user interface itself depends on
    const SYSTEM = /^(dbus|dconf|flatpak-|xdg-|gvfs|at-spi|evolution|gnome-session|org\.gnome\.(Shell|ScreenSaver|Settings|Identity|OnlineAccounts|SettingsDaemon)|org\.a11y|pipewire|wireplumber|filter-chain|ibus|tracker|localsearch|gsd-|gnome-keyring|p11-kit|ssh-agent|duo-)/;
    const MB = 1024 * 1024;

    const read = path => {
        try {
            const [ok, b] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(b) : '';
        } catch (e) {
            return '';
        }
    };
    const memInfo = () => {
        const t = read('/proc/meminfo'), v = k => Number(t.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024;
        const psi = read('/proc/pressure/memory').match(/^full avg10=([\d.]+)/m);
        return {total: v('MemTotal'), avail: v('MemAvailable'), swapFree: v('SwapFree'), swapTotal: v('SwapTotal'),
            full10: psi ? Number(psi[1]) : 0};
    };
    // Alarm: RAM low AND compressed swap half full, or RAM almost empty, or the system is stuck
    // mostly in memory stalls (PSI full). earlyoom only steps in below that (-m 4 -s 15).
    const kritisch = m => (m.avail < 0.12 * m.total && m.swapFree < 0.5 * m.swapTotal) || m.avail < 0.06 * m.total ||
        m.full10 > 30;
    const genug = m => m.avail > 0.18 * m.total || (m.avail > 0.12 * m.total && m.swapFree > 0.6 * m.swapTotal);

    // cgroup unit -> app id
    const unescape = s => s.replace(/\\x([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const appIdOf = unit => {
        const u = unescape(unit);
        let m = u.match(/^app-flatpak-(.+)-\d+\.scope$/) ?? u.match(/^app-gnome-(.+)-\d+\.scope$/) ??
            u.match(/^app-dbus-:[\d.]+-(.+)\.slice$/);
        if (m)
            return m[1];
        m = u.match(/^(?:app-)?(.+?)(?:@.*)?\.(service|scope)$/);
        return m ? m[1] : null;
    };
    const pidsIn = dir => {
        const out = [];
        const walk = p => {
            for (const l of read(`${p}/cgroup.procs`).split('\n'))
                if (l.trim())
                    out.push(Number(l));
            let en;
            try {
                en = Gio.File.new_for_path(p).enumerate_children('standard::name,standard::type', 0, null);
            } catch (e) {
                return;
            }
            let fi;
            while ((fi = en.next_file(null))) {
                if (fi.get_file_type() === Gio.FileType.DIRECTORY)
                    walk(`${p}/${fi.get_name()}`);
            }
            en.close(null);
        };
        walk(dir);
        return out;
    };
    // Apps with memory use, the same app (several scopes) merged, largest first
    const listApps = () => {
        const byId = new Map();
        let en;
        try {
            en = Gio.File.new_for_path(APPS).enumerate_children('standard::name,standard::type', 0, null);
        } catch (e) {
            return [];
        }
        let fi;
        const appSys = Shell.AppSystem.get_default();
        while ((fi = en.next_file(null))) {
            if (fi.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const unit = fi.get_name(), id = appIdOf(unit);
            if (!id || SYSTEM.test(id))
                continue;
            const dir = `${APPS}/${unit}`;
            const mem = Number(read(`${dir}/memory.current`).trim() || 0) + Number(read(`${dir}/memory.swap.current`).trim() || 0);
            const pids = pidsIn(dir);
            if (!pids.length)
                continue;
            const app = appSys.lookup_app(`${id}.desktop`);
            if (!app && mem < 150 * MB)   // background services only if they are really big (e.g. an LLM)
                continue;
            const e = byId.get(id) ?? {id, app, name: app?.get_name() ?? id, mem: 0, pids: []};
            e.mem += mem;
            e.pids.push(...pids);
            byId.set(id, e);
        }
        en.close(null);
        return [...byId.values()].filter(e => e.mem >= 30 * MB).sort((a, b) => b.mem - a.mem);
    };
    const signal = (pids, sig) => {
        if (!pids.length)
            return;
        try {
            Gio.Subprocess.new(['/usr/bin/kill', '-s', sig, '--', ...pids.map(String)],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            log(`duo-osk: Speicherwache kill ${sig}: ${e}`);
        }
    };
    const fmt = b => b >= 1024 * MB ? `${(b / 1024 / MB).toFixed(1).replace('.', ',')} GB` : `${Math.round(b / MB)} MB`;

    // ---- State ----
    let paused = [];          // [{id, name, pids}]
    let overlay = null, grab = null, listBox = null, statusLabel = null;
    let pauseUntil = 0;       // after «Weiter» without closing: 30 s of quiet, unless it gets even tighter
    let mutterSettings = null, aliveBefore = null;

    const setAlive = off => {
        try {
            mutterSettings ??= new Gio.Settings({schema_id: 'org.gnome.mutter'});
            if (off) {
                aliveBefore ??= mutterSettings.get_uint('check-alive-timeout');
                mutterSettings.set_uint('check-alive-timeout', 0);
            } else if (aliveBefore !== null) {
                mutterSettings.set_uint('check-alive-timeout', aliveBefore);
                aliveBefore = null;
            }
        } catch (e) {
            // key missing: then with the check after all
        }
    };
    const resumeAll = () => {
        for (const p of paused)
            signal(p.pids, 'CONT');
        paused = [];
        setAlive(false);
    };
    const closeDialog = () => {
        if (grab) {
            Main.popModal(grab);
            grab = null;
        }
        overlay?.destroy();
        overlay = listBox = statusLabel = null;
    };

    const btnStyle = (bg, fg = '#ffffff') =>
        `background-color: ${bg}; color: ${fg}; border-radius: 22px; padding: 10px 18px; font-weight: bold; min-height: 24px;`;
    const refreshList = () => {
        if (!listBox)
            return;
        listBox.destroy_all_children();
        const fresh = new Map(listApps().map(a => [a.id, a]));
        for (const p of paused) {
            const a = fresh.get(p.id);
            if (!a)
                continue;
            const row = new St.BoxLayout({style: 'spacing: 12px; padding: 6px 0;', x_expand: true});
            if (a.app)
                row.add_child(a.app.create_icon_texture(36));
            const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            texts.add_child(new St.Label({text: a.name, style: 'font-weight: bold; font-size: 15px; color: #ffffff;'}));
            texts.add_child(new St.Label({text: `${fmt(a.mem)} · pausiert`, style: 'font-size: 13px; color: #b8b8c0;'}));
            row.add_child(texts);
            const b = new St.Button({label: 'Schliessen', style: btnStyle('#c01c28'), y_align: Clutter.ActorAlign.CENTER,
                can_focus: true, reactive: true});
            b.connect('clicked', () => {
                signal(a.pids, 'KILL');
                paused = paused.filter(x => x.id !== a.id);
                log(`duo-osk: Speicherwache: ${a.name} geschlossen (${fmt(a.mem)})`);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                    check();
                    refreshList();
                    return GLib.SOURCE_REMOVE;
                });
                row.destroy();
            });
            row.add_child(b);
            listBox.add_child(row);
        }
        const m = memInfo();
        if (statusLabel)
            statusLabel.text = `Frei: ${fmt(m.avail)} von ${fmt(m.total)}` + (kritisch(m) ? ' – noch zu knapp' : '');
    };
    const openDialog = () => {
        if (overlay)
            return refreshList();
        const mon = Main.layoutManager.monitors[Main.layoutManager.focusIndex] ?? Main.layoutManager.primaryMonitor;
        overlay = new St.Widget({reactive: true, x: 0, y: 0, width: global.stage.width, height: global.stage.height,
            style: 'background-color: rgba(0,0,0,0.6);'});
        const card = new St.BoxLayout({vertical: true, reactive: true,
            style: 'background-color: #242428; border-radius: 22px; padding: 20px; spacing: 10px; ' +
                'border: 1px solid rgba(255,255,255,0.12);'});
        const w = Math.min(mon.width - 32, 560);
        card.set_width(w);
        card.add_child(new St.Label({text: 'Speicher fast voll', style: 'font-size: 20px; font-weight: bold; color: #ffffff;'}));
        const info = new St.Label({style: 'font-size: 14px; color: #d0d0d8;',
            text: 'Damit das Duo bedienbar bleibt, sind die Apps pausiert. Schliesse eine, um Platz zu schaffen.'});
        info.clutter_text.line_wrap = true;
        card.add_child(info);
        listBox = new St.BoxLayout({vertical: true, style: 'spacing: 4px;'});
        const scroll = new St.ScrollView({style: `max-height: ${Math.round(mon.height * 0.5)}px;`, x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        scroll.set_child(listBox);
        card.add_child(scroll);
        statusLabel = new St.Label({style: 'font-size: 13px; color: #b8b8c0;'});
        card.add_child(statusLabel);
        const weiter = new St.Button({label: 'Weiter – alle fortsetzen', style: btnStyle('#3584e4'), x_expand: true,
            can_focus: true, reactive: true});
        weiter.connect('clicked', () => {
            const m = memInfo();
            pauseUntil = GLib.get_monotonic_time() + 30 * 1000000;
            log(`duo-osk: Speicherwache: fortgesetzt ohne Schliessen (frei ${fmt(m.avail)})`);
            closeDialog();
            resumeAll();
        });
        card.add_child(weiter);
        overlay.add_child(card);
        Main.layoutManager.addTopChrome(overlay);
        card.set_position(mon.x + Math.round((mon.width - w) / 2), mon.y + Math.round(mon.height * 0.08));
        grab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.SYSTEM_MODAL});
        refreshList();
    };

    const alarm = why => {
        const apps = listApps();
        const neu = apps.filter(a => !paused.some(p => p.id === a.id));
        for (const a of neu)
            signal(a.pids, 'STOP');
        paused.push(...neu.map(a => ({id: a.id, name: a.name, pids: a.pids})));
        setAlive(true);
        log(`duo-osk: Speicherwache ALARM (${why}): pausiert ${neu.map(a => `${a.name} ${fmt(a.mem)}`).join(', ') || '-'}`);
        try {
            Main.keyboard?.close?.();
        } catch (e) {
            // never mind
        }
        openDialog();
    };
    const check = () => {
        const m = memInfo();
        const test = GLib.file_test(`${devDir}/speicher-test`, GLib.FileTest.EXISTS);
        if (test)
            GLib.unlink(`${devDir}/speicher-test`);
        if (overlay) {
            if (!test && genug(m) && !kritisch(m)) {   // room made: continue by itself
                closeDialog();
                const namen = paused.map(p => p.name).join(', ');
                resumeAll();
                log(`duo-osk: Speicherwache: genug Platz (frei ${fmt(m.avail)}), fortgesetzt: ${namen}`);
                try {
                    Main.notify('Speicher wieder frei', `Fortgesetzt: ${namen}`);
                } catch (e) {
                    // without notification
                }
            } else {
                refreshList();
            }
            return;
        }
        const now = GLib.get_monotonic_time();
        if (test)
            alarm('Probe');
        else if (kritisch(m) && (now > pauseUntil || m.avail < 0.06 * m.total))
            alarm(`frei ${fmt(m.avail)}, Swap frei ${fmt(m.swapFree)}, PSI ${m.full10}`);
    };
    const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        try {
            check();
        } catch (e) {
            log(`duo-osk: Speicherwache: ${e}`);
        }
        return GLib.SOURCE_CONTINUE;
    });
    return {
        uninstall() {
            GLib.source_remove(timer);
            closeDialog();
            resumeAll();   // on unload, never leave anything stopped
        },
    };
}
