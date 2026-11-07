#!/bin/bash
# M2 in two stages (after the review report): stage 1 = tiny busybox initramfs (RNDIS+ACM, telnet, shell) in boot.img;
# stage 2 = Fedora rootfs.tar.gz from the laptop over USB into tmpfs, switch_root -> systemd. Our own code. Run as root.
set -e -o pipefail
W=/home/user/duo-a1; R=${R:-$W/rootfs-duo}; cd "$W"; mkdir -p out
echo "rootfs: $R – systemd $(chroot "$R" systemctl --version 2>/dev/null | head -1)"
echo "== $(date +%T) 1) rootfs-Korrekturen (Prüfbericht)"
[ -s "$R/etc/machine-id" ] || (uuidgen | tr -d - > "$R/etc/machine-id")
chroot "$R" ssh-keygen -A >/dev/null 2>&1 && echo "  SSH-Hostkeys vorab erzeugt"
printf '[connection]\nid=usb\ntype=ethernet\nautoconnect=true\n[match]\ninterface-name=usb0;rndis0;\n[ipv4]\nmethod=manual\naddress1=172.16.42.1/24\n[ipv6]\nmethod=ignore\n' > "$R/etc/NetworkManager/system-connections/usb0.nmconnection"; chmod 600 "$R/etc/NetworkManager/system-connections/usb0.nmconnection"
rm -f "$R/etc/systemd/system/duo-usb-net.service" "$R/etc/systemd/system/sysinit.target.wants/duo-usb-net.service"   # gadget does stage 1
for u in plymouth-start.service plymouth-quit.service plymouth-quit-wait.service firewalld.service fwupd.service fwupd-refresh.timer; do ln -sf /dev/null "$R/etc/systemd/system/$u"; done
mkdir -p "$R/etc/systemd/journald.conf.d"; printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=48M\n' > "$R/etc/systemd/journald.conf.d/ram.conf"
chroot "$R" systemctl enable serial-getty@ttyGS0.service >/dev/null 2>&1 && echo "  Konsole auf ttyGS0 (USB-ACM) aktiviert"
echo "== $(date +%T) 2) rootfs.tar.gz (schlank)"
tar -C "$R" --exclude=./usr/share/doc --exclude=./usr/share/man --exclude=./usr/share/info --exclude=./usr/share/locale --exclude=./usr/share/licenses --exclude=./var/cache --exclude=./var/lib/dnf --exclude=./var/lib/rpm --exclude=./usr/lib/firmware --exclude=./usr/lib/.build-id --exclude=./usr/share/hwdata --exclude=./usr/share/cracklib --exclude='./usr/lib64/python3*/__pycache__' --exclude=./proc --exclude=./sys --exclude=./dev --exclude=./run --exclude=./tmp -czf out/rootfs.tar.gz .
ls -la out/rootfs.tar.gz | awk '{print "  " $5, $9}'
echo "== $(date +%T) 3) Stufe-1-Initramfs (busybox)"
S=$W/stufe1; rm -rf "$S"; mkdir -p "$S"/{bin,sbin,etc,proc,sys,dev,tmp,run,newroot,usr/bin,usr/sbin}; cp /usr/sbin/busybox "$S/bin/busybox"
cat > "$S/init" <<'I'
#!/bin/busybox sh
/bin/busybox --install -s
mount -t devtmpfs dev /dev; mount -t proc proc /proc; mount -t sysfs sys /sys
mkdir -p /dev/pts; mount -t devpts devpts /dev/pts; mount -t configfs configfs /sys/kernel/config
echo "duo-stufe1: init laeuft (Kernel $(uname -r))" > /dev/kmsg
mkdir -p /sys/fs/pstore; mount -t pstore pstore /sys/fs/pstore 2>/dev/null; mkdir -p /tmp/pstore; cp /sys/fs/pstore/* /tmp/pstore/ 2>/dev/null; echo "duo-stufe1: pstore-Eintraege: $(ls /sys/fs/pstore 2>/dev/null | wc -l)" > /dev/kmsg
G=/sys/kernel/config/usb_gadget/duo; mkdir -p $G; cd $G
echo 0x1d6b > idVendor; echo 0x0104 > idProduct
mkdir -p strings/0x409; echo "Surface-Duo-Fedora-Stufe1" > strings/0x409/product; echo Matrix > strings/0x409/manufacturer; echo duo1 > strings/0x409/serialnumber
mkdir -p configs/c.1/strings/0x409; echo "RNDIS+ACM" > configs/c.1/strings/0x409/configuration
mkdir -p functions/rndis.usb0 functions/acm.GS0 2>/dev/null; ln -sf $G/functions/rndis.usb0 configs/c.1/; ln -sf $G/functions/acm.GS0 configs/c.1/
cd /; for i in $(seq 60); do U=$(ls /sys/class/udc 2>/dev/null | head -1); [ -n "$U" ] && break; sleep 1; done
echo "duo-stufe1: UDC=$U" > /dev/kmsg; echo "$U" > $G/UDC
for i in $(seq 30); do N=$(ls /sys/class/net 2>/dev/null | grep -E "^(usb|rndis)" | head -1); [ -n "$N" ] && break; sleep 1; done
ip addr add 172.16.42.1/24 dev $N 2>/dev/null; ip link set $N up; echo "duo-stufe1: Netz $N 172.16.42.1" > /dev/kmsg
[ -c /dev/ttyGS0 ] && (setsid sh -c 'exec sh </dev/ttyGS0 >/dev/ttyGS0 2>&1' &)
telnetd -b 172.16.42.1:23 -l /bin/sh
echo "duo-stufe1: bereit – telnet 172.16.42.1, Konsole ttyGS0; Stufe 2: /stufe2 (PID 1 uebergibt bei /go)" > /dev/kmsg
# PID 1 waits for the marker /go (sets /stufe2 after unpacking) and then does the switch_root itself
while [ ! -f /go ]; do sleep 1; done
echo "duo-stufe2: PID 1 -> switch_root -> systemd" > /dev/kmsg
killall telnetd 2>/dev/null; killall sh 2>/dev/null; sleep 1
exec switch_root /newroot /usr/lib/systemd/systemd
I
cat > "$S/stufe2" <<'I'
#!/bin/busybox sh
# Stage 2: fetch the Fedora rootfs from the laptop (there: cd ~/duo-a1/out && python3 -m http.server 8000 --bind 172.16.42.2) and start it
set -e; mount -t tmpfs -o size=2560m tmpfs /newroot
echo "hole rootfs.tar.gz ..."; wget -q -O - http://172.16.42.2:8000/rootfs.tar.gz | tar xz -C /newroot; echo "entpackt: $(du -sh /newroot | cut -f1)"
mkdir -p /newroot/proc /newroot/sys /newroot/dev /newroot/run /newroot/tmp
echo "duo-stufe2: Marke /go gesetzt – PID 1 uebergibt an systemd" > /dev/kmsg
touch /go; echo "Uebergabe laeuft – Konsole: ttyACM0, danach ssh mobile@172.16.42.1"
I
chmod 755 "$S/init" "$S/stufe2"; (cd "$S" && find . | cpio -o -H newc --quiet | gzip -9 > "$W/out/stufe1.cpio.gz"); ls -la out/stufe1.cpio.gz | awk '{print "  " $5, $9}'
echo "== $(date +%T) 4) boot.img"
IMG=""; [ -f packages/Image.gz ] && IMG=packages/Image.gz; K=$(ls -1 packages/*.deb 2>/dev/null | grep -E "linux-image-4\.14" | head -1)
if [ -z "$IMG" ] && [ -n "$K" ]; then rm -rf kimg; mkdir kimg; dpkg -x "$K" kimg; IMG=$(find kimg -name "Image.gz" | head -1); fi
[ -n "$IMG" ] || IMG=$(find surface-duo-oss-kernel.msm-4.14 -path "*boot/Image.gz" 2>/dev/null | head -1)
if [ -z "$IMG" ]; then echo "  (noch kein Kernel-Image.gz – boot.img später: dieses Skript erneut ausführen)"; exit 0; fi
CMD="androidboot.hardware=surfaceduo androidboot.hardware.platform=qcom androidboot.memcg=1 lpm_levels.sleep_disabled=1 video=vfb:640x400,bpp=32,memsize=3072000 msm_rtb.filter=0x237 service_locator.enable=1 swiotlb=2048 loop.max_part=7 androidboot.usbcontroller=a600000.dwc3 kpti=off buildvariant=user console=tty0 console=ttyGS0,115200 printk.devkmsg=on page_poison=off debug_pagealloc=off rdinit=/init selinux=0 panic=30 msm_poweroff.download_mode=0 systemd.firstboot=0 plymouth.enable=0 systemd.show_status=1"
mkbootimg --header_version 2 --pagesize 4096 --base 0x0 --kernel_offset 0x8000 --ramdisk_offset 0x1000000 --tags_offset 0x100 --dtb_offset 0x1f00000 --os_version 11.0.0 --os_patch_level 2023-08 --kernel "$IMG" --ramdisk out/stufe1.cpio.gz --dtb out/stock.dtb --cmdline "$CMD" -o out/boot-duo1-fedora-stufe1-v3.img
B=out/boot-duo1-fedora-stufe1-v3.img; ls -la $B | awk '{print "  " $5, $9}'
echo "== Prüfung:"; [ "$(head -c 8 $B)" = "ANDROID!" ] && echo "  ANDROID!-Magic ok"; [ "$(od -An -tu4 -j 40 -N 4 $B | tr -d ' ')" = "2" ] && echo "  Header v2 ok"
[ "$(head -c 4 out/stock.dtb | od -An -tx1 | tr -d ' ')" = "d00dfeed" ] && echo "  DTB-Magic ok"; [ "$(zcat "$IMG" | od -An -tx1 -j 56 -N 4 | tr -d ' ')" = "41524d64" ] && echo "  ARM64-Image-Magic ok"
RS=$(stat -c %s out/stufe1.cpio.gz); [ "$RS" -lt 40000000 ] && echo "  Ramdisk $((RS/1024)) KB < 40 MB ABL-Budget ok"; chown "${SUDO_USER:-root}": out/*; echo "FERTIG: $B – nur fastboot boot, nach Doktrin"
