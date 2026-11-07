#!/bin/bash
# morpheus-live (Morpheus M4, 06.11.2026): boot a Surface Duo over the cable into the Matrix LIVE SYSTEM (RAM only) —
# the factory image, with /etc/morpheus-live (the login screen becomes the installer) and a one-time key so that
# the laptop can deliver the backup and the image. NOTHING is written on the device.
#   MORPHEUS_TROCKEN=1  dry run: the installer writes nothing, it only describes.
set -u
# Offline (06.11.2026): Morpheus brings everything with it — images under ../share/morpheus, tools (fastboot, adb, nc,
# telnet) next to this script. Outside the AppImage the workshop ~/duo-a1 applies.
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
SHARE=$HERE/../share/morpheus
export PATH="$HERE:$PATH"
W=${MORPHEUS_WERKSTATT:-$HOME/duo-a1}
pick() { for f in "$@"; do [ -f "$f" ] && { echo "$f"; return; }; done; echo "$1"; }
BILD=${DUO_BILD:-$(pick "$SHARE/boot-duo1-fedora-stufe1-v7.img" "$W/out/boot-duo1-fedora-stufe1-v7.img")}
WERK=${MORPHEUS_WERK:-$(pick "$SHARE/matrix-werk.sqfs" "$W/out/werk/matrix-werk.sqfs")}

# The USB link to the Duo (172.16.42.2): shared with the other laptop scripts (morpheus-netz.sh).
. "$HERE/morpheus-netz.sh"
KEY=$HOME/.ssh/morpheus_ed25519
say() { echo "morpheus: $*"; }
[ -f "$BILD" ] || { say "Startabbild fehlt: $BILD"; exit 1; }
[ -f "$WERK" ] || { say "Werksabbild fehlt: $WERK"; exit 1; }
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C morpheus -f "$KEY"
PUB=$(cat "$KEY.pub")

# If the Duo is already in stage 1 (an aborted run), continue there instead of starting over.
netz_wach
if grep -qs "^0104$" /sys/bus/usb/devices/*/idProduct && timeout 2 bash -c "</dev/tcp/172.16.42.1/23" 2>/dev/null; then
  say "Stufe 1 läuft schon — weiter ohne Neustart"
  SCHON=1
fi
if [ "${SCHON:-0}" != 1 ]; then
say "warte auf das Duo (Android oder Bootloader) ..."
for i in $(seq 1 150); do
  fastboot devices | grep -q fastboot && break
  if adb devices | grep -q 'device$'; then say "Android erkannt -> Bootloader"; adb reboot bootloader; sleep 5; fi
  sleep 2
done
fastboot devices | grep -q fastboot || { say "kein Bootloader gefunden"; exit 1; }
U=$(fastboot getvar unlocked 2>&1 | sed -n 's/^unlocked: *//p' | head -1)
say "Bootloader entsperrt: ${U:-?}"
[ "$U" = "yes" ] || { say "GESPERRT – Bootloader zuerst entsperren (siehe Anleitung)"; exit 3; }

say "RAM-Boot $(basename "$BILD")"
timeout 90 fastboot boot "$BILD" 2>&1 | tail -1
say "warte auf Stufe 1 ..."
for i in $(seq 1 60); do
  netz_wach
  grep -qs "^0104$" /sys/bus/usb/devices/*/idProduct && timeout 2 bash -c "</dev/tcp/172.16.42.1/23" 2>/dev/null && break
  sleep 3
done
timeout 2 bash -c "</dev/tcp/172.16.42.1/23" 2>/dev/null || { say "Stufe 1 meldet sich nicht"; exit 1; }
fi
# Always the USB route (live system), never an existing partition.
(sleep 1; echo 'touch /nodisk'; sleep 1) | timeout 4 telnet 172.16.42.1 23 >/dev/null 2>&1
for i in $(seq 1 20); do
  sleep 2
  (sleep 1; echo 'cat /tmp/stufe1.log'; sleep 1) | timeout 4 telnet 172.16.42.1 23 2>/dev/null | grep -q RETTUNG && break
done
N=$(duo_netz_name)
[ -n "$N" ] || { say "USB-Netz des Duo nicht gefunden"; exit 1; }
netz_hoch "$N" || { say "USB-Netz liess sich nicht einrichten"; exit 1; }; sleep 1

say "übertrage das Live-System ($(( $(stat -c %s "$WERK") / 1048576 )) MB) ..."
MARKS="mkdir -p /newroot/root/.ssh /newroot/run/morpheus; touch /newroot/etc/morpheus-live; echo '$PUB' > /newroot/root/.ssh/authorized_keys; chmod 700 /newroot/root/.ssh; chmod 600 /newroot/root/.ssh/authorized_keys; printf 'PermitRootLogin prohibit-password\\n' > /newroot/etc/ssh/sshd_config.d/10-morpheus-live.conf"
[ "${MORPHEUS_TROCKEN:-0}" = 1 ] && MARKS="$MARKS; touch /newroot/etc/morpheus-trocken"
# Language & keyboard (06.11.2026): the live system, the installer and later the installed Matrix use them.
case "${MORPHEUS_SPRACHE:-de-CH}" in en-GB) KETTE="en-GB,de-CH"; LOC="en_GB.UTF-8" ;; *) KETTE="de-CH,en-GB"; LOC="de_CH.UTF-8" ;; esac
case "${MORPHEUS_TASTATUR:-ch}" in gb) TAST=gb ;; *) TAST=ch ;; esac
MARKS="$MARKS; mkdir -p /newroot/etc/matrix; echo $KETTE > /newroot/etc/matrix/languages; echo $TAST > /newroot/etc/matrix/keyboard; echo LANG=$LOC > /newroot/etc/locale.conf"
say "Sprache $KETTE, Tastatur $TAST"
(sleep 1; echo "mkdir -p /img /lower /ovl; mount -t tmpfs -o size=1400m tmpfs /img; mount -t tmpfs -o size=1500m tmpfs /ovl; mkdir -p /ovl/upper /ovl/work; setsid sh -c \"nc -l -p 9000 > /img/rootfs.squashfs; mount -t squashfs -o loop,ro /img/rootfs.squashfs /lower && mount -t overlay overlay -o lowerdir=/lower,upperdir=/ovl/upper,workdir=/ovl/work /newroot && mkdir -p /newroot/proc /newroot/sys /newroot/dev /newroot/run /newroot/tmp && $MARKS && echo morpheus: Live-System bereit > /dev/kmsg && touch /go || echo morpheus: FEHLER Live-System > /dev/kmsg\" >/dev/null 2>&1 </dev/null & sleep 1; echo NC-BEREIT"; sleep 4) | timeout 8 telnet 172.16.42.1 23 2>&1 | tr -d "\r" | grep -q NC-BEREIT || { say "Stufe 1 nimmt nichts an"; exit 1; }
T0=$(date +%s); nc --send-only 172.16.42.1 9000 < "$WERK" || { say "Übertragung fehlgeschlagen"; exit 1; }
say "übertragen in $(( $(date +%s)-T0 )) s, warte auf das Live-System ..."
for i in $(seq 1 90); do
  timeout 2 bash -c "</dev/tcp/172.16.42.1/22" 2>/dev/null && ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=4 -o BatchMode=yes root@172.16.42.1 "date -s @$(date +%s)" >/dev/null 2>&1 && { say "FERTIG – Live-System läuft, Morpheus auf dem Duo"; exit 0; }
  sleep 2
done
say "Live-System meldet sich nicht"; exit 1
