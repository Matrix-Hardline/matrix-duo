#!/bin/bash
# Map the Android partitions (super, active slot) read-only via dmsetup and mount them under /android/*;
# modem partition to /android/firmware_mnt. Morpheus (06.11.2026): lp-karte.py reads the layout from the
# device's own LP metadata (previously hard-coded for Android 2022.902.48, slot a) — works on every Duo.
SUP=$(readlink -f /dev/disk/by-partlabel/super)
SLOT=$(tr ' ' '\n' < /proc/cmdline | sed -n 's/^androidboot.slot_suffix=_//p' | head -1); SLOT=${SLOT:-a}
python3 /usr/local/bin/lp-karte.py "$SUP" "$SLOT" | while IFS=$'\t' read -r name table; do
  dmsetup info "android-$name" >/dev/null 2>&1 && continue
  echo "$table" | tr ';' '\n' | sed "s#SUPER#$SUP#" | dmsetup create --readonly "android-$name"
done
for p in system vendor product system_ext odm; do
  mkdir -p /android/$p
  mountpoint -q /android/$p || mount -o ro /dev/mapper/android-${p}_$SLOT /android/$p 2>/dev/null
done
mkdir -p /android/firmware_mnt
M=/dev/disk/by-partlabel/modem_$SLOT; [ -e $M ] || M=/dev/disk/by-partlabel/modem
mountpoint -q /android/firmware_mnt || mount -o ro $M /android/firmware_mnt
mount | grep -c " /android/"

# persist (sensor registry, 30.10.): read-only
mkdir -p /android/persist; mountpoint -q /android/persist || mount -o ro /dev/disk/by-partlabel/persist /android/persist 2>/dev/null
