#!/bin/bash
# Morpheus M1b (06.11.2026): build the FACTORY IMAGE — rootfs-duo-42 without anything personal, as squashfs.
# Usage on the laptop as root: werksabbild.sh   (needs sqfstar, python3; ~5–10 min)
# Result: ~/duo-a1/out/werk/matrix-werk.sqfs (+ .sha256, bericht.tsv, firmware-quellen.tsv)
set -euo pipefail
R=/home/user/duo-a1/rootfs-duo-42
H=$(dirname "$(readlink -f "$0")")
O=/home/user/duo-a1/out/werk; mkdir -p "$O"
T0=$(date +%s)
# The same exclusions as repack-rootfs.sh (toolchains, build folders, caches).
EX=$(grep -o -- "--exclude=[^ ]*" /home/user/duo-a1/repack-rootfs.sh | tr '\n' ' ')
cut -f1 "$H/firmware-quellen.tsv" > "$O/firmware-geraet.txt"
rm -f "$O/matrix-werk.sqfs.neu"
eval tar -C "$R" $EX -cf - . | python3 "$H/werksabbild.py" "$O/firmware-geraet.txt" "$O/bericht.tsv" \
  | sqfstar -comp xz -b 1M -Xdict-size 1M -quiet -no-progress "$O/matrix-werk.sqfs.neu"
mv "$O/matrix-werk.sqfs.neu" "$O/matrix-werk.sqfs"
sha256sum "$O/matrix-werk.sqfs" | cut -d' ' -f1 > "$O/matrix-werk.sqfs.sha256"
cp "$H/firmware-quellen.tsv" "$O/"
chown -R "${SUDO_USER:-root}": "$O"
echo "werksabbild: $(stat -c %s "$O/matrix-werk.sqfs") Bytes, $(( $(date +%s)-T0 )) s"
cut -f1 "$O/bericht.tsv" | sort | uniq -c | sed 's/^/werksabbild: /'
echo "werksabbild: FERTIG"
