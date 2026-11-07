#!/bin/bash
# Surface Duo 1: build hexagonrpcd (FastRPC listener for the sensor DSP) with the downstream ABI in the rootfs chroot -> /usr/local.
# Runs on the laptop as root: sudo bash ~/duo-a1/bau-hexagonrpc-42.sh   (source ~/duo-a1/src/hexagonrpc)
set -e
R=/home/user/duo-a1/rootfs-duo-42; S=/home/user/duo-a1/src/hexagonrpc
[ -d "$S" ] || { echo "Quelle $S fehlt"; exit 1; }
rm -rf $R/root/hexagonrpc; cp -a "$S" $R/root/hexagonrpc
for m in dev proc sys; do mountpoint -q $R/$m || { [ $m = proc ] && mount -t proc proc $R/proc || mount --bind /$m $R/$m; }; done
trap 'for m in sys proc dev; do umount -l $R/$m 2>/dev/null; done' EXIT
echo "== $(date +%T) meson/ninja im Chroot (downstream=true)"
chroot $R /bin/bash -c "cd /root/hexagonrpc && rm -rf build && meson setup build --prefix=/usr/local -Ddownstream=true 2>&1 | tail -3 && ninja -C build 2>&1 | grep -E 'error|warning: impl|FAILED|Linking' | head -20; ninja -C build install 2>&1 | tail -2; ls -la /usr/local/bin/hexagonrpcd /usr/local/lib64/libhexagonrpc.so* 2>/dev/null | awk '{print \$5, \$9}'" > /home/user/duo-a1/out/hexagonrpc-bau.log 2>&1 || true
tail -15 /home/user/duo-a1/out/hexagonrpc-bau.log
echo "BAU-ENDE $(date +%T)"
