#!/usr/bin/python3
"""duo-schlaf: deep sleep (suspend-to-RAM) for the Surface Duo (04.11.2026).

The power key only darkens the panels (duo-powerkey, /run/duo/aus); niri no longer suspends on it
(disable-power-key-handling). This service decides: panels dark for DELAY seconds and nothing that a
sleep would break -> prepare and suspend; the power key wakes, duo-powerkey lights the panels.

Proven sequence (GRABUNG-DUO-TIEFSCHLAF.md, stage 3d):
  1. sensor rest request /run/duo/schlaf (duo-haltung closes every ssccli stream; SLPI woke the chip)
  2. stop duo-bt (an open BT UART refuses suspend_noirq with -EBUSY)
  3. `systemctl suspend` (logind lets NetworkManager put WLAN to sleep; a bare `echo mem` aborted)
  4. after waking: lift the rest request, start duo-bt again
Never while: a cable is in (dwc3), sound plays (ADSP or Bluetooth), an SSH session is open (dev access),
the Duo is folded (unfolding cannot wake it yet: the posture sensors rest), or the setting is "off".

Setting: ~/.config/matrix/deep-sleep ("off" disables), ~/.config/matrix/deep-sleep-delay (seconds, default 60).
Every attempt is logged to /var/lib/duo/schlaf.log with the per-island sleep shares (CXSD hunt).
"""
import glob
import os
import re
import subprocess
import time


# Morpheus (06.11.2026): the device's account — no longer hard-wired to «mobile». Uid 1000 is the first account on
# every Matrix device (first setup creates it); name and home are looked up on EVERY use, because
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


DARK = "/run/duo/aus"
FOLDED = "/run/duo/zugeklappt"
REST = "/run/duo/schlaf"
SETTING = MatrixSetting("deep-sleep")
DELAY_FILE = MatrixSetting("deep-sleep-delay")
LOG = "/var/lib/duo/schlaf.log"
STATS = "/sys/kernel/debug/suspend_stats"
MASTERS = "/sys/power/rpmh_stats/master_stats"
SOC = "/sys/power/system_sleep/stats"
QTIMER_HZ = 19.2e6


def log(msg):
    print("duo-schlaf: " + msg, flush=True)


