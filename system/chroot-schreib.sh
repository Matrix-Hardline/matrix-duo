#!/bin/bash
# chroot-schreib.sh <path in the image> <base64 content> [mode]  -> writes safely into the rootfs chroot (never onto the laptop)
set -e; R=/home/user/duo-a1/rootfs-duo-42; Z="$1"; [ -n "$Z" ] && [ -n "$2" ] || { echo "Aufruf: $0 <pfad> <base64> [rechte]"; exit 2; }
[ -d "$R/usr" ] || { echo "Chroot fehlt: $R"; exit 3; }
mkdir -p "$R$(dirname "$Z")"; printf '%s' "$2" | base64 -d > "$R$Z"; [ -n "$3" ] && chmod "$3" "$R$Z"; ls -la "$R$Z" | cut -c24-
