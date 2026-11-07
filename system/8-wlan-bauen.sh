#!/bin/bash
# Surface Duo WLAN-Modul (qcacld-3.0) aus Microsofts OSS-Quellen gegen unseren Kernelbau bauen (Surface Book, amd64-Container).
# Startet sich selbst im Hintergrund; Protokoll ~/duo-a1/wlan-bau.log
W=/home/user/duo-a1; K=$W/surface-duo-oss-kernel.msm-4.14; cd "$W" || exit 1
if [ "$1" != "--vordergrund" ]; then nohup "$0" --vordergrund > "$W/wlan-bau.log" 2>&1 & echo "WLAN-Bau läuft im Hintergrund (PID $!). Protokoll: $W/wlan-bau.log"; exit 0; fi
echo "== $(date +%T) WLAN-Quellen klonen (Microsoft OSS, Zweig surfaceduo/11/2022.902.48)"
mkdir -p wlan; for r in qcacld-3..0 qca-wifi-host-cmn fw-api; do d=wlan/${r/qcacld-3..0/qcacld-3.0}; [ -d "$d/.git" ] || git clone -q --depth 1 -b surfaceduo/11/2022.902.48 "https://github.com/microsoft/surface-duo-oss-platform.vendor.qcom-opensource.wlan.$r" "$d" || exit 1; done; ls wlan
[ -d "$K/out/KERNEL_OBJ" ] || { echo "FEHLER: Kernel-Bauobjekte fehlen (out/KERNEL_OBJ)"; exit 1; }
echo "== $(date +%T) Modul bauen im Container (Android-Clang 9, 4 Kerne, 3,5 GB Deckel)"
podman run --rm --memory=3500m --memory-swap=3500m --cpus=4 -v "$K:/buildd/sources:Z" -v "$W/wlan:/buildd/wlan:Z" quay.io/droidian/build-essential:current-amd64 \
  sh -c 'apt-get update -qq && apt-get install -y -qq linux-packaging-snippets python-is-python3 >/dev/null && apt-get install -y -qq clang-android-9.0-r353983c gcc-4.9-aarch64-linux-android binutils-aarch64-linux-gnu >/dev/null; export PATH=/usr/lib/llvm-android-9.0-r353983c/bin:/usr/lib/gcc-4.9-aarch64-linux-android/bin:$PATH; make -C /buildd/sources O=/buildd/sources/out/KERNEL_OBJ ARCH=arm64 CC=clang CLANG_TRIPLE=aarch64-linux-gnu- CROSS_COMPILE=aarch64-linux-android- M=/buildd/wlan/qcacld-3.0 WLAN_ROOT=/buildd/wlan/qcacld-3.0 WLAN_COMMON_ROOT=../qca-wifi-host-cmn WLAN_COMMON_INC=/buildd/wlan/qca-wifi-host-cmn WLAN_FW_API=/buildd/wlan/fw-api MODNAME=wlan WLAN_PROFILE=default KERNELRELEASE=4.14-190-perf-microsoft-surfaceduo CONFIG_QCA_CLD_WLAN=m CONFIG_PANIC_ON_BUG=n CONFIG_IPA_OFFLOAD=n -j4 modules 2>&1 | tail -5; ls -la /buildd/wlan/qcacld-3.0/wlan.ko'
echo "== $(date +%T) Ergebnis:"; ls -la wlan/qcacld-3.0/wlan.ko 2>/dev/null | awk '{print $5, $9}' && { mkdir -p out/modules; cp wlan/qcacld-3.0/wlan.ko out/modules/wlan-nopanic-noipa.ko; echo "-> out/modules/wlan-nopanic-noipa.ko"; } || echo "kein wlan.ko – siehe Log"
echo "BAU-ENDE $(date +%T)"