def note(line):
    try:
        with open(LOG, "a") as f:
            f.write(time.strftime("%d.%m. %H:%M:%S ") + line + "\n")
        if os.path.getsize(LOG) > 400_000:      # keep the last 2000 attempts
            with open(LOG) as f:
                rest = f.readlines()[-2000:]
            with open(LOG + ".neu", "w") as f:
                f.writelines(rest)
            os.replace(LOG + ".neu", LOG)
    except OSError:
        pass


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def run(*cmd, timeout=10):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def as_user(*cmd):
    sock = sorted(glob.glob("/run/user/1000/niri.*.sock"), key=os.path.getmtime)
    env = ["XDG_RUNTIME_DIR=/run/user/1000", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"]
    if sock:
        env.append("NIRI_SOCKET=" + sock[-1])
    return run("runuser", "-u", person()[0] or "nobody", "--", "env", *env, *cmd)


def enabled():
    return read(SETTING, "on").lower() not in ("off", "aus", "0", "false")


def delay():
    try:
        return max(20, int(read(DELAY_FILE, "60")))
    except ValueError:
        return 60


def counts():
    """suspend_stats success/fail (debugfs, 4.14 has no sysfs copy)"""
    text = read(STATS)
    get = lambda k: int(m.group(1)) if (m := re.search(r"^%s:\s*(\d+)" % k, text, re.M)) else -1
    return get("success"), get("fail")


def masters():
    """accumulated sleep per RPMh master (APSS, MPSS, ADSP, SLPI, ...) in seconds"""
    out, name = {}, None
    for line in read(MASTERS).splitlines():
        line = line.strip()
        if line and ":" not in line:
            name = line
        elif name and line.startswith("Sleep Accumulated Duration:"):
            out[name] = int(line.split(":")[1], 16) / QTIMER_HZ
    return out


def soc_modes():
    text = read(SOC)
    return " ".join("%s=%s" % (m, c) for m, c in re.findall(r"RPM Mode:(\w+)\s*\n\s*count:(\d+)", text))


def bt_audio():
    """a Bluetooth A2DP/HFP transport is streaming (BlueZ on the system bus — no user switch: runuser left
    two PAM lines in the journal every 5 s while the panels were dark and something blocked)"""
    for path in run("busctl", "--system", "--list", "tree", "org.bluez").split():
        if "/fd" in path:
            state = run("busctl", "--system", "get-property", "org.bluez", path, "org.bluez.MediaTransport1", "State")
            if "active" in state:
                return True
    return False


def blocker():
    """the first reason not to sleep, or None (cheap checks first)"""
    if os.path.exists(FOLDED):
        return "zugeklappt"
    if read("/sys/class/power_supply/usb/online", "0") == "1":
        return "Kabel"
    # 05.11.2026: a screen on USB-C (TV, desk) — the DisplayPort link would not survive a deep sleep cleanly.
    for status in glob.glob("/sys/class/drm/card*-DP-*/status"):
        if read(status).strip() == "connected":
            return "Bildschirm am USB-C"
    for status in glob.glob("/proc/asound/card*/pcm*p/sub*/status"):
        if "RUNNING" in read(status):
            return "Ton (ADSP)"
    if run("ss", "-Htn", "state", "established", "( sport = :22 )").strip():
        return "SSH"
    if bt_audio():
        return "Ton (Bluetooth)"
    return None


def sensors_quiet(limit=10.0):
    end = time.monotonic() + limit
    while time.monotonic() < end:
        if not run("pgrep", "-x", "ssccli").strip():
            return True
        time.sleep(0.5)
    return False


def sleep_once():
    """prepare, suspend, restore. Returns 'slept', 'aborted' or 'skipped'."""
    open(REST, "w").close()
    run("systemctl", "stop", "duo-bt.service", timeout=20)
    if not sensors_quiet():
        log("Sensoren ruhen nicht -> kein Schlaf")
        restore()
        return "skipped"
    time.sleep(2)
    if not os.path.exists(DARK) or blocker():
        restore()                      # the human came back meanwhile
        return "skipped"
    s0, f0 = counts()
    m0, modes0, t0 = masters(), soc_modes(), time.monotonic()
    charge0 = read("/sys/class/power_supply/battery/charge_counter")
    wall0 = time.time()
    os.sync()
    run("systemctl", "suspend")
    # systemctl returns at once: wait until the kernel counted the attempt (the process freezes meanwhile)
    end = time.monotonic() + 90
    while time.monotonic() < end and counts() == (s0, f0):
        time.sleep(0.5)
    s1, f1 = counts()
    restore()
    slept = s1 > s0
    asleep = time.time() - wall0 - (time.monotonic() - t0)   # wall clock runs on in suspend, monotonic not
    m1 = masters()
    share = " ".join("%s %.0f%%" % (k, 100 * (m1[k] - m0.get(k, 0)) / max(asleep, 1)) for k in m1) if slept else ""
    # the kernel log since the LAST suspend entry (counting lines failed: the ring buffer rotates)
    kern = run("dmesg").splitlines()
    start = max((i for i, l in enumerate(kern) if "PM: suspend entry" in l), default=len(kern))
    cause = " | ".join(l.split("]", 1)[-1].strip() for l in kern[max(0, start - 3):]
                       if "Resume caused" in l or "last active wakeup" in l or "failed to suspend" in l)[:300]
    # the charge before > after (µAh): mk::power::sleep_today turns it into the draw while asleep
    charge1 = read("/sys/class/power_supply/battery/charge_counter")
    akku = "akku=%s>%s" % (charge0, charge1) if charge0.isdigit() and charge1.isdigit() else ""
    note("%s %.0f s | %s -> %s | %s | %s | %s" % ("GESCHLAFEN" if slept else "abgebrochen", asleep, modes0, soc_modes(), share, akku, cause))
    log("%s nach %.0f s (%s)" % ("aufgewacht" if slept else "abgebrochen", asleep, cause or "?"))
    return "slept" if slept else "aborted"


def restore():
    try:
        os.unlink(REST)
    except FileNotFoundError:
        pass
    run("systemctl", "start", "--no-block", "duo-bt.service")


def main():
    if os.path.exists(REST):          # a crash mid-sleep must not leave the sensors resting
        restore()
    dark_since, retry_at, misses, last_block = None, 0.0, 0, None
    log("bereit (Verzögerung %d s)" % delay())
    while True:
        time.sleep(5)
        now = time.monotonic()
        if not os.path.exists(DARK) or not enabled():
            dark_since, misses, last_block = None, 0, None
            continue
        if dark_since is None:
            dark_since = now
        if now - dark_since < delay() or now < retry_at:
            continue
        why = blocker()
        if why:
            if why != last_block:
                log("Panels dunkel, aber kein Schlaf: %s" % why)
                last_block = why
            continue
        last_block = None
        result = sleep_once()
        time.sleep(4)                  # let duo-powerkey handle the waking key press
        if not os.path.exists(DARK):
            dark_since, misses = None, 0   # the human woke it
            continue
        # woken by something else (or aborted): darken again (an abort lights the panels) and back off
        as_user("niri", "msg", "action", "power-off-monitors")
        misses += 1
        retry_at = time.monotonic() + (15 if misses < 4 else min(600, 60 * misses))
        if result == "skipped":
            retry_at = time.monotonic() + 30


if __name__ == "__main__":
    main()
