#!/bin/bash
# Surface Duo 1: build Mutter (Fedora 42) with a smaller minimum logical area, so that 275 %/300 % scaling become selectable.
# Mutter: src/backends/meta-monitor.c  #define MINIMUM_LOGICAL_AREA (800 * 480)  -> (320 * 240).
# Runs on the laptop as root: sudo bash ~/duo-a1/bau-mutter-42.sh   (takes ~20-30 min). Result: ~/duo-a1/out/mutter-rpm/
set -e
R=/home/user/duo-a1/rootfs-duo-42; OUT=/home/user/duo-a1/out/mutter-rpm; W=/home/user/duo-a1/mutter-src; mkdir -p $OUT $W
echo "== $(date +%T) SRPM holen (Host, F42-Quellrepos)"
cd $W; rm -f mutter-*.src.rpm
dnf -y -q download --source --releasever=42 --enablerepo=fedora-source --enablerepo=updates-source mutter 2>&1 | tail -1
S=$(ls mutter-*.src.rpm | head -1); echo "SRPM: $S"
echo "== $(date +%T) builddep in den Chroot (Host-dnf)"
dnf -y -q builddep --installroot=$R --releasever=42 "$W/$S" 2>&1 | grep -vE "OpenPGP|^\s*$" | tail -1 || true
cp "$W/$S" $R/root/
cat > $R/root/mutter-prep.sh <<'EOP'
f=src/backends/meta-monitor.c
grep -n "define MINIMUM_LOGICAL_AREA" $f
sed -i 's|#define MINIMUM_LOGICAL_AREA (800 \* 480)|#define MINIMUM_LOGICAL_AREA (320 * 240) /* duo-scale */|' $f
grep -c "duo-scale" $f
# Duo: both panels report the same EDID (QCM 0x0001 0x00000001) -> same logical monitor id «EDID:...», windows
# land on one panel when rotating (31.10.). Extend the id with the connector; config matching stays unchanged.
g=src/backends/meta-logical-monitor.c
sed -i 's|g_strdup_printf ("EDID:%s:%s:%s",|g_strdup_printf ("EDID:%s:%s:%s:%s" /* duo-id */, spec->connector,|' $g
grep -c "duo-id" $g
# Duo: Mutter aborts with «Bail out … meta_seat_impl_acquire_touch_state_in_impl: assertion failed» when libinput
# reassigns a contact slot that Mutter still considers taken (31.10.: three crashes, session gone; libevdev
# reported «double tracking ID» before). Instead of ending the whole session: drop the old entry, log a warning.
h=src/backends/native/meta-seat-impl.c
perl -0pi -e 's|  g_assert \(!g_hash_table_contains \(seat_impl->touch_states,\n\s+GINT_TO_POINTER \(seat_slot\)\)\);|  if (g_hash_table_contains (seat_impl->touch_states, GINT_TO_POINTER (seat_slot))) /* duo-touch */\n    {\n      g_warning ("duo-touch: Kontaktplatz %d noch belegt, alter Eintrag verworfen", seat_slot);\n      g_hash_table_remove (seat_impl->touch_states, GINT_TO_POINTER (seat_slot));\n    }|' $h
grep -c "duo-touch" $h
# Duo diagnosis (01.11.): every rotation leaves a ~10 MB graphics buffer per panel lying in the shell (KGSL, survives
# GC; zink/turnip free buffers in the isolated test). Suspicion: old screen surfaces stay stuck in lingering_onscreens.
# Count them and write to the journal (journalctl | grep duo-onscreen).
r=src/backends/native/meta-renderer-native.c
perl -0pi -e 's|(  g_clear_list \(&renderer_native->detached_onscreens,\n\s+g_object_unref\);\n)|$1  g_message ("duo-onscreen: Umbau, noch %u alte Bildschirmflaechen nicht frei", g_list_length (renderer_native->lingering_onscreens)); /* duo-onscreen */\n|; s|(    g_list_remove \(renderer_native->lingering_onscreens, freed_onscreen\);\n)|$1  g_message ("duo-onscreen: alte Bildschirmflaeche frei, noch %u", g_list_length (renderer_native->lingering_onscreens)); /* duo-onscreen */\n|' $r
grep -c "duo-onscreen" $r
# THE rotation leak (01.11., gdb on the Duo): ensure_stage_view_offscreen / _pipeline store with
# g_set_object (&priv->x, g_steal_pointer (&local)) -- g_set_object takes its OWN reference, g_steal_pointer
# prevents the local one from being released -> the intermediate buffers of every panel view (colour + depth/stencil,
# ~10 MB each) and the pipeline (holds the texture) survive every screen rebuild (refcount 2 instead of 1 at teardown).
# Upstream main writes g_set_object (&priv->offscreen, offscreen); same here.
v=clutter/clutter/clutter-stage-view.c
perl -pi -e 's|g_set_object \(&priv->offscreen, g_steal_pointer \(&offscreen\)\);|g_set_object (&priv->offscreen, offscreen); /* duo-offscreen */|; s|g_set_object \(&priv->offscreen_pipeline, g_steal_pointer \(&pipeline\)\);|g_set_object (&priv->offscreen_pipeline, pipeline); /* duo-offscreen */|' $v
grep -c "duo-offscreen" $v
EOP
chmod +x $R/root/mutter-prep.sh
for m in dev proc sys; do mountpoint -q $R/$m || { [ $m = proc ] && mount -t proc proc $R/proc || mount --bind /$m $R/$m; }; done
trap 'for m in sys proc dev; do umount -l $R/$m 2>/dev/null; done' EXIT
echo "== $(date +%T) rpmbuild im Chroot"
chroot $R /bin/bash -c "
set -e; rpm -i /root/$S 2>/dev/null; cd /root/rpmbuild/SPECS
grep -q mutter-prep.sh mutter.spec || { sed -i 's/^Release:\s*\(.*\)%{?dist}/Release:\t\1.duo%{?dist}/' mutter.spec; sed -i '/^%autosetup/a bash /root/mutter-prep.sh' mutter.spec; }
grep -nE '^Release|mutter-prep' mutter.spec | head -3
rpmbuild -bb --nocheck mutter.spec > /root/mutter-bau.log 2>&1 || true; echo '--- letzte 40 Zeilen Bauprotokoll:'; tail -40 /root/mutter-bau.log
"
cp $R/root/rpmbuild/RPMS/aarch64/mutter-*.rpm $OUT/ 2>/dev/null || true; cp $R/root/mutter-bau.log $OUT/mutter-bau.log
ls -la $OUT | awk '{print $5, $9}'
echo "BAU-ENDE $(date +%T)  (dann: rpm -Uvh --force in den Chroot -> 17-mutter-einsetzen.sh)"
