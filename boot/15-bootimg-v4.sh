#!/bin/bash
# Surface Duo 1 (v4: tty0 = /dev/console, otherwise systemd blocks on ttyGS0 during shutdown, 31.10.): build boot.img (stage 1 v3 ramdisk + stock.dtb) with a new kernel image – step 4 of 5-stufen-bauen.sh.
# Usage on the laptop: sudo bash 14-bootimg-neu.sh <Image.gz>   -> out/boot-duo1-fedora-stufe1-v4.img (fastboot boot only)
set -e; W=/home/user/duo-a1; cd "$W"; IMG="${1:?Image.gz angeben}"; [ -f "$IMG" ]
CMD="androidboot.hardware=surfaceduo androidboot.hardware.platform=qcom androidboot.memcg=1 lpm_levels.sleep_disabled=1 video=vfb:640x400,bpp=32,memsize=3072000 msm_rtb.filter=0x237 service_locator.enable=1 swiotlb=2048 loop.max_part=7 androidboot.usbcontroller=a600000.dwc3 kpti=off buildvariant=user console=ttyGS0,115200 console=tty0 printk.devkmsg=on page_poison=off debug_pagealloc=off rdinit=/init selinux=0 panic=30 msm_poweroff.download_mode=0 systemd.firstboot=0 plymouth.enable=0 systemd.show_status=1"
mkbootimg --header_version 2 --pagesize 4096 --base 0x0 --kernel_offset 0x8000 --ramdisk_offset 0x1000000 --tags_offset 0x100 --dtb_offset 0x1f00000 --os_version 11.0.0 --os_patch_level 2023-08 --kernel "$IMG" --ramdisk out/stufe1.cpio.gz --dtb out/stock.dtb --cmdline "$CMD" -o out/boot-duo1-fedora-stufe1-v4.img
B=out/boot-duo1-fedora-stufe1-v4.img; ls -la $B | awk '{print "  " $5, $9}'
echo "== Prüfung:"; [ "$(head -c 8 $B)" = "ANDROID!" ] && echo "  ANDROID!-Magic ok"; [ "$(od -An -tu4 -j 40 -N 4 $B | tr -d ' ')" = "2" ] && echo "  Header v2 ok"
[ "$(head -c 4 out/stock.dtb | od -An -tx1 | tr -d ' ')" = "d00dfeed" ] && echo "  DTB-Magic ok"; [ "$(zcat "$IMG" | od -An -tx1 -j 56 -N 4 | tr -d ' ')" = "41524d64" ] && echo "  ARM64-Image-Magic ok"
RS=$(stat -c %s out/stufe1.cpio.gz); [ "$RS" -lt 40000000 ] && echo "  Ramdisk $((RS/1024)) KB < 40 MB ABL-Budget ok"; chown "${SUDO_USER:-root}": out/*; echo "FERTIG: $B – nur fastboot boot, nach Doktrin"
