#!/bin/bash
# Fetch the Halium initramfs (Droidian, arm64) via the Droidian build container – started by the owner.
set -e
W=/home/user/duo-a1; mkdir -p "$W/initramfs" "$W/out"; cd "$W"
echo "== Baucontainer (arm64) holen"; podman pull -q quay.io/droidian/build-essential:current-arm64
echo "== Paket laden + auspacken"
podman run --rm -v "$W/initramfs:/out:Z" quay.io/droidian/build-essential:current-arm64 bash -c \
  'apt-get update -qq >/dev/null 2>&1; cd /out && apt-get -qq download linux-initramfs-halium-generic && dpkg -x linux-initramfs-halium-generic_*.deb x && find x -type f | sed "s|^|  |"'
F=$(find "$W/initramfs/x" -type f \( -name "initrd*" -o -name "initramfs*" \) | head -1)
[ -n "$F" ] || { echo "FEHLER: keine Initramfs-Datei im Paket"; exit 1; }
cp "$F" "$W/out/initramfs-halium.gz"; ls -la "$W/out/initramfs-halium.gz" | awk '{print $5, $9}'
file "$W/out/initramfs-halium.gz" | cut -c1-100
echo "FERTIG: out/initramfs-halium.gz"
