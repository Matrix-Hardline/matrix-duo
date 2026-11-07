#!/bin/bash
# Surface Duo 1: build niri-canvas (compositor of the Matrix canvas) for aarch64 / Fedora 42 -- stage 1 «canvas on the Duo».
# Same ingredients as the niri-builder in the Matrix Containerfile (~/matrix/Containerfile): niri a30ca798 from
# ~/matrix/canvas/niri-quelle-*.tar.gz, Smithay ff5fa7df with 0002 + 0004, niri with 0001 + 0003 + 0005 (+ 0006 Duo touch).
# Built in the Duo rootfs chroot (same libraries as on the device); the build folder /root/niri-canvas stays
# out when packing the image (repack-rootfs.sh). Runs on the laptop as root:
#   sudo bash ~/duo-a1/bau-niri-canvas-42.sh        (takes ~20-40 min, downloads Rust + crates from the net)
# Result: ~/duo-a1/out/niri-canvas
set -e
R=/home/user/duo-a1/rootfs-duo-42; Q=/home/user/duo-a1/matrix-canvas; OUT=/home/user/duo-a1/out
B=/root/niri-canvas; SMITHAY_COMMIT=ff5fa7df392cecfba049ffed55cdaa4e98a8e7ef
[ "$(id -u)" = 0 ] || { echo "bitte mit sudo starten"; exit 1; }
[ -d "$R/usr" ] && [ -d "$Q" ] || { echo "rootfs ($R) oder Matrix-Quellen ($Q) fehlen"; exit 2; }
mkdir -p "$OUT"
echo "== $(date +%T) Bauwerkzeuge in den Chroot (Host-dnf, Fedora 42)"
rpm --root "$R" -q cargo libseat-devel libdisplay-info-devel >/dev/null 2>&1 || dnf -y -q install --installroot="$R" --releasever=42 --setopt=install_weak_deps=False \
    rust cargo git clang gcc pkgconf-pkg-config systemd-devel mesa-libgbm-devel libxkbcommon-devel mesa-libEGL-devel \
    wayland-devel libinput-devel dbus-devel libseat-devel pipewire-devel pango-devel cairo-devel cairo-gobject-devel \
    libdisplay-info-devel 2>&1 | grep -vE "OpenPGP|^\s*$" | tail -2 || true
