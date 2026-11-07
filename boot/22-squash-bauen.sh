#!/bin/bash
# 22-squash-bauen.sh: build rootfs.squashfs from the finished rootfs.tar.gz (same exclusion list as repack-rootfs.sh).
# Run on the laptop: bash ~/duo-a1/22-squash-bauen.sh   (needs squashfs-tools: sqfstar). Takes ~3-5 min.
set -e; cd ~/duo-a1/out; [ -s rootfs.tar.gz ] || { echo "rootfs.tar.gz fehlt"; exit 1; }
command -v sqfstar >/dev/null || { echo "sqfstar fehlt: sudo dnf install squashfs-tools"; exit 2; }
T0=$(date +%s); rm -f rootfs.squashfs.neu
zcat rootfs.tar.gz | sqfstar -comp xz -b 1M -Xdict-size 1M -quiet -no-progress rootfs.squashfs.neu
mv rootfs.squashfs.neu rootfs.squashfs; ls -la rootfs.squashfs | awk '{print $5, $9}'; echo "fertig nach $(( $(date +%s)-T0 )) s"
