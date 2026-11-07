#!/usr/bin/python3
# duo-bildton (05.11.2026): sound through the screen on USB-C (DisplayPort/HDMI).
#
# Measured on the Panasonic TV: the second playback stream MultiMedia2 (hw:0,1) routed to «DISPLAY_PORT Mixer MultiMedia2»,
# format 2 channels / S16_LE / 48 kHz, plays from the TV — even though the driver refuses «External Display Type» and
# «External Display Audio Ack» (DP reports «audio notify not defined»). MultiMedia1 stays with the speaker
# (PipeWire, 53-duo-alsa-nodes.conf).
#
# Flow: every 2 s /sys/class/drm/card0-DP-1/status. Connected -> set the routes, load the PipeWire sink «Fernseher»
# (module-alsa-sink on hw:0,1) and make it the default (like Android). Disconnected -> unload the sink (PipeWire
# moves the streams back to the speaker), route off. Nothing is written except mixer values.
import os, subprocess, time

# Settings (Matrix Settings › Display › Screen on USB-C), ~/.config/matrix/<name>:
#   desk-resolution  1080p (default, 60 Hz) | 4k (30 Hz: only 2 lanes)
#   desk-scale       1 | 1.5 (default) | 2
#   desk-sound       on (default) | off — sound through the screen
CONF = os.path.expanduser("~/.config/matrix/")
MODES = {"1080p": "1920x1080@60", "4k": "3840x2160@30"}

STATUS = "/sys/class/drm/card0-DP-1/status"
SINK = "duo_fernseher"
MIXER = [
    ("Display Port RX Channels", "Two"),
    ("Display Port RX Bit Format", "S16_LE"),
    ("Display Port RX SampleRate", "KHZ_48"),
    ("DISPLAY_PORT Mixer MultiMedia2", "1"),
]


def log(msg):
    print("duo-bildton: " + msg, flush=True)


def connected():
    try:
        with open(STATUS) as f:
            return f.read().strip() == "connected"
    except OSError:
        return False


def amixer(name, value):
    r = subprocess.run(["amixer", "-c", "0", "cset", "name=" + name, value], capture_output=True, text=True)
    if r.returncode != 0:
        log("Mischer %s=%s: %s" % (name, value, r.stderr.strip()[:120]))


def pactl(*args):
    return subprocess.run(["pactl"] + list(args), capture_output=True, text=True, timeout=10)


def module_id():
    r = pactl("list", "modules", "short")
    for line in r.stdout.splitlines():
        if "sink_name=" + SINK in line:
            return line.split()[0]
    return None


def notice(title, body):
    # A short notification: where the sound goes now.
    subprocess.run(["notify-send", "-a", "Ton", "-i", "video-display", title, body], capture_output=True, timeout=5)


def setting(name, default):
    try:
        return open(CONF + name).read().strip() or default
    except OSError:
        return default


def stamp():
    out = []
    for name in ("desk-resolution", "desk-scale", "desk-sound"):
        try:
            out.append(os.stat(CONF + name).st_mtime)
        except OSError:
            out.append(0)
    return tuple(out)


def niri(*args):
    run = os.environ.get("XDG_RUNTIME_DIR", "/run/user/1000")
    socks = sorted((os.path.join(run, f) for f in os.listdir(run) if f.startswith("niri.") and f.endswith(".sock")),
                   key=os.path.getmtime, reverse=True)
    if not socks:
        return False
    env = dict(os.environ, NIRI_SOCKET=socks[0])
    return subprocess.run(["niri", "msg"] + list(args), env=env, capture_output=True, timeout=10).returncode == 0


def niri_out(*args):
    run = os.environ.get("XDG_RUNTIME_DIR", "/run/user/1000")
    socks = sorted((os.path.join(run, f) for f in os.listdir(run) if f.startswith("niri.") and f.endswith(".sock")),
                   key=os.path.getmtime, reverse=True)
    if not socks:
        return ""
    env = dict(os.environ, NIRI_SOCKET=socks[0])
    return subprocess.run(["niri", "msg"] + list(args), env=env, capture_output=True, text=True, timeout=10).stdout


def switched_off():
    """DP-1 is plugged in, but niri switched it off (05.11.2026: duo-haltung's panel arrangement did that)"""
    import json
    try:
        o = json.loads(niri_out("-j", "outputs") or "{}").get("DP-1")
    except ValueError:
        return False
    return o is not None and o.get("logical") is None


def picture():
    mode = MODES.get(setting("desk-resolution", "1080p"), MODES["1080p"])
    scale = setting("desk-scale", "1.5")
    niri("output", "DP-1", "mode", mode)
    niri("output", "DP-1", "scale", scale)
    log("Bild: %s, Skalierung %s" % (mode, scale))


def up(first=True):
    picture()
    if setting("desk-sound", "on") == "off":
        down(quiet=True)
        log("Ton über den Bildschirm ausgeschaltet (Einstellung)")
        return True
    for name, value in MIXER:
        amixer(name, value)
    if module_id() is None:
        r = pactl("load-module", "module-alsa-sink", "device=hw:0,1", "sink_name=" + SINK,
                  "rate=48000", "channels=2", "format=s16le",
                  "sink_properties=device.description=Fernseher node.nick=Fernseher")
        if r.returncode != 0:
            log("Senke nicht geladen: " + r.stderr.strip()[:160])
            return False
    pactl("set-default-sink", SINK)
    log("Bildschirm verbunden -> Ton auf «Fernseher»")
    if first:
        notice("Ton über den Fernseher", "Beim Ausstecken spielt wieder der Lautsprecher.")
    return True


def down(quiet=False):
    mid = module_id()
    if mid:
        pactl("unload-module", mid)
    amixer("DISPLAY_PORT Mixer MultiMedia2", "0")
    if quiet:
        return
    log("Bildschirm getrennt -> Ton zurück zum Lautsprecher")
    notice("Ton über den Lautsprecher", "Der Bildschirm am USB-C ist getrennt.")


def main():
    was = None
    seen = stamp()
    guard_tick = 0
    while True:
        now = connected()
        # Watchdog: the screen is plugged in but off in the compositor -> back on, with resolution and scale.
        # 05.11.2026: every 10 s instead of on every 2 s tick (niri msg costs each time).
        guard_tick = (guard_tick + 1) % 5
        if now and was and guard_tick == 0 and switched_off():
            log("Bildschirm war ausgeschaltet -> wieder an")
            niri("output", "DP-1", "on")
            time.sleep(1)
            picture()
        # A setting changed while the screen is plugged in: apply it at once.
        if now and was and stamp() != seen:
            seen = stamp()
            up(first=False)
        if now != was:
            # Wait briefly: the DisplayPort first trains the link, PipeWire needs time at session start.
            time.sleep(2)
            now = connected()
            if now:
                was = True if up() else None
            else:
                if was:
                    down()
                was = False
        time.sleep(2)


if __name__ == "__main__":
    main()
