#!/usr/bin/python3
"""Morpheus M1b (06.11.2026): the cleaning filter for the factory image.

Reads the Duo image as a tar stream (stdin) and writes the FACTORY IMAGE (stdout) — like a new device:
no account, no networks, no keys, no pairings, no device-bound firmware. What every device needs for
itself is created on first start (machine-id: systemd, SSH keys: sshd-keygen, Wi-Fi address:
duo-wlfwd-start from the chip serial number, firmware: Morpheus reads it from the device while installing).

Usage: tar -C rootfs -cf - . | werksabbild.py <firmware-liste> <bericht> | sqfstar …
"""
import io
import re
import sys
import tarfile

FIRMWARE = {l.strip().lstrip("./") for l in open(sys.argv[1]) if l.strip()}
REPORT = open(sys.argv[2], "w")
OLD_USER = "mobile"

# Whole trees whose content is personal or device-bound (the directory itself stays).
EMPTY_DIRS = [
    "home/", "root/", "var/log/", "var/lib/bluetooth/", "var/lib/matrix/anmeldung/", "var/lib/AccountsService/users/",
    "var/lib/NetworkManager/", "var/lib/wlfwd/", "var/lib/chrony/", "var/lib/dhclient/", "var/lib/systemd/coredump/",
    "var/tmp/", "var/spool/", "var/cache/",
]
KEEP_IN_ROOT = {"root/.bashrc", "root/.bash_profile", "root/.bash_logout", "root/.cshrc", "root/.tcshrc"}
DROP_FILES = [
    re.compile(r"^etc/ssh/ssh_host_"),
    re.compile(r"^etc/NetworkManager/system-connections/(?!usb0\.nmconnection$)"),
    re.compile(r"^var/lib/systemd/(random-seed|credential\.secret|timers/)"),
    re.compile(r"\.vor[-0-9A-Za-z]*$|\.vor$|\.an$"),  # Workshop backups («duo-haltung.py.vor-stapel» …)
    re.compile(r"^etc/(passwd|shadow|group|gshadow|subuid|subgid)-$"),
    # Bound to the old account: Firefox with a fixed profile in /home/mobile (the normal entry applies), Phosh launcher.
    re.compile(r"^usr/local/share/applications/org\.mozilla\.firefox\.desktop$"),
    re.compile(r"^usr/local/bin/phosh-duo$"),
    # the owner's selection (06.11.2026): not on a new Duo.
    # reference app (personal flight simulator, works with the owner's memory sync).
    re.compile(r"^usr/local/bin/matrix-oracle$"),
    re.compile(r"^usr/local/share/applications/matrix-oracle\.desktop$"),
    # Pokémon Emerald and Zelda: the game files belong to the owner — without them these would be dead tiles. Along with them
    # goes the Game Boy base (mGBA), which nothing else needs.
    re.compile(r"^usr/local/bin/(pokemon-smaragd|zelda-minish-cap|duo-gba-start|duo-smaragd)$"),
    re.compile(r"^usr/local/share/applications/ch\.matrixhardline\.Duo(Smaragd|Zelda)\.desktop$"),
    re.compile(r"^usr/local/(lib64/libmgba\.so|include/mgba(-util)?(/|$)|share/doc/mGBA(/|$)|share/icons/hicolor/[^/]+/apps/io\.mgba\.)"),
    # GNOME and Phosh settings: only the entry in the app drawer. GNOME Settings is needed by the GNOME fallback session
    # (gnome-shell depends on it), so the program itself stays.
    re.compile(r"^usr/share/applications/(org\.gnome\.Settings|mobi\.phosh\.MobileSettings)\.desktop$"),
    # Terminals other than Matrix Terminal: hidden, the programs stay (Foot is the session's fallback terminal).
    re.compile(r"^usr/share/applications/(foot|footclient|foot-server|org\.gnome\.Console|org\.gnome\.Ptyxis)\.desktop$"),
    # Clocks (gnome-clocks): removed entirely — nothing depends on it.
    re.compile(r"^usr/bin/gnome-clocks$"),
    re.compile(r"^usr/share/(doc|licenses)/gnome-clocks(/|$)"),
    re.compile(r"^usr/share/(applications|dbus-1/services|glib-2\.0/schemas|gnome-shell/search-providers|metainfo|icons/hicolor/[^/]+/apps)/org\.gnome\.clocks"),
    re.compile(r"^usr/share/locale/[^/]+/LC_MESSAGES/gnome-clocks\.mo$"),
    re.compile(r"^usr/share/help/[^/]+/gnome-clocks(/|$)"),
]

