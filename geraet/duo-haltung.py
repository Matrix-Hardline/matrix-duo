#!/usr/bin/python3 -I
"""duo-haltung: posture service of the Surface Duo 1 under GNOME (30.10.2026).
Reads the posture states of the sensor DSP (ssccli --sensor posture, libssc) and implements the posture logic:
  CLOSED            -> like the power key: panels dark, lock the session, Mutter PowerSaveMode 3
  leaving CLOSED    -> wake: PowerSaveMode 0, panels on (lock screen appears)
  FLIP_*/PEEK_*     -> one panel: only the front panel active in Mutter, touch of the rear panel muted (duotouch mute file)
  all others        -> both panels (default layout), no mute
States (sns_posture): 0 CLOSED 1 PEEK_R 2 PEEK_L 3 READ 4 COMPOSE 5 OPEN_DPM 6 OPEN_DLM 7 BROCHURE_R 8 TENT_R
9 FLIP_P_R 10 FLIP_L_R 11 FLIP_P_L 12 FLIP_L_L 13 BROCHURE_L 14 TENT_L 15 RAMP_R 16 RAMP_L 99 UNDETERMINED
Assumption (to be measured): RIGHT = right panel (DSI-2) facing the user, LEFT = left panel (DSI-1) facing the user."""
import glob, os, subprocess, sys, time, signal, threading


# Morpheus (06.11.2026): the device's account — no longer hard-coded «mobile». Uid 1000 is on every Matrix device
# the first account (first setup creates it); name and home are looked up on EVERY use, because
# the service starts before the setup.
def person():
    """(name, home) of the first account (uid 1000); none yet: ("", "/nonexistent")."""
    import pwd
    try:
        p = pwd.getpwuid(1000)
        return p.pw_name, p.pw_dir
    except KeyError:
        return "", "/nonexistent"


class MatrixSetting(os.PathLike):
    """~/.config/matrix/<name> of the account, resolved only when opened (open/os.stat accept PathLike)."""

    def __init__(self, name, base=".config/matrix"):
        self.name, self.base = name, base

    def __fspath__(self):
        return os.path.join(person()[1], self.base, self.name)


