#!/bin/bash
# Map the Android partitions (super, slot a) read-only via dmsetup and mount them under /android/*; modem partition to /android/firmware_mnt.
# Extents from lpdump (Surface Duo 1, Android 11 2022.902.48). Reconstructed 29.10.2026 (the original existed only in the device's RAM).
SUP=$(readlink -f /dev/disk/by-partlabel/super)
for t in "odm_a 2448 2048" "product_a 7883984 5120" "system_a 2368800 7889920" "system_ext_a 1065120 10259456" "vendor_a 1412912 11325440"; do
  set -- $t; dmsetup info android-$1 >/dev/null 2>&1 || dmsetup create --readonly android-$1 --table "0 $2 linear $SUP $3"
done
for p in system vendor product system_ext odm; do mkdir -p /android/$p; mountpoint -q /android/$p || mount -o ro /dev/mapper/android-${p}_a /android/$p; done
mkdir -p /android/firmware_mnt
M=/dev/disk/by-partlabel/modem_a; [ -e $M ] || M=/dev/disk/by-partlabel/modem
mountpoint -q /android/firmware_mnt || mount -o ro $M /android/firmware_mnt
mount | grep -c " /android/"

# persist (sensor registry, 30.10.): read-only
mkdir -p /android/persist; mountpoint -q /android/persist || mount -o ro /dev/disk/by-partlabel/persist /android/persist 2>/dev/null
