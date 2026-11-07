#!/bin/bash
# On the laptop as root: install and enable the Wi-Fi/modem services, scripts, udev/NM config and firmware in rootfs v2.
set -e; R=/home/user/duo-a1/rootfs-duo-42; U=/home/user/duo-a1/duo-units; FW=/home/user/duo-a1/firmware-stage
install -Dm755 $U/android-map.sh $R/usr/local/sbin/android-map.sh
install -Dm755 $U/duo-firmware-stage.sh $R/usr/local/sbin/duo-firmware-stage.sh
for s in $U/duo-*.service; do install -Dm644 $s $R/etc/systemd/system/$(basename $s); done
install -Dm644 $U/50-duo-wifi.conf $R/etc/NetworkManager/conf.d/50-duo-wifi.conf
install -Dm644 $U/97-duo-rmtfs.rules $R/etc/udev/rules.d/97-duo-rmtfs.rules
rm -rf $R/etc/systemd/system/wpa_supplicant.service.d
[ -d $FW ] && cp -rn $FW/. $R/lib/firmware/ && echo "Firmware aus $FW: $(find $FW -type f | wc -l) Dateien"
REL=4.14-190-perf-microsoft-surfaceduo; mkdir -p $R/lib/modules/$REL
K=/home/user/duo-a1/out/modules/wlan-nopanic-noipa.ko; [ -f $K ] || K=/home/user/duo-a1/out/modules/wlan.ko
install -Dm644 $K $R/lib/modules/$REL/wlan.ko && echo "wlan.ko: $K"
mkdir -p $R/var/lib/wlfwd
systemctl --root=$R enable duo-android-map duo-firmware duo-qrtr-ns duo-pd-mapper duo-rmtfs duo-tqftpserv duo-modem duo-wlfwd duo-wlan 2>&1 | grep -c "Created symlink"
ls $R/etc/systemd/system/multi-user.target.wants/ | grep -c duo-
