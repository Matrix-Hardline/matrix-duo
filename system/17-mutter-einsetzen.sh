#!/bin/bash
# Gebaute Mutter-RPMs (out/mutter-rpm) in den rootfs-Chroot einsetzen. sudo bash ~/duo-a1/17-mutter-einsetzen.sh
R=/home/user/duo-a1/rootfs-duo-42; OUT=/home/user/duo-a1/out/mutter-rpm
ls $OUT/mutter-*.rpm | grep -vE "debug|devel|tests" | sed "s|$OUT|/root/mutter-rpm|" > /tmp/mutter-liste.txt
mkdir -p $R/root/mutter-rpm; cp $OUT/mutter-*.rpm $R/root/mutter-rpm/
chroot $R rpm -Uvh --force $(cat /tmp/mutter-liste.txt) 2>&1 | tail -5
chroot $R rpm -q mutter mutter-common