USER_ENV = ["env", "XDG_RUNTIME_DIR=/run/user/1000", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"]
_session_cache = {"t": 0.0, "user": "", "uid": 1000, "bus": "unix:path=/run/user/1000/bus"}

SEAT_FILE = "/run/systemd/seats/seat0"


def active_session():
    """(user, uid) of the active graphical session on seat0: mobile (session/lock screen) or gdm (login screen).
    31.10.: logind maintains /run/systemd/seats/seat0 (ACTIVE_UID=...) -> re-determine only when the file changed. Before,
    loginctl ran twice a second (around the clock, even when folded)."""
    try:
        st = os.stat(SEAT_FILE)
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        stamp = None
    if stamp is not None and stamp == _session_cache.get("stamp"):
        return _session_cache["user"], _session_cache["uid"]
    user, uid = person()[0], 1000
    try:
        kv = dict(l.split("=", 1) for l in open(SEAT_FILE).read().splitlines() if "=" in l)
        u = int(kv.get("ACTIVE_UID", "1000"))
        if os.path.exists("/run/user/%d/bus" % u) or u != 1000:
            import pwd
            user, uid = pwd.getpwuid(u).pw_name, u
    except (OSError, ValueError, KeyError):
        pass
    bus = "unix:path=/run/user/%d/bus" % uid
    if user != person()[0]:
        # The login screen (gdm) hangs on a private dbus-daemon: read the address from the environment of its gnome-shell
        try:
            pids = subprocess.run(["pgrep", "-u", user, "-x", "gnome-shell"], capture_output=True, text=True, timeout=3).stdout.split()
            for pid in pids:
                for kv in open("/proc/%s/environ" % pid, "rb").read().split(b"\0"):
                    if kv.startswith(b"DBUS_SESSION_BUS_ADDRESS="):
                        bus = kv.split(b"=", 1)[1].decode()
        except (subprocess.SubprocessError, OSError):
            pass
        # 02.11.: the Matrix login (greetd, niri) hangs on its own user bus -> that one applies as soon as it exists
        if bus == "unix:path=/run/user/%d/bus" % uid and not os.path.exists("/run/user/%d/bus" % uid):
            stamp = None   # shell/bus not there yet -> try again next time
    _session_cache.update(stamp=stamp, user=user, uid=uid, bus=bus)
    return user, uid
MUTE_DIR = "/run/duo"
NAMES = {0: "CLOSED", 1: "PEEK_RIGHT", 2: "PEEK_LEFT", 3: "READ", 4: "COMPOSE", 5: "OPEN_DUAL_PORTRAIT", 6: "OPEN_DUAL_LANDSCAPE",
         7: "BROCHURE_RIGHT", 8: "TENT_RIGHT", 9: "FLIP_P_RIGHT", 10: "FLIP_L_RIGHT", 11: "FLIP_P_LEFT", 12: "FLIP_L_LEFT",
         13: "BROCHURE_LEFT", 14: "TENT_LEFT", 15: "RAMP_RIGHT", 16: "RAMP_LEFT", 99: "UNDETERMINED"}
SINGLE_RIGHT = {9, 10}         # right panel in front (PEEK = only open a crack: no switching)
SINGLE_LEFT = {11, 12}         # left panel in front

def log(msg):
    print("duo-haltung: " + msg, flush=True)

def as_user(args, timeout=8):
    user, uid = active_session()
    env = ["env", "XDG_RUNTIME_DIR=/run/user/%d" % uid, "DBUS_SESSION_BUS_ADDRESS=%s" % _session_cache["bus"]]
    return subprocess.run(["runuser", "-u", user, "--", *env, "timeout", str(timeout), *args],
                          capture_output=True, text=True)

def write(path, value):
    try:
        with open(path, "w") as f:
            f.write(str(value))
    except OSError as e:
        log("schreiben %s: %s" % (path, e))

def panels_dark():
    for p in ("panel0", "panel1"):
        write("/sys/class/backlight/%s-backlight/bl_power" % p, 4)

PANEL_OF = {"DSI-1": "panel0", "DSI-2": "panel1"}

# ---- One brightness for both panels (30.10.) ----
# GNOME's slider (gsd-power) drives only panel0. This one brightness applies to both panels and in every state:
# the light thread continuously copies panel0 to panel1 (even when panel0 is dark in one-panel mode, its
# value stays the source), and switching on/off only touches bl_power, never the brightness. The value survives reboots
# (/var/lib/duo/helligkeit). Replaces duo-blmirror and the fixed «160 at power-on».
BL = "/sys/class/backlight/%s-backlight/brightness"
LIGHT_FILE = "/var/lib/duo/helligkeit"

def read_int(path):
    try:
        with open(path) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None

def light_level():
    return read_int(BL % "panel0")

SLEEPING = threading.Event()   # set while the device sleeps folded


# ---- Rest request (02.11.2026, Matrix Tube): a panel that is only looked at (the list during a video)
# may give up its light. The canvas writes the outputs to /run/user/1000/matrix-panel-ruhe (mk::runtime);
# this service stays the ONE that switches panels: bl_power 4 and no brightness copy while the request stands.
# Only panel1 — duo-blmirror copies bl_power from panel0 to panel1, panel0 off would mean both off.
REST_FILE = "/run/user/1000/matrix-panel-ruhe"

def rest_wanted():
    """Lines «<output> [<pid>]». With a pid the request only holds while the requester lives (02.11.2026: a
    crashed Tube list otherwise left the panel dark); an orphaned request is deleted."""
    try:
        with open(REST_FILE) as f:
            lines = f.read().splitlines()
    except OSError:
        return set()
    want, orphan = set(), False
    for line in lines:
        parts = line.split()
        if not parts or PANEL_OF.get(parts[0]) != "panel1":
            continue
        if len(parts) > 1 and parts[1].isdigit() and not os.path.exists("/proc/" + parts[1]):
            orphan = True
            continue
        want.add("panel1")
    if orphan and not want:
        try:
            os.unlink(REST_FILE)
        except OSError:
            pass
    return want


# ---- Bluetooth healing (02.11.2026): gsd-rfkill (GNOME, runs at every session change) soft-blocks Bluetooth;
# after unblocking, the chip behind our own bridge no longer accepts «power on» (Failed 0x03); only a
# restart of duo-bt heals it. Only the transition blocked -> free triggers the restart; nothing is ever unblocked from here.
def bt_blocked():
    for d in glob.glob("/sys/class/rfkill/rfkill*"):
        try:
            if open(d + "/type").read().strip() == "bluetooth" and open(d + "/soft").read().strip() == "1":
                return True
        except OSError:
            pass
    return False

_bt_was_blocked = [None]

def bt_heal():
    blocked = bt_blocked()
    if _bt_was_blocked[0] and not blocked:
        log("Bluetooth entsperrt -> duo-bt neu (Bruecke nimmt nach rfkill kein power on mehr an)")
        subprocess.run(["systemctl", "restart", "duo-bt"], capture_output=True)
    _bt_was_blocked[0] = blocked


def light_thread():
    saved = read_int(LIGHT_FILE)
    if saved and saved > 0:
        write(BL % "panel0", saved)
        log("Helligkeit %d wiederhergestellt" % saved)
    last_saved = saved
    seen, since = None, time.monotonic()
    resting = set()
    beat = 0
    while True:
        beat += 1
        if beat % 8 == 0:   # every ~2 s
            bt_heal()
        # When folded, the posture alone switches — the rest request waits.
        if not SLEEPING.is_set():
            want = rest_wanted()
            for p in want - resting:
                panel_off(p)
                log("Ruhe-Bitte: %s aus" % p)
            for p in resting - want:
                panel_on(p)
                log("Ruhe-Bitte vorbei: %s an" % p)
            resting = want
        lv = light_level()
        if lv is not None:
            if "panel1" not in resting and read_int(BL % "panel1") != lv:
                write(BL % "panel1", lv)
            if lv != seen:
                seen, since = lv, time.monotonic()
            # save only after 5 s of quiet (GNOME's idle dimming is short-lived and must not become the reboot value)
            if lv > 0 and lv != last_saved and time.monotonic() - since > 5:
                try:
                    os.makedirs(os.path.dirname(LIGHT_FILE), exist_ok=True)
                    with open(LIGHT_FILE, "w") as f:
                        f.write(str(lv))
                    last_saved = lv
                except OSError:
                    pass
        time.sleep(2.0 if SLEEPING.is_set() or os.path.exists(AUS) else 0.25)   # nothing happens when folded; previously a fixed 0.15 s

def panel_on(p):
    write("/sys/class/backlight/%s-backlight/bl_power" % p, 0)
    lv = light_level()
    if lv and p == "panel1":
        write(BL % "panel1", lv)

def panel_off(p):
    write("/sys/class/backlight/%s-backlight/bl_power" % p, 4)

def panels_on():
    for p in ("panel0", "panel1"):
        panel_on(p)

_blmirror_done = [False]


def blmirror(run):
    """Replaced by light_thread (one brightness for both panels); the old mirror service always stays off.
    Stop it only once (previously a systemctl call on every light change)."""
    if _blmirror_done[0]:
        return
    subprocess.run(["systemctl", "stop", "duo-blmirror"], capture_output=True)
    _blmirror_done[0] = True

def power_save(mode):
    r = as_user(["busctl", "--user", "set-property", "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig",
                 "org.gnome.Mutter.DisplayConfig", "PowerSaveMode", "i", str(mode)])
    return r.returncode == 0

def lock_session():
    as_user(["busctl", "--user", "call", "org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver", "Lock"])

def mute(panel, on):
    os.makedirs(MUTE_DIR, exist_ok=True)
    path = os.path.join(MUTE_DIR, "mute-" + panel)
    if on:
        open(path, "w").close()
    elif os.path.exists(path):
        os.unlink(path)

def configured_scale():
    """Scale from the user's saved monitor layout (monitors.xml), otherwise the Duo default of 275 %."""
    import re
    try:
        m = re.search(r"<scale>([0-9.]+)</scale>", open(os.path.join(person()[1], ".config/monitors.xml")).read())
        if m:
            return float(m.group(1))
    except OSError:
        pass
    return 2.7607362270355225

def apply_monitors(active, orient="normal"):
    """active: 'both', 'DSI-1' or 'DSI-2'. Mutter DisplayConfig.ApplyMonitorsConfig (temporary, method 1) via gdbus with a timeout."""
    import ast
    r = as_user(["gdbus", "call", "--session", "-d", "org.gnome.Mutter.DisplayConfig", "-o", "/org/gnome/Mutter/DisplayConfig",
                 "-m", "org.gnome.Mutter.DisplayConfig.GetCurrentState"], timeout=6)
    if r.returncode != 0 or not r.stdout.startswith("("):
        log("GetCurrentState fehlgeschlagen: %s" % (r.stderr.strip() or r.stdout.strip())[:120])
        return False
    txt = r.stdout.strip()
    # pull serial, current scale and preferred mode ids out of the GVariant text (without a full grammar)
    import re
    m = re.match(r"\(uint32 (\d+),", txt)
    if not m:
        log("Serial nicht gefunden"); return False
    serial = int(m.group(1))
    modes = {}
    for mon in re.finditer(r"\(\('(DSI-[12])', '([^']*)', '([^']*)', '([^']*)'\), \[\('([^']+)', \d+, \d+, [0-9.]+, ([0-9.]+),", txt):
        modes[mon.group(1)] = (mon.group(1), mon.group(2), mon.group(3), mon.group(4), mon.group(5), float(mon.group(6)))
    if "DSI-1" not in modes or "DSI-2" not in modes:
        log("Monitore unvollstaendig: %s" % list(modes)); return False
    scale = configured_scale()
    width = int(round(1350 / scale))
    def lm(x, y, c, transform, primary):
        return "(%d, %d, %r, uint32 %d, %s, [('%s', '%s', @a{sv} {})])" % (x, y, scale, transform, "true" if primary else "false", c[0], c[4])
    height = int(round(1800 / scale))
    A, B = modes["DSI-1"], modes["DSI-2"]
    primB = (active == "both-B")
    # Mutter transform: 0 normal, 1 = 90 degrees (left-up: left side/panel A on top), 2 = 180 (bottom-up), 3 = 270 (right-up)
    # Landscape (only with both panels): the LOWER panel is the main panel -> overview, search and window list at the bottom,
    # the upper panel shows the workspace large (request the owner 30.10.). DUO_LANDSCAPE_PRIMARY=upper reverts it.
    lower_primary = active == "both" and os.environ.get("DUO_LANDSCAPE_PRIMARY", "lower") == "lower"
    if orient == "left-up":
        pa = (not primB) and not lower_primary
        lms = [lm(0, 0, A, 1, pa), lm(0, width, B, 1, not pa)]
    elif orient == "right-up":
        pb = primB and not lower_primary
        lms = [lm(0, 0, B, 3, pb), lm(0, width, A, 3, not pb)]
    elif orient == "tent":
        # TENT (03.11.2026, confirmed on the Duo): both hinges on top, panel A is folded over -> A is at 180 degrees to B
        # (A 270, B 90). Regardless of which panel is in front.
        lms = [lm(0, 0, A, 3, not primB), lm(0, width, B, 1, primB)]
    elif orient == "bottom-up":
        lms = [lm(0, 0, B, 2, primB), lm(width, 0, A, 2, not primB)]
    else:
        lms = [lm(0, 0, A, 0, not primB), lm(width, 0, B, 0, primB)]
    if active == "mirror":
        lms = ["(0, 0, %r, uint32 0, true, [('DSI-1', '%s', @a{sv} {}), ('DSI-2', '%s', @a{sv} {})])" % (scale, A[4], B[4])]
    r = as_user(["gdbus", "call", "--session", "-d", "org.gnome.Mutter.DisplayConfig", "-o", "/org/gnome/Mutter/DisplayConfig",
                 "-m", "org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig",
                 "uint32 %d" % serial, "uint32 1", "[%s]" % ", ".join(lms), "{'layout-mode': <uint32 1>}"], timeout=12)
    if r.returncode != 0:
        log("ApplyMonitorsConfig(%s): %s" % (active, (r.stderr.strip() or r.stdout.strip())[:160]))
        return False
    # 05.11.2026: the Mutter interface names only the two panels — niri then switches off every other output
    # (the TV on USB-C went black). A plugged-in screen is added right back; resolution and
    # size are set afterwards by duo-bildton (it watches over the output).
    if screen_plugged():
        as_user(["sh", "-c", 'S=$(ls -t "$XDG_RUNTIME_DIR"/niri.*.sock 2>/dev/null | head -1); [ -n "$S" ] && NIRI_SOCKET="$S" niri msg output DP-1 on'], timeout=5)
        log("Bildschirm am USB-C wieder eingeschaltet (nach der Panel-Anordnung)")
    return True

# ORIENTATION AS ONE TRUTH (02.11.2026, the owner: «booted in landscape but shown in portrait, then rotated;
# after login portrait again»): the last applied orientation is stored and written as a niri output file
# that the login AND the session include at start (device.kdl / matrix-anmeldung.kdl). Every stage thus starts
# right away; rotation happens only when the device is rotated.
ORIENT_KEEP = "/var/lib/duo/ausrichtung"
NIRI_KEEP = "/var/lib/duo/niri-ausgaenge.kdl"
NIRI_OUT = "/run/duo/niri-ausgaenge.kdl"
# 03.11.2026 (Settings > Display > Sizes): the display size. Only scales at which both panel dimensions
# (1350 x 1800) divide evenly, plus the proven 2.75 — otherwise the panels overlap by one point in the
# arithmetic -> «dsi FIFO UNDERFLOW», noise. Way back: delete the file = 2.75.
SCALE_FILE = MatrixSetting("display-scale")
SCALES = (2.25, 2.5, 2.75, 3.0)

def display_scale():
    try:
        v = float(open(SCALE_FILE).read().strip())
        if v in SCALES:
            return v
    except (OSError, ValueError):
        pass
    return 2.75

# 03.11.2026 (Settings > Display > Brightness): AUTOMATIC BRIGHTNESS. The light sensor (ssccli light) reports
# only changes (8-10 lux in the room). Curve in log(lux) like Android/iOS, panel 0 is written, light_thread
# mirrors to panel 1. If the human adjusts the brightness (slider, control centre, keys), the service learns the
# ratio to the curve (bias) and keeps to it.
AUTO_FILE = MatrixSetting("auto-brightness")
# The sensor reports ONLY changes, never an initial value (03.11.: on/off in steady light = no value, the
# automation stalled). Hence it always runs along while the panels are lit, and the last value is
# remembered: /run/duo/lux for the settings, /var/lib/duo/lux across reboots.
LUX_RUN = "/run/duo/lux"
# 03.11.2026 (Settings > Display > Rotation): rotation lock and fixed orientation from the Matrix settings
# (previously only gsettings orientation-lock from the GNOME era, which nobody sets under niri).
ROT_LOCK_FILE = MatrixSetting("rotation-lock")
# 04.11.2026 (deep sleep): REST REQUEST for all sensors. In deep sleep, orientation and hinge woke the chip right away
# through the sensor processor (smp2p-dsps + glink SLPI). While this file exists, the service ends all
# ssccli streams and restarts them only once it is gone (duo-schlaf creates and removes it).
SCHLAF = "/run/duo/schlaf"
ROT_FILE = MatrixSetting("rotation")
ORIENTS = ("normal", "left-up", "right-up", "bottom-up")

def rotation_wish():
    """the manually chosen orientation (only with rotation lock), otherwise None"""
    try:
        o = open(ROT_FILE).read().strip()
        return o if o in ORIENTS else None
    except OSError:
        return None

def rot_stamp():
    try:
        return os.stat(ROT_FILE).st_mtime
    except OSError:
        return None
LUX_KEEP = "/var/lib/duo/lux"
BIAS_FILE = MatrixSetting("auto-brightness-bias")
CURVE = ((0.0, 0.03), (10.0, 0.12), (100.0, 0.30), (1000.0, 0.65), (5000.0, 1.0))

def read_setting(name):
    """a Matrix setting of the user (~/.config/matrix/<name>), None if not set"""
    try:
        return open(MatrixSetting(name)).read().strip()
    except OSError:
        return None

def auto_on():
    try:
        return open(AUTO_FILE).read().strip() == "on"
    except OSError:
        return False

def curve(lux):
    import math
    x = math.log10(1.0 + max(lux, 0.0))
    pts = [(math.log10(1.0 + l), v) for l, v in CURVE]
    if x <= pts[0][0]:
        return pts[0][1]
    for (x0, v0), (x1, v1) in zip(pts, pts[1:]):
        if x <= x1:
            return v0 + (v1 - v0) * (x - x0) / (x1 - x0)
    return pts[-1][1]

class AutoLight:
    def __init__(self):
        try:
            self.lux = float(open(LUX_KEEP).read().strip())
        except (OSError, ValueError):
            self.lux = None
        self.written = None
        try:
            self.bias = min(4.0, max(0.25, float(open(BIAS_FILE).read().strip())))
        except (OSError, ValueError):
            self.bias = 1.0

    def seen(self, lux):
        """a new reading: remember and publish it"""
        self.lux = lux
        for path in (LUX_RUN, LUX_KEEP):
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path + ".neu", "w") as f:
                    f.write("%.0f" % lux)
                os.chmod(path + ".neu", 0o644)
                os.replace(path + ".neu", path)
            except OSError:
                pass

    def target(self, top):
        return int(round(min(1.0, curve(self.lux) * self.bias) * top))

    def tick(self):
        # A resting panel 0 (rest request) stays dark.
        if self.lux is None or "panel0" in rest_wanted():
            return
        top = read_int("/sys/class/backlight/panel0-backlight/max_brightness") or 255
        now = read_int(BL % "panel0")
        if now is None:
            return
        # Someone else adjusted it: learn instead of fighting.
        if self.written is not None and abs(now - self.written) > 2 and now > 0:
            base = curve(self.lux) * top
            if base > 0:
                self.bias = min(4.0, max(0.25, now / base))
                try:
                    with open(BIAS_FILE, "w") as f:
                        f.write("%.3f" % self.bias)
                except OSError:
                    pass
                log("Auto-Helligkeit: von Hand %d -> Bias %.2f" % (now, self.bias))
            self.written = now
            return
        goal = max(3, min(top, self.target(top)))
        if goal == now:
            self.written = now
            return
        step = max(1, int(abs(goal - now) * 0.25))
        new = now + step if goal > now else now - step
        write(BL % "panel0", new)
        self.written = new

