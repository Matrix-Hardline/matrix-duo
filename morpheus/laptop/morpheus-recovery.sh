#!/bin/bash
# morpheus-recovery (06.11.2026, operator's request: «Morpheus is the iTunes of Matrix»): the laptop side of MATRIX
# RECOVERY. The Duo runs in the live system (morpheus-live.sh) and already has Matrix; this script drives it:
#   zustand                 -> «morpheus: ZUSTAND {json}» (device, accounts, size of the Matrix data)
#   sichern                 -> Matrix backup to ~/Sicherungen/surface-duo-<serial>/matrix-<date>/ (verified)
#   sichern-betrieb <konto> -> the same while Matrix is running (paired laptop, matrix-begleiter via sudo)
#   wiederherstellen <dir>  -> restore a Matrix backup (the Duo asks first)
#   neu                     -> reinstall Matrix, ONLY the Matrix partition (the Duo asks first)
#   starten                 -> Duo into the bootloader, then start Matrix from the partition
# Writes happen only on the Duo, only to the «fedora» partition, only after confirmation on the Duo screen.
set -u
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
SHARE=$HERE/../share/morpheus
export PATH="$HERE:$PATH"
. "$HERE/morpheus-netz.sh"   # USB network to the Duo (172.16.42.2), also on a fresh PC
netz_wach
W=${MORPHEUS_WERKSTATT:-$HOME/duo-a1}
pick() { for f in "$@"; do [ -f "$f" ] && { echo "$f"; return; }; done; echo "$1"; }
WERK=${MORPHEUS_WERK:-$(pick "$SHARE/matrix-werk.sqfs" "$W/out/werk/matrix-werk.sqfs")}
KEY=$HOME/.ssh/morpheus_ed25519
SICH=${MORPHEUS_SICHERUNGEN:-$HOME/Sicherungen}
say() { echo "morpheus: $*"; }
# Fd 3 = the screen (the log): the Duo's messages go there, never into a file that is currently being
# written (06.11.2026: they ended up at the end of the backup; luckily zstd rejected it).
exec 3>&1
duo() { ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes \
          -o ServerAliveInterval=15 root@172.16.42.1 "$@"; }
# Progress of a growing file (every 3 s) until the operation ends.
mitzaehlen() {
  local f=$1 word=$2
  while sleep 3; do [ -f "$f" ] && say "$word $(( $(stat -c %s "$f") / 1048576 )) MB"; done
}

# Matrix in operation: the person at the Duo, with the paired key (valid only over the cable).
person() { ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes \
             -o ServerAliveInterval=15 "$KONTO@172.16.42.1" "$@"; }
QUELLE=duo
serie() { $QUELLE cat /sys/devices/soc0/serial_number 2>/dev/null | tr -dc '0-9A-Za-z'; }

zustand() {
  local j; j=$(duo morpheus-recovery zustand 2>/dev/null) || { say "FEHLER Zustand nicht lesbar"; return 1; }
  say "ZUSTAND $j"
}

sichern() {
  local s; s=$(serie); [ -n "$s" ] || { say "FEHLER Seriennummer nicht lesbar"; return 1; }
  local Z=$SICH/surface-duo-$s/matrix-$(date +%F-%H%M)
  mkdir -p "$Z" || { say "FEHLER Ordner $Z"; return 1; }
  say "sichere Matrix nach $Z"
  mitzaehlen "$Z/matrix.tar.zst.teil" "Sicherung" & local zp=$!
  if [ "$QUELLE" = person ]; then
    person matrix-begleiter sichern > "$Z/matrix.tar.zst.teil" 2> >(sed 's/^/morpheus: /' >&3)
  else
    duo morpheus-recovery sichern > "$Z/matrix.tar.zst.teil" 2> >(sed 's/^/morpheus: /' >&3)
  fi
  local rc=$?
  kill $zp 2>/dev/null; wait $zp 2>/dev/null
  [ $rc = 0 ] || { say "FEHLER Sicherung abgebrochen"; rm -f "$Z/matrix.tar.zst.teil"; rmdir "$Z" 2>/dev/null; return 1; }
  say "prüfe die Sicherung …"
  zstd -tq "$Z/matrix.tar.zst.teil" || { say "FEHLER Sicherung beschädigt"; return 1; }
  mv "$Z/matrix.tar.zst.teil" "$Z/matrix.tar.zst"
  zstd -dc "$Z/matrix.tar.zst" 2>/dev/null | tar -xOf - --occurrence=1 morpheus/info.json > "$Z/info.json" 2>/dev/null
  sha256sum "$Z/matrix.tar.zst" | cut -d' ' -f1 > "$Z/matrix.tar.zst.sha256"
  say "SICHERUNG FERTIG $Z ($(( $(stat -c %s "$Z/matrix.tar.zst") / 1048576 )) MB)"
}

