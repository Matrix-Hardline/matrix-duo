#!/bin/bash
# Surface Duo 1: build matugen 4.0.0 (colour palette generator of the Matrix canvas) for aarch64 / Fedora 42 -- R209.
# Matrix gets matugen from Terra (base/keep.txt); for Fedora 42 on ARM there is no package there. Same version as
# on the Surface Book (matugen-4.0.0). Built in the Duo rootfs chroot, the build folder stays out of the image (repack-rootfs.sh).
# Runs on the laptop as root:  sudo bash ~/duo-a1/bau-matugen-42.sh      (downloads crates from the net, ~5-10 min)
# Result: ~/duo-a1/out/matugen
set -e
R=/home/user/duo-a1/rootfs-duo-42; OUT=/home/user/duo-a1/out; B=/root/matugen-bau; VERSION=4.0.0
[ "$(id -u)" = 0 ] || { echo "bitte mit sudo starten"; exit 1; }
mkdir -p "$R$B" "$OUT"
mv "$R/etc/resolv.conf" "$R/etc/resolv.conf.duo"; cp -L /etc/resolv.conf "$R/etc/resolv.conf"
for d in proc sys dev; do mountpoint -q "$R/$d" || mount --bind "/$d" "$R/$d"; done
trap 'for d in dev sys proc; do umount "$R/$d" 2>/dev/null || true; done; rm -f "$R/etc/resolv.conf"; mv "$R/etc/resolv.conf.duo" "$R/etc/resolv.conf"' EXIT
echo "== $(date +%T) cargo install matugen $VERSION"
chroot "$R" env CARGO_HOME=$B/cargo cargo install matugen --version "$VERSION" --locked --root $B -j 8 2>&1 \
    | grep -E "^error|Installed|Finished|Compiling matugen" || true
install -m755 "$R$B/bin/matugen" "$OUT/matugen"
chown "${SUDO_USER:-root}": "$OUT/matugen"
"$OUT/matugen" --version 2>/dev/null || file "$OUT/matugen" | cut -d, -f1-2
echo "== $(date +%T) fertig"
