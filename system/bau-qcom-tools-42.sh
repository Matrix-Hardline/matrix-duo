#!/bin/bash
# Build pd-mapper + tqftpserv (with the «without remoteproc» patch) in the Fedora 42 chroot; install rmtfs + qrtr from Fedora.
# Runs as root on the laptop. Result: $R/usr/local/bin/{pd-mapper,tqftpserv}, copies in ~/duo-a1/out/qcom-tools/
set -e
R=/home/user/duo-a1/rootfs-duo-42; W=/home/user/duo-a1; OUT=$W/out/qcom-tools; mkdir -p $OUT
echo "== $(date +%T) Pakete"
dnf -y -q --installroot=$R --releasever=42 install qrtr qrtr-devel rmtfs xz-devel libzstd-devel meson ninja-build gcc 2>&1 | grep -vE "OpenPGP|^\s*$" | tail -2 || true
rm -rf $R/root/src-qcom; mkdir -p $R/root/src-qcom; cp -r $W/src/pd-mapper $W/src/tqftpserv $R/root/src-qcom/
echo "== $(date +%T) Bau im Chroot"
chroot $R /bin/bash -c '
set -e; cd /root/src-qcom/pd-mapper && make -s clean >/dev/null 2>&1 || true; make -s pd-mapper && install -Dm755 pd-mapper /usr/local/bin/pd-mapper
cd /root/src-qcom/tqftpserv && rm -rf build && meson setup build --prefix=/usr/local -Dsystemd-unit-prefix=/usr/local/lib/systemd/system >/dev/null && ninja -C build >/dev/null && install -Dm755 build/tqftpserv /usr/local/bin/tqftpserv
/usr/local/bin/pd-mapper --version 2>/dev/null || true; ls -la /usr/local/bin/pd-mapper /usr/local/bin/tqftpserv /usr/bin/rmtfs /usr/bin/qrtr-ns /usr/bin/qrtr-lookup'
cp $R/usr/local/bin/pd-mapper $R/usr/local/bin/tqftpserv $R/usr/bin/rmtfs $R/usr/bin/qrtr-ns $R/usr/bin/qrtr-lookup $R/usr/bin/qrtr-cfg $OUT/ 2>/dev/null || true
cp $R/usr/lib64/libqrtr.so.1* $OUT/ 2>/dev/null || true
chown -R "${SUDO_USER:-root}": $OUT; ls -la $OUT | awk "{print \$5, \$9}"
echo "ENDE $(date +%T)"