wiederherstellen() {
  local Z=$1 f=$1/matrix.tar.zst
  [ -f "$f" ] || { say "FEHLER keine Sicherung in $Z"; return 1; }
  if [ -f "$f.sha256" ]; then
    say "prüfe die Sicherung …"
    [ "$(sha256sum < "$f" | cut -d' ' -f1)" = "$(cat "$f.sha256")" ] || { say "FEHLER Sicherung beschädigt (Prüfsumme)"; return 1; }
  fi
  local wann; wann=$(sed -n 's/.*"zeit": *"\([^"]*\)".*/\1/p' "$Z/info.json" 2>/dev/null | head -1)
  say "Bitte auf dem Duo bestätigen"
  duo morpheus-recovery frage "Matrix-Sicherung vom ${wann:-?} zurückspielen? Konten und Dateien darin ersetzen die auf diesem Duo." \
    || { say "ABGELEHNT auf dem Duo — nichts geändert"; return 1; }
  say "spiele die Sicherung zurück …"
  duo morpheus-recovery zurueck < "$f" 2> >(sed 's/^/morpheus: /' >&3) || { say "FEHLER Zurückspielen"; return 1; }
  say "WIEDERHERGESTELLT"
}

neu() {
  [ -f "$WERK" ] || { say "FEHLER Werksabbild fehlt: $WERK"; return 1; }
  say "Bitte auf dem Duo bestätigen"
  duo morpheus-recovery frage "Matrix neu installieren? Alle Matrix-Daten auf diesem Duo werden gelöscht. Android bleibt, wie es ist." \
    || { say "ABGELEHNT auf dem Duo — nichts geändert"; return 1; }
  local ziel; ziel=$(duo morpheus-recovery neu-vorbereiten 2> >(sed 's/^/morpheus: /' >&3)) || { say "FEHLER Partition"; return 1; }
  local sha; sha=$(cat "$WERK.sha256" 2>/dev/null | cut -d' ' -f1); [ -n "$sha" ] || sha=$(sha256sum < "$WERK" | cut -d' ' -f1)
  say "übertrage Matrix ($(( $(stat -c %s "$WERK") / 1048576 )) MB) …"
  duo "cat > '$ziel'" < "$WERK" || { say "FEHLER Übertragung"; return 1; }
  duo morpheus-recovery neu-abschliessen "$sha" 2> >(sed 's/^/morpheus: /' >&3) || { say "FEHLER Abschluss"; return 1; }
  say "NEU INSTALLIERT"
}

starten() {
  duo morpheus-recovery starten 2> >(sed 's/^/morpheus: /' >&3)
  say "warte auf den Bootloader …"
  for i in $(seq 1 60); do fastboot devices | grep -q fastboot && break; sleep 2; done
  fastboot devices | grep -q fastboot || { say "FEHLER Bootloader meldet sich nicht"; return 1; }
  exec bash "$HERE/duo-fedora.sh"
}

# Set the live system's clock from the laptop (the Duo has no proper time in a RAM boot — backups otherwise
# carried a date from March). In operation Matrix has its own clock.
[ "${1:-}" = sichern-betrieb ] || duo "date -s @$(date +%s)" >/dev/null 2>&1

case "${1:-}" in
  zustand) zustand ;;
  sichern) sichern ;;
  sichern-betrieb) KONTO=${2:?Konto}; QUELLE=person; sichern ;;
  wiederherstellen) wiederherstellen "${2:?Ordner der Sicherung}" ;;
  neu) neu ;;
  starten) starten ;;
  *) echo "Aufruf: $0 zustand|sichern|wiederherstellen <ordner>|neu|starten" >&2; exit 2 ;;
esac