WLFWD_START = b"""#!/bin/sh
# duo-wlfwd-start (Morpheus 06.11.2026): wlfwd mit einer WLAN-Adresse DIESES Ger\xc3\xa4ts \xe2\x80\x94 abgeleitet aus der
# Chip-Seriennummer (lokal verwaltet: 02:4d:53:xx:yy:zz). Vorher stand eine feste Adresse im Abbild: zwei Duos
# im selben Netz h\xc3\xa4tten sich gest\xc3\xb6rt.
S=$(cat /sys/devices/soc0/serial_number 2>/dev/null || cat /etc/machine-id)
H=$(printf '%s' "$S" | sha256sum | cut -c1-6)
MAC=$(printf '02:4d:53:%s:%s:%s' $(echo "$H" | cut -c1-2) $(echo "$H" | cut -c3-4) $(echo "$H" | cut -c5-6))
exec /usr/local/bin/wlfwd /lib/firmware "$MAC" /var/lib/wlfwd
"""


def note(kind, name):
    REPORT.write(f"{kind}\t{name}\n")


def strip_user(name, data):
    """passwd & co. without the old account (its lines and group member lists)."""
    out = []
    for line in data.decode().splitlines():
        f = line.split(":")
        if f and f[0] == OLD_USER:
            continue
        if name in ("etc/group", "etc/gshadow") and len(f) >= 4:
            f[-1] = ",".join(m for m in f[-1].split(",") if m and m != OLD_USER)
            line = ":".join(f)
        out.append(line)
    return ("\n".join(out) + "\n").encode()


def main():
    src = tarfile.open(fileobj=sys.stdin.buffer, mode="r|")
    dst = tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.PAX_FORMAT)
    for m in src:
        name = m.name[2:] if m.name.startswith("./") else m.name
        # Device-bound firmware: comes from the device during installation.
        if name in FIRMWARE:
            note("firmware", name)
            continue
        if any(name.startswith(d) and name != d.rstrip("/") for d in EMPTY_DIRS) and name not in KEEP_IN_ROOT:
            note("leer", name)
            continue
        if any(p.search(name) for p in DROP_FILES):
            note("weg", name)
            continue
        data = src.extractfile(m).read() if m.isfile() else None
        if name in ("etc/passwd", "etc/shadow", "etc/group", "etc/gshadow", "etc/subuid", "etc/subgid"):
            data = strip_user(name, data)
            note("ohne-konto", name)
        elif name == "etc/machine-id":
            data = b""  # systemd creates its own ID on first start
            note("leer-kennung", name)
        elif name == "etc/systemd/system/duo-wlfwd.service":
            data = re.sub(rb"(?m)^ExecStart=.*$", b"ExecStart=/usr/local/bin/duo-wlfwd-start", data)
            note("wlan-adresse", name)
        # Comments of our own scripts without the operator's first name (as in the published repo matrix-duo).
        if data is not None and name.startswith(("usr/local/bin/", "etc/skel/", "usr/share/matrix/")) \
                and b"\0" not in data[:8192] and b"the owner" in data:
            data = (data.replace(b"owner's wish", b"owner's wish")
                        .replace(b"the owner's ", b"the owner's ")
                        .replace(b"(owner, ", b"(owner, ")
                        .replace(b"(owner: ", b"(owner: ")
                        .replace(b"the owner", b"the owner"))
            note("ohne-name", name)
        if data is not None:
            m.size = len(data)
            dst.addfile(m, io.BytesIO(data))
        else:
            dst.addfile(m)
    # New: the launcher for wlfwd with a device-specific address.
    t = tarfile.TarInfo("./usr/local/bin/duo-wlfwd-start")
    t.size, t.mode, t.uid, t.gid = len(WLFWD_START), 0o755, 0, 0
    dst.addfile(t, io.BytesIO(WLFWD_START))
    note("neu", "usr/local/bin/duo-wlfwd-start")
    dst.close()
    REPORT.close()


if __name__ == "__main__":
    main()
