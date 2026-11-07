#!/bin/bash
# Surface Duo 1: rebuild the kernel image incrementally WITH SQUASHFS (compressed root: squashfs + overlay instead of 2.6 GB tmpfs).
# Base: 13-kernel-pidfd-bauen.sh (patch kernel-waitid-P_PIDFD stays, the trace patch is no longer in the tree).
# Same KERNELRELEASE (vermagic stays, WLAN/audio modules still fit). the owner starts this himself.
# Runs in the background; log ~/duo-a1/kernel-squashfs-bau.log. Result: ~/duo-a1/out/Image-squashfs.gz
W=/home/user/duo-a1; K=$W/surface-duo-oss-kernel.msm-4.14; cd "$W" || exit 1
if [ "$1" != "--vordergrund" ]; then nohup "$0" --vordergrund > "$W/kernel-squashfs-bau.log" 2>&1 & echo "Kernel-Bau läuft im Hintergrund (PID $!). Protokoll: $W/kernel-squashfs-bau.log"; exit 0; fi
echo "== $(date +%T) Patch-Kontrolle:"; grep -c "P_PIDFD" "$K/kernel/exit.c" "$K/include/uapi/linux/wait.h"; grep -c "card_mutex_trace\|DUO-TRACE" "$K/sound/core/init.c" 2>/dev/null || echo "kein Trace-Patch im Baum (gut)"
echo "== $(date +%T) Bau im Container (make Image.gz, inkrementell)"
podman run --rm --memory=3500m --memory-swap=3500m --cpus=4 -v "$K:/buildd/sources:Z" quay.io/droidian/build-essential:current-amd64 \
  sh -c 'apt-get update -qq && apt-get install -y -qq linux-packaging-snippets python-is-python3 libssl-dev libelf-dev bc bison flex cpio xz-utils >/dev/null && apt-get install -y -qq clang-android-9.0-r353983c gcc-4.9-aarch64-linux-android binutils-aarch64-linux-gnu >/dev/null; export PATH=/usr/lib/llvm-android-9.0-r353983c/bin:/usr/lib/gcc-4.9-aarch64-linux-android/bin:$PATH; cd /buildd/sources && ./scripts/config --file out/KERNEL_OBJ/.config --enable SQUASHFS --enable SQUASHFS_FILE_DIRECT --enable SQUASHFS_DECOMP_MULTI_PERCPU --enable SQUASHFS_XATTR --enable SQUASHFS_ZLIB --enable SQUASHFS_LZ4 --enable SQUASHFS_XZ --enable SQUASHFS_ZSTD --disable SQUASHFS_EMBEDDED && make O=/buildd/sources/out/KERNEL_OBJ ARCH=arm64 CC=clang CLANG_TRIPLE=aarch64-linux-gnu- CROSS_COMPILE=aarch64-linux-android- olddefconfig >/dev/null && grep -E "^CONFIG_SQUASHFS(|_XZ|_LZ4|_ZSTD)=" out/KERNEL_OBJ/.config && make O=/buildd/sources/out/KERNEL_OBJ ARCH=arm64 CC=clang CLANG_TRIPLE=aarch64-linux-gnu- CROSS_COMPILE=aarch64-linux-android- KERNELRELEASE=4.14-190-perf-microsoft-surfaceduo KCFLAGS="-I/buildd/sources/drivers/pinctrl" -j4 Image.gz 2>&1 | grep -E "error|Error|exit\.o|Image|LD .*vmlinux|warning: .*exit\.c" | tail -20'
echo "== $(date +%T) Ergebnis:"; I=$K/out/KERNEL_OBJ/arch/arm64/boot/Image.gz; ls -la "$I" | awk '{print $5, $6, $7, $8}'
mkdir -p out; [ "$I" -nt "$W/kernel-squashfs-bau.log" ] && cp "$I" out/Image-squashfs.gz && echo "out/Image-squashfs.gz bereit"
strings "$K/out/KERNEL_OBJ/vmlinux" | grep -m1 "Linux version 4.14" | cut -c1-120
echo "BAU-ENDE $(date +%T)"