def scale_stamp():
    try:
        return os.stat(SCALE_FILE).st_mtime
    except OSError:
        return None

def orient_load():
    try:
        o = open(ORIENT_KEEP).read().strip()
        return o if o in ("normal", "left-up", "right-up", "bottom-up", "tent") else "?"
    except OSError:
        return "?"   # never stored yet: the first orientation from the sensor is applied and stored

def klang(name):
    """A Duo sound (03.11.2026): the service runs as root and cannot reach the session's sound server —
    it leaves the name in /run/duo/klang, the session's matrix-sounds --hooks plays it (sound switches apply)."""
    try:
        os.makedirs(MUTE_DIR, exist_ok=True)
        tmp = os.path.join(MUTE_DIR, "klang.neu")
        with open(tmp, "w") as f:
            f.write(name)
        os.chmod(tmp, 0o644)
        os.replace(tmp, os.path.join(MUTE_DIR, "klang"))
    except OSError as e:
        log("klang: %s" % e)

def niri_transition(delay_ms):
    """niri's screen transition: freeze the current picture and blend softly into the new one. When rotating, one otherwise saw an
    intermediate picture in which wall and windows still had the old size (grey bar, video 02.11.2026)."""
    as_user(["sh", "-c", 'S=$(ls -t "$XDG_RUNTIME_DIR"/niri.*.sock 2>/dev/null | head -1); [ -n "$S" ] && NIRI_SOCKET="$S" niri msg action do-screen-transition --delay-ms %d' % delay_ms], timeout=3)

