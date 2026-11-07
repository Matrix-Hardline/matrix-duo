#!/bin/bash
# morpheus-lieferant (Morpheus M4, 06.11.2026): the laptop side of the installation. Asks every 2 s what the Duo needs
# (/run/morpheus/bedarf in the live system) and delivers: «sicherung» = full backup of all partitions to here (verified),
# «abbild <ziel>» = the factory image to that target. Reports progress to /run/morpheus/laptop (the installer shows it).
set -u
# Offline (06.11.2026): Morpheus brings everything with it — images under ../share/morpheus, tools (fastboot, adb, nc,
# telnet) next to this script. Outside the AppImage the workshop ~/duo-a1 applies.
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
SHARE=$HERE/../share/morpheus
export PATH="$HERE:$PATH"
W=${MORPHEUS_WERKSTATT:-$HOME/duo-a1}
pick() { for f in "$@"; do [ -f "$f" ] && { echo "$f"; return; }; done; echo "$1"; }
WERK=${MORPHEUS_WERK:-$(pick "$SHARE/matrix-werk.sqfs" "$W/out/werk/matrix-werk.sqfs")}
KEY=$HOME/.ssh/morpheus_ed25519
duo() { ssh -n -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ServerAliveInterval=15 -o BatchMode=yes root@172.16.42.1 "$@"; }
melde() { duo "echo '$*' >> /run/morpheus/laptop"; echo "morpheus: $*"; }

sicherung() {
  local serial; serial=$(duo cat /sys/devices/soc0/serial_number 2>/dev/null | tr -dc '0-9A-Za-z')
  local Z=$HOME/Sicherungen/surface-duo-${serial:-unbekannt}/vollsicherung-$(date +%F-%H%M)
  mkdir -p "$Z/partitionen" "$Z/gpt" || { melde "sicherung fehler Ordner"; return; }
  for d in sda sdb sdc sdd sde sdf sdg; do
    duo "sfdisk -d /dev/$d 2>/dev/null" > "$Z/gpt/$d.sfdisk"
    local n; n=$(duo blockdev --getsize64 /dev/$d)
    duo "dd if=/dev/$d bs=4096 count=256 status=none" > "$Z/gpt/$d-anfang.img"
    duo "dd if=/dev/$d bs=4096 skip=$((n/4096-256)) status=none" > "$Z/gpt/$d-ende.img"
  done
  local parts; parts=$(duo ls /dev/disk/by-partlabel | grep -vx fedora)
  local total; total=$(echo "$parts" | wc -l); local k=0
  for p in $parts; do
    k=$((k+1)); melde "sicherung läuft $p ($k von $total)"
    duo "dd if=/dev/disk/by-partlabel/$p bs=4M status=none | zstd -3 -T4 -q -c" > "$Z/partitionen/$p.img.zst" || { melde "sicherung fehler $p"; return; }
  done
  melde "sicherung läuft Prüfsummen"
  duo "cd /dev/disk/by-partlabel && for p in \$(ls | grep -vx fedora); do echo \"\$(sha256sum < \$p | cut -d' ' -f1)  \$p.img\"; done" > "$Z/SHA256SUMS-roh"
  local bad=0
  while read -r sum name; do
    [ "$(zstd -dc "$Z/partitionen/$name.zst" | sha256sum | cut -d' ' -f1)" = "$sum" ] || { bad=1; echo "FALSCH $name"; }
  done < "$Z/SHA256SUMS-roh"
  [ "$bad" = 0 ] || { melde "sicherung fehler Prüfsummen"; return; }
  echo "Surface Duo $serial — Vollsicherung durch Morpheus $(date '+%F %T'), $total Partitionen, geprüft." > "$Z/LIESMICH.txt"
  melde "sicherung fertig $Z"
}

abbild() {
  local ziel=$1 sha
  sha=$(cat "$WERK.sha256" 2>/dev/null || sha256sum "$WERK" | cut -d' ' -f1)
  melde "abbild läuft $(( $(stat -c %s "$WERK") / 1048576 )) MB"
  ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o BatchMode=yes root@172.16.42.1 "cat > '$ziel'" < "$WERK" || { melde "abbild fehler Übertragung"; return; }
  duo sync
  melde "abbild fertig $sha"
}

echo "morpheus: Lieferant bereit"
while true; do
  b=$(duo "cat /run/morpheus/bedarf 2>/dev/null; [ -e /run/morpheus/fertig ] && echo ENDE; true" 2>/dev/null) || {
    # The Duo does not answer (cable pulled, rebooted): stop after ~3 min instead of waiting forever.
    stumm=$(( ${stumm:-0} + 1 )); [ "$stumm" -ge 60 ] && { echo "morpheus: Duo nicht mehr erreichbar – Lieferant hört auf"; exit 1; }
    sleep 3; continue; }
  stumm=0
  case "$b" in
    *ENDE*) echo "morpheus: Duo fertig"; exit 0 ;;
    sicherung*) [ "${last:-}" = "$b" ] || { last=$b; sicherung; } ;;
    abbild*) [ "${last:-}" = "$b" ] || { last=$b; abbild "$(echo "$b" | awk '{print $2}')"; } ;;
    *) last="" ;;
  esac
  sleep 2
done
