#!/bin/bash
# Morpheus offline (06.11.2026, operator's request): ONE AppImage that brings everything along — no internet, no workshop.
#   usr/bin/            matrix-morpheus-duo, duo-fedora.sh, morpheus-live.sh, morpheus-lieferant.sh, morpheus-recovery.sh,
#                       fastboot, adb, nc/ncat, telnet (launchers)
#   usr/bin/morpheus-lib/ the tools themselves + their libraries
#   usr/share/morpheus/ boot-duo1-fedora-stufe1-v7.img (start image), matrix-werk.sqfs (+ .sha256, factory image)
# On the laptop:  bash ~/morpheus/bauen-offline.sh   -> ~/Programme/Morpheus.AppImage
set -euo pipefail
B=$HOME/morpheus-bau
M=$HOME/morpheus
OUT=$HOME/duo-a1/out
RT=${RT:-$HOME/Downloads/runtime-aarch64}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/extra" "$T/data/morpheus"
cp "$M/duo-fedora.sh" "$M/morpheus-netz.sh" "$M/morpheus-live.sh" "$M/morpheus-lieferant.sh" "$M/morpheus-recovery.sh" "$T/extra/"
bash "$M/werkzeuge-packen.sh" "$T/extra"
cp "$OUT/boot-duo1-fedora-stufe1-v7.img" "$OUT/werk/matrix-werk.sqfs" "$OUT/werk/matrix-werk.sqfs.sha256" "$T/data/morpheus/"
# Check before packing: the factory image must match its checksum.
( cd "$T/data/morpheus" && [ "$(sha256sum < matrix-werk.sqfs | cut -d' ' -f1)" = "$(cut -d' ' -f1 matrix-werk.sqfs.sha256)" ] ) \
  || { echo "Werksabbild passt nicht zu seiner Prüfsumme"; exit 1; }
cp "$OUT/matrix-apps/matrix-morpheus-duo" "$B/matrix-morpheus-duo"
mkdir -p "$HOME/Programme"
DATA="$T/data" "$M/make-appimage.sh" "$B/matrix-morpheus-duo" "Morpheus" "$B/matrix-morpheus-duo.png" "$RT" \
  "$HOME/Programme/Morpheus.AppImage.neu" "$B/fonts" "$T/extra"
# Swap instead of overwrite: an open Morpheus keeps running with the old file (otherwise «busy»).
mv -f "$HOME/Programme/Morpheus.AppImage.neu" "$HOME/Programme/Morpheus.AppImage"
echo "Morpheus.AppImage ersetzt (ein offenes Morpheus zeigt die neue Fassung nach dem Neustart)"
