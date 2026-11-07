#!/bin/bash
# duo-fedora: start Fedora on the Surface Duo (RAM boot, nothing is written to the device). On the laptop:
#   ~/duo-a1/duo-fedora.sh            -> Duo over USB, from Android or the bootloader
# Sequence: Android -> adb reboot bootloader -> fastboot boot (image v4) -> stage 1 (telnet 23) -> v6-squash.sh
# (root over USB). Android stays the default: a normal reboot from Fedora lands in Android again.
# Offline (06.11.2026): Morpheus brings everything along — images under ../share/morpheus, tools (fastboot, adb, nc,
# telnet) next to this script. Outside the AppImage the workshop ~/duo-a1 applies.
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
SHARE=$HERE/../share/morpheus
export PATH="$HERE:$PATH"
. "$HERE/morpheus-netz.sh"   # USB network to the Duo (172.16.42.2), also on a fresh PC
W=${MORPHEUS_WERKSTATT:-$HOME/duo-a1}
pick() { for f in "$@"; do [ -f "$f" ] && { echo "$f"; return; }; done; echo "$1"; }
BILD=${DUO_BILD:-$(pick "$SHARE/boot-duo1-fedora-stufe1-v7.img" "$W/out/boot-duo1-fedora-stufe1-v7.img")}   # v7: from the fedora partition, otherwise rescue
say() { echo "duo-fedora: $*"; }
[ -f "$BILD" ] || { say "Abbild fehlt: $BILD"; exit 1; }

say "warte auf das Duo (Android oder Bootloader) ..."
for i in $(seq 1 120); do
  if fastboot devices | grep -q fastboot; then break; fi
  if adb devices | grep -q 'device$'; then say "Android erkannt -> Bootloader"; adb reboot bootloader; sleep 5; fi
  sleep 2
done
fastboot devices | grep -q fastboot || { say "kein Bootloader gefunden"; exit 1; }

say "RAM-Boot $(basename "$BILD")"
timeout 90 fastboot boot "$BILD" 2>&1 | tail -2   # sometimes reports «Write to device failed», boots anyway

say "warte auf Stufe 1 ..."
for i in $(seq 1 60); do
  netz_wach
  grep -qs "^0104$" /sys/bus/usb/devices/*/idProduct && timeout 2 bash -c "</dev/tcp/172.16.42.1/23" 2>/dev/null && break
  sleep 3
done
timeout 2 bash -c "</dev/tcp/172.16.42.1/23" 2>/dev/null || { say "Stufe 1 meldet sich nicht"; exit 1; }
# v7 boots from the partition by itself within the first ~15 s (telnet disappears). If telnet stays open and stage 1
# reports «RETTUNG», the laptop supplies the root as before (v6). DUO_USB=1 forces the USB path (/nodisk).
if [ "${DUO_USB:-0}" = 1 ]; then
  (sleep 1; echo 'touch /nodisk'; sleep 1) | timeout 4 telnet 172.16.42.1 23 >/dev/null 2>&1
  say "USB-Weg erzwungen"
fi
for i in $(seq 1 15); do
  sleep 2
  timeout 2 bash -c "</dev/tcp/172.16.42.1/23" 2>/dev/null || { say "Stufe 1 hat übergeben (Start von der Partition)"; break; }
  if (sleep 1; echo 'cat /tmp/stufe1.log'; sleep 1) | timeout 4 telnet 172.16.42.1 23 2>/dev/null | grep -q RETTUNG; then
    say "Stufe 1 im Rettungsmodus: $( (sleep 1; echo 'grep RETTUNG /tmp/stufe1.log'; sleep 1) | timeout 4 telnet 172.16.42.1 23 2>/dev/null | tr -d '\r' | grep '^RETTUNG' | head -1)"
    RETTUNG=1; break
  fi
done
if [ "${RETTUNG:-0}" != 1 ]; then
  say "warte auf Fedora ..."
  for i in $(seq 1 60); do netz_wach; timeout 2 bash -c "</dev/tcp/172.16.42.1/22" 2>/dev/null && { say "FERTIG – Fedora läuft von der Partition, bitte anmelden"; exit 0; }; sleep 2; done
  say "Fedora meldet sich nicht per USB (WLAN prüfen)"; exit 1
fi
sleep 2
# Rescue (no Matrix partition): the old workshop transfer only exists in the operator's workshop.
[ -f "$W/v6-squash.sh" ] || { say "Kein Matrix auf diesem Duo gefunden — bitte zuerst «Matrix installieren»"; exit 1; }
say "übertrage das System ..."
bash "$W/v6-squash.sh" > /tmp/v6-squash.log 2>&1
for p in $(pgrep -f 'http.server 8000'); do kill "$p" 2>/dev/null; done
grep -q "gesendet nach" /tmp/v6-squash.log || { say "Übertragung fehlgeschlagen, siehe /tmp/v6-squash.log"; exit 1; }
say "System übertragen, warte auf Fedora ..."
for i in $(seq 1 45); do netz_wach; timeout 2 bash -c "</dev/tcp/172.16.42.1/22" 2>/dev/null && { say "FERTIG – Fedora läuft, bitte anmelden"; exit 0; }; sleep 2; done
say "Fedora meldet sich nicht per USB (WLAN prüfen), Protokoll: /tmp/v6-squash.log"; exit 1
