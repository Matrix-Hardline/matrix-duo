#!/bin/bash
# Surface Duo 1: Kernel-Image inkrementell neu bauen (Patch kernel-waitid-P_PIDFD) – nur Image.gz, gleiche Konfiguration,
# gleiche KERNELRELEASE (vermagic bleibt, WLAN-/Audio-Module passen weiter). the owner startet das selbst.
# Läuft im Hintergrund; Protokoll ~/duo-a1/kernel-pidfd-bau.log. Ergebnis: ~/duo-a1/out/Image-pidfd.gz
W=/home/user/duo-a1; K=$W/surface-duo-oss-kernel.msm-4.14; cd "$W" || exit 1
if [ "$1" != "--vordergrund" ]; then nohup "$0" --vordergrund > "$W/kernel-pidfd-bau.log" 2>&1 & echo "Kernel-Bau läuft im Hintergrund (PID $!). Protokoll: $W/kernel-pidfd-bau.log"; exit 0; fi
echo "== $(date +%T) Patch-Kontrolle:"; grep -c "P_PIDFD" "$K/kernel/exit.c" "$K/include/uapi/linux/wait.h"
echo "== $(date +%T) Bau im Container (make Image.gz, inkrementell)"
podman run --rm --memory=3500m --memory-swap=3500m --cpus=4 -v "$K:/buildd/sources:Z" quay.io/droidian/build-essential:current-amd64 \
  sh -c 'apt-get update -qq && apt-get install -y -qq linux-packaging-snippets python-is-python3 libssl-dev libelf-dev bc bison flex cpio xz-utils >/dev/null && apt-get install -y -qq clang-android-9.0-r353983c gcc-4.9-aarch64-linux-android binutils-aarch64-linux-gnu >/dev/null; export PATH=/usr/lib/llvm-android-9.0-r353983c/bin:/usr/lib/gcc-4.9-aarch64-linux-android/bin:$PATH; cd /buildd/sources && make O=/buildd/sources/out/KERNEL_OBJ ARCH=arm64 CC=clang CLANG_TRIPLE=aarch64-linux-gnu- CROSS_COMPILE=aarch64-linux-android- KERNELRELEASE=4.14-190-perf-microsoft-surfaceduo KCFLAGS="-I/buildd/sources/drivers/pinctrl" -j4 Image.gz 2>&1 | grep -E "error|Error|exit\.o|Image|LD .*vmlinux|warning: .*exit\.c" | tail -20'
echo "== $(date +%T) Ergebnis:"; I=$K/out/KERNEL_OBJ/arch/arm64/boot/Image.gz; ls -la "$I" | awk '{print $5, $6, $7, $8}'
mkdir -p out; [ "$I" -nt "$W/kernel-pidfd-bau.log" ] && cp "$I" out/Image-pidfd.gz && echo "out/Image-pidfd.gz bereit"
strings "$K/out/KERNEL_OBJ/vmlinux" | grep -m1 "Linux version 4.14" | cut -c1-120
echo "BAU-ENDE $(date +%T)"
