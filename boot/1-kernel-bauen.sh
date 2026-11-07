#!/bin/bash
# Build the Microsoft 4.14 kernel for the Surface Duo following the Droidian recipe – in the Droidian build container (arm64), started by the owner.
# Result: ~/duo-a1/packages/*.deb (kernel, modules, boot.img). Duration: natively on 12 cores probably 20–40 min.
set -e
W=/home/user/duo-a1; P=$W/surfaceduo-droidian/kernel-packaging; K=$W/surface-duo-oss-kernel.msm-4.14; cd "$W"
echo "== $(date +%T) Patches anwenden (einmalig)"
if [ ! -f "$K/.patches-angewendet" ]; then
  for p in 0001-dwc3-msm-force-suspend-when-not-in-lpm 0002-adsprpc-ratelimit-bad-ioctl-log 0004-ext4-remove-android-umount_end-hook 0006-sde-idle-power-collapse-off 0007-spcom-serialize-channel-creation; do
    git -C "$K" apply "$P/patches/$p.patch" && echo "  $p ok"
  done
  # Audio techpack: repair the broken symlink (README «Audio modules»)
  if [ -L "$K/techpack/audio/include/soc/internal.h" ]; then (cd "$K/techpack/audio/include/soc" && rm -f internal.h && ln -s ../../../../drivers/base/regmap/internal.h internal.h); fi
  touch "$K/.patches-angewendet"
fi
echo "== $(date +%T) Packaging in den Kernelbaum (setup.sh)"
(cd "$P" && ./setup.sh | tail -2)
echo "== $(date +%T) Baucontainer holen"
podman pull -q quay.io/droidian/build-essential:current-arm64
mkdir -p packages
echo "== $(date +%T) Kernel bauen (Container, Android-Clang 9) – Protokoll: $W/kernel-bau.log"
podman run --rm -v "$W/packages:/buildd:Z" -v "$K:/buildd/sources:Z" quay.io/droidian/build-essential:current-arm64 \
  sh -c 'apt-get update -qq && apt-get install -y -qq linux-packaging-snippets && cd /buildd/sources && rm -f debian/control && debian/rules debian/control && RELENG_HOST_ARCH=arm64 releng-build-package' 2>&1 | tee "$W/kernel-bau.log" | grep -E "^(dpkg-deb|Building|Error|error:|make.*Error|  CC .*vmlinux|  LD .*Image|GZIP)" | tail -20
echo "== $(date +%T) Ergebnis:"; ls -la packages/*.deb 2>/dev/null | awk '{print $5, $9}' || echo "keine .deb – siehe kernel-bau.log"
echo "== Prüfung der gebauten Konfiguration (Prüfbericht):"
C=$(find surface-duo-oss-kernel.msm-4.14 packages -name ".config" 2>/dev/null | head -1); [ -n "$C" ] || C=$(find kimg -name "config-*" 2>/dev/null | head -1)
for o in CONFIG_RD_GZIP CONFIG_FHANDLE CONFIG_DEVTMPFS CONFIG_SECURITY_SELINUX_BOOTPARAM CONFIG_USB_CONFIGFS_ACM CONFIG_USB_CONFIGFS_RNDIS CONFIG_ANDROID_PARANOID_NETWORK CONFIG_QCOM_DLOAD_MODE; do grep -hE "^(# )?$o[ =]" "$C" 2>/dev/null || echo "$o: ?"; done
