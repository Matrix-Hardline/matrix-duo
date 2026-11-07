#!/bin/bash
# Assemble boot.img for the Duo (kernel Image.gz + Halium initramfs + generic stock DTB) and check it offline.
set -e
W=/home/user/duo-a1; P=$W/surfaceduo-droidian; cd "$W"
K=$(ls -1 packages/*.deb 2>/dev/null | grep -E "linux-image-4\.14" | head -1)
if [ -n "$K" ]; then rm -rf kimg; mkdir kimg; dpkg -x "$K" kimg; IMG=$(find kimg -name "Image.gz" | head -1); fi
[ -n "${IMG:-}" ] || IMG=$(find surface-duo-oss-kernel.msm-4.14/out -name Image.gz 2>/dev/null | head -1)
[ -n "${IMG:-}" ] || { echo "FEHLER: kein Image.gz (Kernel noch nicht gebaut?)"; exit 1; }
echo "Kernel: $IMG"; ls -la "$IMG" | awk '{print $5}'
[ -f out/initramfs-halium.gz ] || { echo "FEHLER: out/initramfs-halium.gz fehlt (2-initramfs-holen.sh)"; exit 1; }
[ -f out/stock.dtb ] || { echo "FEHLER: out/stock.dtb fehlt"; exit 1; }
# Fedora variant of the cmdline: like Droidian (kernel-info.mk), plus selinux=0 for Fedora's policy
bash "$P/tools/make-boot-image.sh" "$IMG" out/initramfs-halium.gz out/stock.dtb out/boot-duo1-fedora.img
ls -la out/boot-duo1-fedora.img | awk '{print $5, $9}'
echo "== Offline-Prüfung (flash-safely validate):"; bash "$P/tools/flash-safely.sh" validate out/boot-duo1-fedora.img || true
echo "FERTIG: out/boot-duo1-fedora.img (NICHT flashen – nur fastboot boot, nach Doktrin)"