echo "== $(date +%T) Quellen + Patches"
# Repeat: Smithay clone + crate store (cargo/) stay -> second build without network (--offline)
mkdir -p "$R$B"; [ -d "$R$B/niri/target" ] && mv "$R$B/niri/target" "$R$B/niri-target"; rm -rf "$R$B/niri"
tar -C "$R$B" -xzf "$Q"/niri-quelle-*.tar.gz; mv "$R$B"/niri-a* "$R$B/niri"; [ -d "$R$B/niri-target" ] && mv "$R$B/niri-target" "$R$B/niri/target"
cp "$Q"/0[0-9][0-9][0-9]-*.patch "$R$B/"
# Name resolution in the chroot: move the Duo entry (usually a link to systemd-resolved) aside briefly, put the host file in
mv "$R/etc/resolv.conf" "$R/etc/resolv.conf.duo"; cp -L /etc/resolv.conf "$R/etc/resolv.conf"
for d in proc sys dev; do mountpoint -q "$R/$d" || mount --bind "/$d" "$R/$d"; done
trap 'for d in dev sys proc; do umount "$R/$d" 2>/dev/null || true; done; rm -f "$R/etc/resolv.conf"; mv "$R/etc/resolv.conf.duo" "$R/etc/resolv.conf"' EXIT
cat > "$R$B/bau.sh" <<EOB
set -e
cd $B
if [ -d smithay/.git ]; then cd smithay && git checkout -q -- . && git clean -qfd && git checkout -q $SMITHAY_COMMIT
else git clone -q https://github.com/Smithay/smithay smithay && cd smithay && git checkout -q $SMITHAY_COMMIT; fi
git apply ../0002-smithay-keymap-per-wl_keyboard.patch && git apply ../0004-smithay-layer-rank.patch
# R209: plane opacity within the driver's range (Duo/SDE: 0..255 instead of 0..65535, otherwise EINVAL, all black)
[ -f ../0008-smithay-plane-alpha-range.patch ] && git apply ../0008-smithay-plane-alpha-range.patch
cd ..
cd niri
git apply ../0001-canvas-drag.patch && git apply ../0003-canvas-glass.patch && git apply ../0005-canvas-round-maximized.patch
# R209: one output per touchscreen from the udev property WL_OUTPUT (Duo: one touch per panel)
[ -f ../0006-canvas-touch-wl-output.patch ] && git apply ../0006-canvas-touch-wl-output.patch
# R209: the Duo display rejects 10-bit framebuffers -> second attempt with 8-bit formats
[ -f ../0007-canvas-8bit-fallback.patch ] && git apply ../0007-canvas-8bit-fallback.patch
# R209: close_range is missing on Linux 4.14 -> spawned processes hung, zombies; close one by one
[ -f ../0009-canvas-spawn-close-fallback.patch ] && git apply ../0009-canvas-spawn-close-fallback.patch
# R209: touch on a shell surface (keyboard) no longer moves the output focus
[ -f ../0010-canvas-touch-layer-keeps-output.patch ] && git apply ../0010-canvas-touch-layer-keeps-output.patch
# R210: DSI panels with a miscalculated clock (Duo: 21.9 instead of 60 Hz) -> NIRI_CANVAS_REFRESH_HZ
[ -f ../0011-canvas-refresh-override.patch ] && git apply ../0011-canvas-refresh-override.patch
# Round 48: the intermediate child waits at most 10 s for niri's signal (one hang held 714 MB of window buffers for 6 h)
[ -f ../0012-canvas-spawn-wait-bound.patch ] && git apply ../0012-canvas-spawn-wait-bound.patch
# 03.11.: switch panels on in a fixed order (DSI_1 before DSI_0 = noise on both panels until reboot)
[ -f ../0015-canvas-first-light.patch ] && git apply ../0015-canvas-first-light.patch
# Round 71: Night Shift — without GAMMA_LUT (Duo/SDE) niri sets the PCC colour correction
[ -f ../0016-canvas-sde-pcc-gamma.patch ] && git apply ../0016-canvas-sde-pcc-gamma.patch
# Round 84: one panel off on its own (folded back) — power-off-monitor/power-on-monitor <OUT>
[ -f ../0017-canvas-power-one-monitor.patch ] && git apply ../0017-canvas-power-one-monitor.patch
# Round 101: screen recording copies the finished frame (GPU blit) instead of redrawing the scene
[ -f ../0018-canvas-screencopy-blit.patch ] && git apply ../0018-canvas-screencopy-blit.patch
# Round 108: glass bodies glide to a new position/size (rule glass-glide) — the bar jumps once, niri glides
[ -f ../0019-canvas-glass-glide.patch ] && git apply ../0019-canvas-glass-glide.patch
# Round 124: while locked, every touch belongs to the lock (the canvas swipe gesture ate it)
[ -f ../0020-canvas-lock-owns-input.patch ] && git apply ../0020-canvas-lock-owns-input.patch
# Round 136: the lock does not wait for panels switched off individually (0017) — otherwise «Locking» hung forever
[ -f ../0021-canvas-lock-skips-dark-panels.patch ] && git apply ../0021-canvas-lock-skips-dark-panels.patch
# 06.11.2026: a chip that only changes its width (app name) jumps with the content instead of gliding/merging
[ -f ../0022-canvas-glide-width-in-place.patch ] && git apply ../0022-canvas-glide-width-in-place.patch
printf '\n[patch."https://github.com/Smithay/smithay.git"]\nsmithay = { path = "$B/smithay" }\n' >> Cargo.toml
export CARGO_HOME=$B/cargo
OFF=""; [ -d \$CARGO_HOME/registry ] && OFF=--offline
cargo build --release \$OFF -j 8 2>&1 | grep -E "^(error|warning: unused)|Finished|Compiling niri " || true
test -x target/release/niri
EOB
echo "== $(date +%T) Bau im Chroot (Crates aus dem Netz)"
chroot "$R" bash "$B/bau.sh"
install -m755 "$R$B/niri/target/release/niri" "$OUT/niri-canvas"
chown "${SUDO_USER:-root}": "$OUT/niri-canvas"
ls -la "$OUT/niri-canvas" | awk '{print $5, $9}'; file "$OUT/niri-canvas" | cut -d, -f1-2
echo "== $(date +%T) fertig"