def underflows():
    """Round 121: how often the display driver reported «dsi FIFO UNDERFLOW» (the sign of noisy panels)."""
    try:
        out = subprocess.run(["dmesg"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.TimeoutExpired):
        return 0
    return out.count("FIFO UNDERFLOW")


def niri_action(action):
    r = as_user(["sh", "-c", 'S=$(ls -t "$XDG_RUNTIME_DIR"/niri.*.sock 2>/dev/null | head -1); [ -n "$S" ] && NIRI_SOCKET="$S" niri msg action %s' % action], timeout=5)
    return r.returncode == 0

# Sleep/wake the panels like the power button (duo-powerkey v4, 03.11.2026): the same marks in /run/duo, so that
# button and lid share the same truth. Touch muted (duoheat), niri power-off-monitors (DRM really off).
AUS = "/run/duo/aus"

def displays_sleep():
    for pnl in ("A", "B"):
        m = os.path.join(MUTE_DIR, "mute-" + pnl)
        if not os.path.exists(m):
            open(m, "w").close()
            open(os.path.join(MUTE_DIR, "aus-mute-" + pnl), "w").close()
    if niri_action("power-off-monitors"):
        open(AUS, "w").close()
        log("Panels aus (niri), Beruehrung stumm")

def displays_wake():
    niri_action("power-on-monitors")
    for pnl in ("A", "B"):
        own = os.path.join(MUTE_DIR, "aus-mute-" + pnl)
        if os.path.exists(own):
            for f in (own, os.path.join(MUTE_DIR, "mute-" + pnl)):
                try:
                    os.unlink(f)
                except OSError:
                    pass
    try:
        os.unlink(AUS)
    except OSError:
        pass
    # 05.11.2026: one panel in front — the back one stays deaf to touch (lifting our own sleep marks
    # also lifted the one-panel mute: the back panel answered touches).
    try:
        front = open(os.path.join(MUTE_DIR, "single")).read().strip()
        if front in ("DSI-1", "DSI-2"):
            mute("A" if front == "DSI-2" else "B", True)
    except OSError:
        pass

# DESK (05.11.2026): folded with a screen on USB-C, the Duo works like a closed laptop —
# both panels dark and deaf, no lock, no power-off-monitors (that switched the TV off too); bar and
# dock follow /run/duo/schreibtisch (mk::device::desk_screen) onto the screen. Setting «desk-closed» (off = lock and
# sleep as before). If the screen is disconnected while folded: lock and sleep normally.
DESK = os.path.join(MUTE_DIR, "schreibtisch")

def screen_plugged():
    """a screen on USB-C (DisplayPort) is connected"""
    for p in glob.glob("/sys/class/drm/card*-DP-*/status"):
        try:
            if open(p).read().strip() == "connected":
                return True
        except OSError:
            pass
    return False

def desk_wanted():
    return screen_plugged() and read_setting("desk-closed") != "off"

def desk(on):
    try:
        if on:
            open(DESK, "w").close()
            for pnl in ("A", "B"):   # deaf as when sleeping, with our own marks (displays_wake lifts them)
                m = os.path.join(MUTE_DIR, "mute-" + pnl)
                if not os.path.exists(m):
                    open(m, "w").close()
                    open(os.path.join(MUTE_DIR, "aus-mute-" + pnl), "w").close()
        elif os.path.exists(DESK):
            os.unlink(DESK)
    except OSError:
        pass

def desk_gather():
    """Desk: every open window onto the screen on USB-C, focus there (05.11.2026: Tube, settings
    and terminal stayed on the dark panels, new windows opened there)."""
    script = ('S=$(ls -t "$XDG_RUNTIME_DIR"/niri.*.sock 2>/dev/null | head -1); [ -n "$S" ] || exit 0; export NIRI_SOCKET="$S"; '
              'for id in $(niri msg -j windows | python3 -c "import json,sys; print(\' \'.join(str(w[\'id\']) for w in json.load(sys.stdin)))"); '
              'do niri msg action move-window-to-monitor --id $id DP-1; done; niri msg action focus-monitor DP-1')
    as_user(["sh", "-c", script], timeout=15)
    log("Schreibtisch: Fenster auf den Bildschirm, Fokus dort")

def niri_gather(front):
    """04.11.2026 (owner: «never both docks on one display»): in one-panel mode bring all windows to the front
    panel and focus it — under niri nobody followed /run/duo/single (only the GNOME extension read it),
    the windows stayed on the dark rear panel. Top bar and dock follow /run/duo/single themselves."""
    sock = 'S=$(ls -t "$XDG_RUNTIME_DIR"/niri.*.sock 2>/dev/null | head -1); [ -n "$S" ] && export NIRI_SOCKET="$S" && '
    r = as_user(["sh", "-c", sock + "niri msg -j windows && echo '#' && niri msg -j workspaces"], timeout=5)
    try:
        import json
        wins, wss = r.stdout.split("\n#\n", 1)
        on = {w["id"]: w.get("output") for w in json.loads(wss)}
        moved = 0
        for w in json.loads(wins):
            if on.get(w.get("workspace_id")) not in (None, front):
                as_user(["sh", "-c", sock + "niri msg action move-window-to-monitor --id %d %s" % (w["id"], front)], timeout=5)
                moved += 1
        as_user(["sh", "-c", sock + "niri msg action focus-monitor %s" % front], timeout=5)
        log("Ein-Panel %s: %d Fenster nach vorne geholt" % (front, moved))
    except (ValueError, KeyError) as e:
        log("Fenster holen: %s" % e)


def niri_out_publish():
    """the stored output file to /run/duo (at service start, before login/session)"""
    try:
        os.makedirs(MUTE_DIR, exist_ok=True)
        if os.path.exists(NIRI_KEEP):
            data = open(NIRI_KEEP).read()
            tmp = NIRI_OUT + ".neu"
            with open(tmp, "w") as f:
                f.write(data)
            os.chmod(tmp, 0o644)
            os.replace(tmp, NIRI_OUT)
    except OSError as e:
        log("Ausgabe-Datei: %s" % e)

def niri_capture(orient):
    """after a rotation: store orientation and outputs as niri shows them now (transform + position)"""
    import json
    r = as_user(["sh", "-c", 'S=$(ls -t "$XDG_RUNTIME_DIR"/niri.*.sock 2>/dev/null | head -1); [ -n "$S" ] && NIRI_SOCKET="$S" niri msg -j outputs'], timeout=5)
    try:
        outs = json.loads(r.stdout)
    except ValueError:
        log("niri-Ausgaben nicht lesbar (%s)" % (r.stderr.strip()[:80] or "leer")); return
    # 02.11.: NEVER take positions from niri — they belong to niri's scale (2.7583); with 2.75 in the file
    # the panels overlapped by 1 point -> «dsi FIFO UNDERFLOW», noise on both panels. So compute it ourselves:
    # side by side in the order niri shows, each panel as wide as it is at this scale (rounded up).
    import math
    scale = display_scale()
    placed = []
    for name in ("DSI-1", "DSI-2"):
        o = outs.get(name) or {}
        l = o.get("logical")
        modes, cur = o.get("modes") or [], o.get("current_mode")
        if not l or cur is None or cur >= len(modes):
            log("niri-Ausgabe %s unvollstaendig" % name); return
        t = str(l["transform"]).lower().replace("flipped", "flipped-").rstrip("-")
        w, h = modes[cur]["width"], modes[cur]["height"]
        quer = t.endswith("90") or t.endswith("270")
        # (width, height) logical: side by side the width counts, stacked the height
        placed.append((l["x"], name, t, math.ceil((h if quer else w) / scale), math.ceil((w if quer else h) / scale)))
    placed.sort()
    # 05.11.2026 (owner, mouse on the TV): in LANDSCAPE the panels are STACKED — the pointer must go from the
    # upper one down, not out to the side. Stacked like Mutter's layout: left-up/tent panel A
    # (DSI-1) on top, right-up panel B on top; each as high as it is at this scale (rounded up, without gaps).
    quer_all = all(t.endswith("90") or t.endswith("270") for _, _, t, _, _ in placed)
    if quer_all:
        order = ["DSI-2", "DSI-1"] if orient == "right-up" else ["DSI-1", "DSI-2"]
        placed.sort(key=lambda p: order.index(p[1]))
    lines = ["// geschrieben von duo-haltung: Lage %s (Transform wie niri, Positionen lueckenlos gerechnet)" % orient]
    x = 0
    for _, name, t, width, height in placed:
        # backdrop-color: what niri shows where (briefly) nothing lies — when rotating, until the wall is repainted. Without it, it was
        # niri's grey (grey bar, 02.11.2026); night blue goes unnoticed. Must stand HERE: the first block applies.
        pos = "x=0 y=%d" % x if quer_all else "x=%d y=0" % x
        lines.append('output "%s" {\n    scale %s\n    transform "%s"\n    position %s\n    backdrop-color "#070814"\n}' % (name, scale, t, pos))
        x += height if quer_all else width
    text = "\n".join(lines) + "\n"
    try:
        os.makedirs(os.path.dirname(NIRI_KEEP), exist_ok=True)
        tmp = NIRI_KEEP + ".neu"
        with open(tmp, "w") as f:
            f.write(text)
        # never publish a file niri would reject (a broken include discards the configuration)
        v = subprocess.run(["/usr/local/bin/niri-canvas", "validate", "-c", tmp], capture_output=True, text=True, timeout=10)
        if v.returncode != 0:
            log("Ausgabe-Datei ungueltig, verworfen: %s" % (v.stderr.strip()[-120:]))
            os.unlink(tmp); return
        os.chmod(tmp, 0o644)
        os.replace(tmp, NIRI_KEEP)
        with open(ORIENT_KEEP, "w") as f:
            f.write(orient)
    except (OSError, subprocess.SubprocessError) as e:
        log("Ausgabe-Datei: %s" % e); return
    niri_out_publish()
    log("Lage %s gespeichert (Anmeldung und Sitzung starten so)" % orient)

def panels_enabled():
    for c in ("DSI-1", "DSI-2"):
        try:
            if open("/sys/class/drm/card0-%s/enabled" % c).read().strip() == "enabled":
                return True
        except OSError:
            pass
    return False

# Folded sign (02.11.2026, Matrix Tube): /run/duo/zugeklappt exists while the device sleeps folded.
# Apps read it (mk::device::folded) — Tube then computes no more picture, the sound keeps playing.
FOLDED_FILE = os.path.join(MUTE_DIR, "zugeklappt")

def folded(on):
    try:
        if on:
            os.makedirs(MUTE_DIR, exist_ok=True)
            open(FOLDED_FILE, "w").close()
        elif os.path.exists(FOLDED_FILE):
            os.unlink(FOLDED_FILE)
    except OSError:
        pass


def wake():
    """Set PowerSaveMode 0 and check that at least one panel is really on again (Mutter loses a wake-up
    that arrives during switch-off) -> up to 4 attempts."""
    for attempt in range(4):
        power_save(0)
        for _ in range(25):
            if panels_enabled():
                panels_on()
                return True
            time.sleep(0.1)
        log("Wecken: Panels noch aus (Versuch %d)" % (attempt + 1))
        power_save(3); time.sleep(0.5)
    panels_on()
    return False

class Haltung:
    CLOSE_DELAY = 1.2   # s: CLOSED must last this long before sleeping (debouncing while folding)
    LAYOUT_DELAY = 1.5  # s: the desired layout must be stable this long (the sensor jumps LEFT<->RIGHT while rotating)
    LAYOUT_GAP = 4.0    # s: minimum gap between two Mutter switches (sde driver: WARN in sde_encoder_vsync_event_handler at 0.2 s)

    def __init__(self):
        self.asleep = False
        self.layout = "both"
        self.mutter = "both"
        self.last = None
        self.closed_since = None
        self.want = "both"
        self.want_since = 0.0
        self.last_apply = 0.0
        # the stored orientation: login and session already start that way (niri output file)
        self.orient = orient_load()
        self.want_orient = self.orient
        self.orient_since = 0.0
        self.session_user = None
        self.session_changed_at = None
        self.accel_fresh = True   # False after waking until a new orientation value arrives
        # 04.11. (leak hunt): a freshly started posture stream reports CLOSED first, fractions of a second later the
        # real posture (after every deep sleep). Until then CLOSED does not count as folding — otherwise a
        # delayed second value locks the device that was just woken.
        self.settle_until = 0.0

    def reapply(self):
        """after a session change (greeter <-> user): the new shell gets orientation, lights, dock, keyboard."""
        log("Sitzung %s: Ausrichtung %s / Anordnung %s neu anwenden" % (self.session_user, self.orient, self.layout))
        self.last_apply = time.monotonic()
        if self.orient not in ("normal", "?") or self.mutter != "both":
            if apply_monitors(self.mutter, self.orient if self.orient != "?" else "normal"):
                time.sleep(0.5)
                niri_capture(self.orient)
            time.sleep(0.5)
        self.lights(self.layout)
        self.dock(self.orient)
        self.keyboard_monitor()

    def tick(self):
        """call regularly: carry out pending sleep after the debounce time"""
        # Round 121: noise after unfolding? Then all panels off and on once.
        if getattr(self, "heal_at", 0.0) and time.monotonic() >= self.heal_at:
            self.heal_at = 0.0
            fresh = underflows() - getattr(self, "heal_mark", 0)
            if fresh >= 3:
                log("Panels rauschen nach dem Aufklappen (%d FIFO-Underflows) — alle aus und wieder an" % fresh)
                niri_action("power-off-monitors")
                time.sleep(1.5)
                niri_action("power-on-monitors")
        # Round 84: in one-panel mode the REAR panel stays dark — an off/on of all panels (power key,
        # power-on-monitor) switched its light back on (measured 04.11.: bl_power 4 -> 0).
        if self.layout in ("DSI-1", "DSI-2") and not self.asleep and not os.path.exists(AUS):
            back = "panel0" if self.layout == "DSI-2" else "panel1"
            now = time.monotonic()
            if now - getattr(self, "back_seen", 0.0) >= 1.0:
                self.back_seen = now
                try:
                    lit = open("/sys/class/backlight/%s-backlight/bl_power" % back).read().strip() != "4"
                except OSError:
                    lit = False
                if lit:
                    log("hinteres Panel %s leuchtete wieder - dunkel" % back)
                    panel_off(back)
        user = active_session()[0]
        if user != self.session_user:
            self.session_user = user
            self.session_changed_at = time.monotonic()
        # 02.11.: niri already starts in the stored orientation -> no longer wait 12 s (GNOME start animation)
        if self.session_changed_at and time.monotonic() - self.session_changed_at >= 2.0:
            self.session_changed_at = None
            self.reapply()
        if hasattr(self, "flat_since") and time.monotonic() - self.flat_since >= 1.0:
            self.keyboard_monitor()
        if self.settle_until and time.monotonic() >= self.settle_until:
            self.settle_until = 0.0
            if self.last == 0 and self.closed_since is None and not self.asleep:
                self.closed_since = time.monotonic()   # stayed closed: now debounce normally
        # Desk: disconnected while folded -> now lock and sleep as usual.
        if getattr(self, "desk", False) and self.asleep and not screen_plugged():
            log("Schreibtisch: Bildschirm getrennt -> sperren + Panels aus")
            self.desk = False
            desk(False)
            panels_dark(); lock_session(); displays_sleep(); SLEEPING.set(); folded(True)
        if self.closed_since and not self.asleep and time.monotonic() - self.closed_since >= self.CLOSE_DELAY and desk_wanted():
            log("zugeklappt mit Bildschirm am USB-C -> Schreibtisch: Duo dunkel, alles auf dem Bildschirm")
            klang("21-zuklappen")
            panels_dark(); desk(True); self.asleep = True; self.desk = True
            desk_gather()
        if self.closed_since and not self.asleep and time.monotonic() - self.closed_since >= self.CLOSE_DELAY:
            log("zugeklappt -> sperren + Panels aus")
            klang("21-zuklappen")
            panels_dark(); lock_session(); displays_sleep(); self.asleep = True; SLEEPING.set(); folded(True)
        if not self.asleep and self.want != self.layout and time.monotonic() - self.want_since >= self.LAYOUT_DELAY \
           and time.monotonic() - self.last_apply >= self.LAYOUT_GAP:
            self.switch(self.want)
        elif not self.asleep and self.accel_fresh and self.want_orient != self.orient \
           and time.monotonic() - self.orient_since >= self.ORIENT_DELAY \
           and time.monotonic() - self.last_apply >= self.ORIENT_GAP and self.layout == "both":
            if self.orientation_locked():
                self.orient_seen = self.want_orient   # locked: only remember, do not rotate
                self.want_orient = self.orient
                return
            self.rotate(self.want_orient)
        # Manually chosen orientation (settings, only with rotation lock): apply immediately.
        stamp = rot_stamp()
        if stamp != getattr(self, "rot_seen", None):
            self.rot_seen = stamp
            manual = rotation_wish()
            if manual and self.orientation_locked() and manual != self.orient and not self.asleep and self.layout == "both":
                log("Ausrichtung von Hand -> %s" % manual)
                self.want_orient = manual
                self.rotate(manual)

    def rotate(self, target):
        """rotates both panels to `target` — sound, announcement to the shell, cross-fade, save outputs"""
        log("Ausrichtung -> %s" % target)
        klang("22-drehen")
        self.last_apply = time.monotonic()
        # announce the shell extension's rotation animation: "<old> <new>" as Mutter transform, then wait briefly (stage picture)
        T = {"normal": 0, "left-up": 1, "bottom-up": 2, "right-up": 3, "tent": 1}
        os.makedirs(MUTE_DIR, exist_ok=True)
        with open(os.path.join(MUTE_DIR, "rotate"), "w") as f:
            f.write("%d %d" % (T.get(self.orient, 0), T[target]))
        time.sleep(0.25)
        # freeze, rotate, cross-fade softly: the intermediate picture with the old size stays invisible
        niri_transition(900)   # 400 was not enough: wall and windows needed longer (video 23:41)
        if apply_monitors(self.mutter, target):
            self.orient = target
            time.sleep(0.7)            # rebuild the dock only after the rotation animation (Dash-to-Dock visibly rebuilds itself)
            niri_capture(self.orient)
            self.dock(self.orient)
            self.keyboard_monitor()

    ORIENT_DELAY = 0.8    # s: a new orientation must hold this long
    ORIENT_GAP = 2.5      # s: minimum gap between rotations (transform only, no connector switching)
    ORIENT_G = 4.5        # m/s^2: the axis must pull this strongly (otherwise the device lies flat -> keep the orientation)

    TENT = (8, 14, 15, 16)   # TENT_RIGHT/LEFT and RAMP_RIGHT/LEFT: the same fold (the sensor jumps between both)

    def on_accel(self, x, y, z):
        """Orientation from gravity: +Y = up (upright), X<0 = panel A on top (left-up), X>0 = panel B on top (right-up).
        The sensor sits in panel B. If it lies flat (laptop posture: B on the table, A raised) and the posture is
        landscape (OPEN_DUAL_LANDSCAPE/COMPOSE), then A is on top -> left-up."""
        if not self.accel_fresh:
            self.accel_fresh = True
            self.orient_since = time.monotonic()
        self.az = z   # the sensor sits in panel B: z > 0 = screen B faces up (towards the user)
        if self.last in self.TENT:
            return   # in tent posture the posture determines the orientation
        if self.last in SINGLE_RIGHT or self.last in SINGLE_LEFT:
            want = self.front_panel(self.last)
            if want != self.want:
                self.want = want
                self.want_since = time.monotonic()
        flat = max(abs(x), abs(y)) < self.ORIENT_G
        if flat != getattr(self, "flat", None):
            self.flat = flat
            self.flat_since = time.monotonic()
        if self.flat:
            if self.last in (3, 4, 6) and self.want_orient != "left-up":
                self.want_orient = "left-up"
                self.orient_since = time.monotonic()
            return
        if abs(y) >= abs(x):
            o = "normal" if y > 0 else "bottom-up"
        else:
            o = "left-up" if x < 0 else "right-up"
        if o != self.want_orient:
            self.want_orient = o
            self.orient_since = time.monotonic()

    def keyboard_monitor(self):
        """Laptop posture (sensor in B flat, A on top): keyboard on the lower panel B; otherwise GNOME behaviour."""
        path = os.path.join(MUTE_DIR, "keyboard")
        want = "DSI-2" if (getattr(self, "flat", False) and self.orient == "left-up" and self.layout == "both") else None
        try:
            cur = open(path).read().strip() if os.path.exists(path) else None
        except OSError:
            cur = None
        if want == cur:
            return
        os.makedirs(MUTE_DIR, exist_ok=True)
        if want:
            with open(path, "w") as f:
                f.write(want)
            log("Tastatur -> %s (Laptop-Haltung)" % want)
        else:
            os.unlink(path)
            log("Tastatur -> GNOME-Vorgabe")

    def dock(self, orient):
        """Dash-to-Dock: in landscape only on the lower panel, in portrait on both (user session only)."""
        if active_session()[0] != person()[0]:
            return
        if os.environ.get("DUO_DOCK_SWITCH", "0") != "1":
            return   # 30.10.: suspicion that the dock rebuild (Dash-to-Dock) breaks the shell display -> off for now
        if orient in ("left-up", "right-up"):
            lower = "DSI-2" if orient == "left-up" else "DSI-1"
            as_user(["gsettings", "set", "org.gnome.shell.extensions.dash-to-dock", "preferred-monitor-by-connector", lower], timeout=5)
            as_user(["gsettings", "set", "org.gnome.shell.extensions.dash-to-dock", "multi-monitor", "false"], timeout=5)
        else:
            as_user(["gsettings", "set", "org.gnome.shell.extensions.dash-to-dock", "preferred-monitor-by-connector", "primary"], timeout=5)
            as_user(["gsettings", "set", "org.gnome.shell.extensions.dash-to-dock", "multi-monitor", "true"], timeout=5)

    def orientation_locked(self):
        try:
            v = open(ROT_LOCK_FILE).read().strip()
            if v in ("on", "off"):
                return v == "on"
        except OSError:
            pass
        r = as_user(["gsettings", "get", "org.gnome.settings-daemon.peripherals.touchscreen", "orientation-lock"], timeout=5)
        return r.returncode == 0 and "true" in r.stdout

    def front_panel(self, state):
        """Which panel faces the user? The firmware posture (FLIP_*_RIGHT/LEFT) mixes up the sides depending on the
        folding direction; what counts is gravity at the sensor in panel B: z > 3 = B on top, z < -3 = A on top.
        Only when the device is held upright (|z| small) does the firmware apply."""
        az = getattr(self, "az", 0.0)
        if az > 3.0:
            return "DSI-2"
        if az < -3.0:
            return "DSI-1"
        # Upright/sideways in the hand (|z| small): the firmware then jumps back and forth between RIGHT and LEFT.
        # If a panel is already active, it stays active; only at the first fold-back does the firmware apply.
        if self.layout in ("DSI-1", "DSI-2"):
            return self.layout
        return "DSI-2" if state in SINGLE_RIGHT else "DSI-1"

    def lights(self, want):
        """Light/touch/mirror per mode; /run/duo/single tells top bar, dock and keyboard which panel is in front."""
        mute("A", want == "DSI-2"); mute("B", want == "DSI-1")
        single = os.path.join(MUTE_DIR, "single")
        if want == "both":
            if os.path.exists(single):
                os.unlink(single)
            # Round 84: the rear panel was fully off via niri-canvas 0017 -> on again (all panels off/on once,
            # first-light order). Only if we switched it off.
            # Always ask for both (for a running panel niri does nothing) — also after a restart of this service,
            # which did not remember the switched-off panel.
            for out in ("DSI-1", "DSI-2"):
                niri_action("power-on-monitor %s" % out)
            self.dark_output = None
            blmirror(True); panels_on()
            # Round 121 (05.11.2026): unfolded, both panels showed noise — the kernel woke DSI_1 before DSI_0
            # (dsi FIFO UNDERFLOW in series). Self-healing: check 2.5 s later; if there is noise, all panels off and
            # on again in the proven order (the power button's route, which fixed it on the device).
            self.heal_at = time.monotonic() + 2.5
            self.heal_mark = underflows()
        else:
            blmirror(False)
            panel_on(PANEL_OF[want]); panel_off("panel0" if want == "DSI-2" else "panel1")
            os.makedirs(MUTE_DIR, exist_ok=True)
            with open(single, "w") as f:
                f.write(want)
            niri_gather(want)
            # Round 84 (owner: «switch the rear display off too?»): like Android, the rear panel fully off —
            # CRTC inactive, niri no longer draws it (niri-canvas 0017). Switch ~/.config/matrix/back-panel-off.
            back = "DSI-1" if want == "DSI-2" else "DSI-2"
            if read_setting("back-panel-off") == "on" and getattr(self, "dark_output", None) != back:
                if getattr(self, "dark_output", None):
                    niri_action("power-on-monitor %s" % self.dark_output)
                niri_action("power-off-monitor %s" % back)
                self.dark_output = back
                log("hinteres Panel %s ganz aus" % back)

    def switch(self, want):
        """One-panel mode WITHOUT switching off a connector (sde driver: noise/white when switching back on):
        both panels stay active in Mutter, only the main panel changes; the rear one goes dark + touch-muted."""
        log("Anordnung -> %s" % want)
        if want in ("DSI-1", "DSI-2") and self.layout == "both":
            klang("23-ein-panel")
        self.last_apply = time.monotonic()
        mutter = "both-B" if want == "DSI-2" else "both"
        if mutter != self.mutter:
            if not apply_monitors(mutter, self.orient):
                return
            self.mutter = mutter
            time.sleep(1.0)
        self.layout = want
        self.lights(want)

    CLOSED_ANGLE = 6.0   # degrees: PEEK with a smaller hinge angle counts as closed (the Hall sensor wrongly reports FAR)
    OPEN_ANGLE = 12.0

    def on_angle(self, angle):
        self.angle = angle
        if self.last in (0, 1, 2):
            if angle < self.CLOSED_ANGLE and self.closed_since is None and not self.asleep:
                log("Spalt %.1f Grad -> gilt als zu" % angle)
                self.closed_since = time.monotonic()
            elif angle > self.OPEN_ANGLE and self.closed_since is not None and self.last != 0:
                log("Spalt %.1f Grad -> wieder offen" % angle)
                self.closed_since = None

    def on_state(self, state):
        name = NAMES.get(state, str(state))
        if state == self.last:
            return
        log("Haltung %d %s" % (state, name))
        self.last = state
        # Tent: the orientation follows the posture, not gravity (which only panel B sees)
        if state in self.TENT and self.want_orient != "tent":
            self.want_orient = "tent"
            self.orient_since = time.monotonic()
        if state in (1, 2) and getattr(self, "angle", 90.0) < self.CLOSED_ANGLE:
            state = 0
        if state == 0:
            if time.monotonic() < self.settle_until:
                log("CLOSED im Anlauf des Sensors - abwarten")
                return
            if self.closed_since is None:
                self.closed_since = time.monotonic()
            return
        self.closed_since = None
        if self.asleep:
            log("aufgeklappt -> wecken")
            klang("20-aufklappen")
            self.asleep = False
            if getattr(self, "desk", False):
                log("Schreibtisch endet")
                self.desk = False
                desk(False)
            SLEEPING.clear(); folded(False)
            # the last orientation comes from folding: rotate only after a fresh reading (otherwise briefly up and back)
            self.accel_fresh = False
            self.want_since = time.monotonic()   # after waking, let the posture settle first
            displays_wake()
            if not wake():
                log("Wecken fehlgeschlagen")
            self.lights(self.layout)
        if state == 99:
            return
        if state in (3, 4, 6) and getattr(self, "flat", False) and self.want_orient != "left-up":
            self.want_orient = "left-up"
            self.orient_since = time.monotonic()
        want = self.front_panel(state) if (state in SINGLE_RIGHT or state in SINGLE_LEFT) else "both"
        if want != self.want:
            self.want = want
            self.want_since = time.monotonic()

def main():
    niri_out_publish()   # first: the login should already start in the stored orientation
    blmirror(False)
    folded(False)   # an old sign from the last run
    desk(False)
    threading.Thread(target=light_thread, daemon=True).start()
    h = Haltung()
    child = [None]
    def ende(*a):
        sys.exit(0)
    signal.signal(signal.SIGTERM, ende)
    scale_seen = [scale_stamp()]
    auto = AutoLight()
    auto_was = [False]
    while True:
        if os.path.exists(SCHLAF):
            log("Schlaf-Bitte: Sensoren ruhen")
            while os.path.exists(SCHLAF):
                time.sleep(0.5)
            log("Schlaf-Bitte vorbei: Sensoren wieder an")
        log("starte ssccli posture")
        h.settle_until = time.monotonic() + 2.0
        p = subprocess.Popen(["ssccli", "--sensor", "posture", "--timeout", "864000"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        child[0] = p
        q = subprocess.Popen(["ssccli", "--sensor", "hinge_angle", "--timeout", "864000"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        def accel_start():
            c = subprocess.Popen(["ssccli", "--sensor", "accelerometer", "--timeout", "864000"], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True)
            sel.register(c.stdout, selectors.EVENT_READ, "accel")
            return c

        def accel_stop(c):
            try:
                sel.unregister(c.stdout)
            except (KeyError, ValueError):
                pass
            if c.poll() is None:
                c.terminate()
            c.wait()
        import selectors
        sel = selectors.DefaultSelector(); sel.register(p.stdout, selectors.EVENT_READ, "posture"); sel.register(q.stdout, selectors.EVENT_READ, "angle")
        a = accel_start()
        lightp = None
        def light_start():
            c = subprocess.Popen(["ssccli", "--sensor", "light", "--timeout", "864000"], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True)
            sel.register(c.stdout, selectors.EVENT_READ, "light")
            return c
        try:
            # Round 103 (04.11.2026): the housekeeping (check children, files, settings) ran for EVERY
            # sensor line — the accelerometer delivers ~25 per second: 14 % of a core around the clock,
            # 1300 syscalls/s. Now: lines immediately, housekeeping 3x/s, tick() 10x/s.
            house_at = tick_at = 0.0
            dark = h.asleep or os.path.exists(AUS)
            while True:
                now = time.monotonic()
                if now >= house_at:
                    house_at = now + 0.3
                    if p.poll() is not None or q.poll() is not None or os.path.exists(SCHLAF):
                        break
                    # folded, no orientation is needed: accelerometer off, on again when unfolding (31.10.)
                    # 03.11.: likewise with panels off via the power button (/run/duo/aus) — nobody sees a rotation; the
                    # hinge sensor stays on so that folding in the dark is detected.
                    dark = h.asleep or os.path.exists(AUS)
                    if dark and a is not None:
                        accel_stop(a); a = None
                        log("Beschleunigungssensor aus (Panels dunkel)")
                    elif not dark and a is None:
                        a = accel_start()
                        log("Beschleunigungssensor an")
                    elif a is not None and a.poll() is not None:
                        accel_stop(a); a = accel_start()
                    # Light sensor: always, while someone is looking (it reports only changes — whoever starts it only when
                    # switching on the automation waits forever for the first value in steady light).
                    if not dark and lightp is None:
                        lightp = light_start()
                    elif dark and lightp is not None:
                        accel_stop(lightp); lightp = None
                    elif lightp is not None and lightp.poll() is not None:
                        accel_stop(lightp); lightp = light_start()
                    want_auto = auto_on()
                    if want_auto != auto_was[0]:
                        auto_was[0] = want_auto
                        auto.written = None
                        log("Auto-Helligkeit %s (zuletzt %s Lux)" % ("an" if want_auto else "aus", auto.lux))
                    # Display size changed (settings): rewrite the output file with the new scale —
                    # niri reloads the include by itself.
                    stamp = scale_stamp()
                    if stamp != scale_seen[0]:
                        scale_seen[0] = stamp
                        log("Anzeigegroesse %s gewuenscht" % display_scale())
                        niri_capture(h.orient)
                for key, _ in sel.select(0.3):
                    line = key.fileobj.readline()
                    if not line:
                        continue
                    try:
                        if key.data == "posture" and line.startswith("Posture sensor measurement:"):
                            h.on_state(int(line.split()[3]))
                        elif key.data == "angle" and line.startswith("Hinge angle sensor measurement:"):
                            h.on_angle(float(line.split()[4]))
                        elif key.data == "light" and line.startswith("Light sensor measurement:"):
                            auto.seen(float(line.split()[3]))
                        elif key.data == "accel" and line.startswith("Accelerometer sensor measurement:"):
                            f = line.split()
                            h.on_accel(float(f[3][2:]), float(f[4][2:]), float(f[5][2:]))
                    except (ValueError, IndexError):
                        pass
                if now >= tick_at:
                    tick_at = now + 0.1
                    h.tick()
                    if auto_was[0] and not dark:
                        auto.tick()
        finally:
            sel.close()
            for c in (p, q, a, lightp):
                if c is not None:
                    if c.poll() is None:
                        c.terminate()
                    c.wait()
        if os.path.exists(SCHLAF):
            continue
        log("ssccli beendet (rc %s), neu in 3 s" % p.returncode)
        time.sleep(3)

if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--layout":
        h = Haltung(); h.mutter = "?"
        h.switch(sys.argv[2])
        sys.exit(0 if h.layout == sys.argv[2] else 1)
    main()
