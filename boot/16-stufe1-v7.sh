#!/bin/bash
# Build stage 1 v7: initramfs from v3/v4 + new init (stufe1-v7-init: Fedora partition, e2fsck, boot counter, rescue =
# laptop route) + e2fsck with its libraries from the rootfs; boot.img with the v4 command line (tty0 = /dev/console).
# Run on the laptop: sudo bash 16-stufe1-v7.sh  -> out/boot-duo1-fedora-stufe1-v7.img (fastboot boot only)
set -e
W=/home/user/duo-a1; R=$W/rootfs-duo-42; S=/tmp/stufe1-v7; cd "$W"
rm -rf "$S"; mkdir -p "$S"; (cd "$S" && zcat "$W/out/stufe1.cpio.gz" | cpio -id --quiet)
install -m755 "$W/stufe1-v7-init" "$S/init"
rm -f "$S/stufe2"   # the laptop route runs via v6-squash.sh (telnet), not via /stufe2
mkdir -p "$S/sbin" "$S/lib64" "$S/disk" "$S/lower"
install -m755 "$R/usr/sbin/e2fsck" "$S/sbin/e2fsck"
mkdir -p "$S/lib"
for l in /lib/ld-linux-aarch64.so.1 /lib64/libext2fs.so.2 /lib64/libcom_err.so.2 /lib64/libblkid.so.1 /lib64/libuuid.so.1 \
         /lib64/libe2p.so.2 /lib64/libc.so.6; do
  cp -L "$R$l" "$S$l"
done
chroot "$S" /sbin/e2fsck -V 2>&1 | head -1   # probe: does e2fsck run inside the initramfs?
(cd "$S" && find . | cpio -o -H newc --quiet | gzip -9 > "$W/out/stufe1-v7.cpio.gz")
CMD=$(grep -o 'CMD="[^"]*"' "$W/15-bootimg-v4.sh" | head -1 | sed 's/^CMD="//; s/"$//')
mkbootimg --header_version 2 --pagesize 4096 --base 0x0 --kernel_offset 0x8000 --ramdisk_offset 0x1000000 \
  --tags_offset 0x100 --dtb_offset 0x1f00000 --os_version 11.0.0 --os_patch_level 2023-08 \
  --kernel out/Image-squashfs.gz --ramdisk out/stufe1-v7.cpio.gz --dtb out/stock.dtb --cmdline "$CMD" \
  -o out/boot-duo1-fedora-stufe1-v7.img
B=out/boot-duo1-fedora-stufe1-v7.img
RS=$(stat -c %s out/stufe1-v7.cpio.gz)
echo "Abbild $(stat -c %s $B) B, Ramdisk $((RS/1024)) KB (Budget < 40 MB), console-Reihenfolge: $(strings $B | grep -o 'console=[^ ]*' | tr '\n' ' ')"
[ "$(head -c 8 $B)" = "ANDROID!" ] && echo "ANDROID!-Magic ok"
chown "${SUDO_USER:-root}": out/*; echo "FERTIG: $B – nur fastboot boot"
