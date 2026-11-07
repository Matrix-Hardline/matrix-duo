#!/bin/bash
# Surface Duo 1: build libssc (Qualcomm Sensor Core, QMI+Protobuf) in the rootfs chroot and install it to /usr/local.
# Runs on the laptop as root: sudo bash ~/duo-a1/bau-libssc-42.sh   (source: ~/duo-a1/src/libssc, rsync'd from the Surface Book)
set -e
R=/home/user/duo-a1/rootfs-duo-42; S=/home/user/duo-a1/src/libssc
[ -d "$S" ] || { echo "Quelle $S fehlt"; exit 1; }
echo "== $(date +%T) Bauabhaengigkeiten in den Chroot"
dnf -y -q --installroot=$R --releasever=42 install meson ninja-build gcc pkgconf-pkg-config glib2-devel libqmi-devel protobuf-c-devel protobuf-c-compiler 2>&1 | grep -vE "OpenPGP|^\s*$" | tail -1 || true
dnf -y -q --installroot=$R --releasever=42 remove gobject-introspection-devel 2>&1 | tail -1 || true
rm -rf $R/root/libssc; cp -a "$S" $R/root/libssc
for m in dev proc sys; do mountpoint -q $R/$m || { [ $m = proc ] && mount -t proc proc $R/proc || mount --bind /$m $R/$m; }; done
trap 'for m in sys proc dev; do umount -l $R/$m 2>/dev/null; done' EXIT
echo "== $(date +%T) meson/ninja im Chroot"
chroot $R /bin/bash -c "export LANG=C; cd /root/libssc && rm -rf build && meson setup build --prefix=/usr/local && ninja -C build && ninja -C build install && ls -la /usr/local/bin/ssccli /usr/local/lib64/libssc*.so* 2>/dev/null | awk '{print \$5, \$9}'" > /home/user/duo-a1/out/libssc-bau.log 2>&1 || true
echo "== Fehlerzeilen:"; grep -nE "error|Error|FAILED|undefined|No such" /home/user/duo-a1/out/libssc-bau.log | head -20
echo "== Ende des Protokolls:"; tail -8 /home/user/duo-a1/out/libssc-bau.log
echo "BAU-ENDE $(date +%T)"
