#!/bin/bash
# Build Phosh 0.48 with the Duo patch in a Fedora 42 chroot on the laptop (kernel 7.x -> GLib tools run). As root.
set -e
R=/home/user/duo-a1/rootfs-duo-42; W=/home/user/duo-a1
echo "== $(date +%T) Bauabhängigkeiten in den chroot"
dnf -y -q --use-host-config --installroot="$R" --releasever=42 --setopt=install_weak_deps=False install rpm-build dnf-plugins-core gcc gcc-c++ meson ninja-build git 2>&1 | tail -1
dnf -y -q --use-host-config --installroot="$R" --releasever=42 --setopt=install_weak_deps=False builddep mesa 2>&1 | tail -1
echo "== $(date +%T) Quellen in den chroot"
mkdir -p "$R/root/rpmbuild"; rm -rf "$R/root/rpmbuild/"{SPECS,SOURCES,BUILD,RPMS}; cp -a "$W/mesa-rpm/SPECS" "$W/mesa-rpm/SOURCES" "$R/root/rpmbuild/"
for m in proc sys dev dev/pts; do mountpoint -q "$R/$m" || mount --bind "/$m" "$R/$m"; done
cp /etc/resolv.conf "$R/etc/resolv.conf" 2>/dev/null || true
echo "== $(date +%T) rpmbuild"
chroot "$R" /bin/bash -c 'cd /root/rpmbuild/SPECS && rpmbuild -bb --nocheck mesa.spec' > "$W/mesa-bau.log" 2>&1 && echo "BAU OK" || echo "BAU FEHLER"
grep -E "^Wrote:" "$W/mesa-bau.log" | tail -5
for m in dev/pts dev sys proc; do umount "$R/$m" 2>/dev/null || true; done
mkdir -p "$W/out/mesa-rpm"; cp "$R"/root/rpmbuild/RPMS/aarch64/mesa-*.rpm "$W/out/mesa-rpm/" 2>/dev/null; ls "$W/out/mesa-rpm/" 2>/dev/null
echo "ENDE $(date +%T)"
