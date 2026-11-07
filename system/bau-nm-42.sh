#!/bin/bash
# NetworkManager 1.52.x (Fedora 42) with a patch: do not append SAE/WPA3 when pmf=disable (like upstream main; kernel 4.14 knows no WPA3).
# As root on the laptop: sources/build deps from the host (network), rpmbuild in the F42 chroot. Log bau-nm-42.log
set -e
R=/home/user/duo-a1/rootfs-duo-42; OUT=/home/user/duo-a1/out/nm-rpm; W=/home/user/duo-a1/nm-src; mkdir -p $OUT $W
echo "== $(date +%T) SRPM holen (Host, F42-Quellrepos)"
cd $W; rm -f NetworkManager-*.src.rpm
dnf -y -q download --source --releasever=42 --enablerepo=fedora-source --enablerepo=updates-source NetworkManager 2>&1 | tail -1
S=$(ls NetworkManager-*.src.rpm | head -1); echo "SRPM: $S"
echo "== $(date +%T) builddep in den Chroot (Host-dnf)"
dnf -y -q builddep --installroot=$R --releasever=42 "$W/$S" 2>&1 | grep -vE "OpenPGP|^\s*$" | tail -1 || true
cp "$W/$S" $R/root/
echo "== $(date +%T) rpmbuild im Chroot"
cat > $R/root/nm-prep.sh <<'EOP'
#!/bin/bash
# runs in %prep after %autosetup (source tree = cwd)
f=src/core/supplicant/nm-supplicant-config.c
sed -i 's#(!is_ap || pmf != NM_SETTING_WIRELESS_SECURITY_PMF_DISABLE)#(pmf != NM_SETTING_WIRELESS_SECURITY_PMF_DISABLE /* no-sae-sed */)#' $f
grep -c no-sae-sed $f
EOP
chmod +x $R/root/nm-prep.sh
for m in dev proc sys; do mountpoint -q $R/$m || { [ $m = proc ] && mount -t proc proc $R/proc || mount --bind /$m $R/$m; }; done
trap 'for m in sys proc dev; do umount -l $R/$m 2>/dev/null; done' EXIT
chroot $R /bin/bash -c "
set -e; rpm -i /root/$S 2>/dev/null; cd /root/rpmbuild/SPECS
grep -q nm-prep.sh NetworkManager.spec || { sed -i 's/^Release:\s*\(.*\)%{?dist}/Release:\t\1.duo%{?dist}/' NetworkManager.spec; sed -i '/^%autosetup/a bash /root/nm-prep.sh' NetworkManager.spec; }
grep -nE '^Release|nm-prep' NetworkManager.spec | head -3
rpmbuild -bb --nocheck NetworkManager.spec 2>&1 | grep -E '^[0-9]+$|^Wrote:|error:|Error ' | tail -30
"
cp $R/root/rpmbuild/RPMS/aarch64/NetworkManager-1*.duo*.rpm $R/root/rpmbuild/RPMS/aarch64/NetworkManager-wifi-*.duo*.rpm $R/root/rpmbuild/RPMS/aarch64/NetworkManager-libnm-*.duo*.rpm $OUT/ 2>/dev/null || true
chown -R "${SUDO_USER:-root}": $OUT; ls $OUT
echo "ENDE $(date +%T)"
