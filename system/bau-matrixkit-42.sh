#!/bin/bash
# Surface Duo 1: build the Matrix shell apps (MatrixKit, Rust) for aarch64 / Fedora 42 -- R209 stage 2 «canvas on the Duo».
# Source: copy of ~/matrix/matrixkit under /root/matrixkit in the Duo rootfs chroot (vendored crates -> no network needed).
# Profile «werkbank» (release without fat LTO). The build folder is left out when packing the image (repack-rootfs.sh).
# Runs on the laptop as root:  sudo bash ~/duo-a1/bau-matrixkit-42.sh [package ...]
# Result: ~/duo-a1/out/matrix-apps/
set -e
R=/home/user/duo-a1/rootfs-duo-42; OUT=/home/user/duo-a1/out/matrix-apps; B=/root/matrixkit
PAKETE="${*:-matrix-bar matrix-dock matrix-notifications matrix-context matrix-wallpaper matrix-watchdog matrix-keyboard matrix-osd matrix-start matrix-settings matrix-central matrix-capture matrix-lock matrix-help matrix-terminal matrix-tube matrix-player}"
[ "$(id -u)" = 0 ] || { echo "bitte mit sudo starten"; exit 1; }
[ -f "$R$B/Cargo.toml" ] || { echo "$R$B fehlt (Kopie von ~/matrix/matrixkit)"; exit 2; }
mkdir -p "$OUT"
for d in proc sys dev; do mountpoint -q "$R/$d" || mount --bind "/$d" "$R/$d"; done
trap 'for d in dev sys proc; do umount "$R/$d" 2>/dev/null || true; done' EXIT
echo "== $(date +%T) Bau: $PAKETE"
ARGS=""; for p in $PAKETE; do ARGS="$ARGS -p $p"; done
chroot "$R" env CARGO_HOME=/root/matrixkit-cargo bash -c "cd $B && cargo build --offline --profile werkbank -j 8 $ARGS 2>&1" \
    | grep -E "^error|^warning: unused|Finished|could not compile" || true
for p in $PAKETE; do
    if [ -x "$R$B/target/werkbank/$p" ]; then install -m755 "$R$B/target/werkbank/$p" "$OUT/$p"; echo "ok   $p"; else echo "FEHLT $p"; fi
done
chown -R "${SUDO_USER:-root}": "$OUT"
echo "== $(date +%T) fertig"
