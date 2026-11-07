#!/bin/bash
# Morpheus with a switch (06.11.2026): ONE file for ARM and Intel/AMD laptops.
#   bauen-weiche.sh <aarch64-AppDir> <x86_64-AppDir> <share/morpheus folder> <target>
# Each AppDir is a Morpheus build WITHOUT images (usr/bin + usr/share/fonts); the images (start image,
# factory image + .sha256) live once in share/morpheus. Result: weiche-kopf.sh + tar (aarch64/, x86_64/, share/).
set -euo pipefail
ARM=$1; X86=$2; SHARE=$3; ZIEL=$4
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/weiche.XXXXXX"); trap 'rm -rf "$T"' EXIT
for f in boot-duo1-fedora-stufe1-v7.img matrix-werk.sqfs matrix-werk.sqfs.sha256; do
  [ -f "$SHARE/$f" ] || { echo "fehlt: $SHARE/$f"; exit 1; }
done
[ "$(sha256sum < "$SHARE/matrix-werk.sqfs" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$SHARE/matrix-werk.sqfs.sha256")" ] \
  || { echo "Werksabbild passt nicht zu seiner Prüfsumme"; exit 1; }
mkdir -p "$T/p/share"
for pair in "aarch64:$ARM" "x86_64:$X86"; do
  a=${pair%%:*}; src=${pair#*:}
  [ -x "$src/usr/bin/matrix-morpheus-duo" ] || { echo "keine Morpheus-Fassung in $src"; exit 1; }
  cp -a "$src" "$T/p/$a"
  rm -rf "$T/p/$a/usr/share/morpheus"
  # The images live once alongside: $C/<arch>/usr/share/morpheus -> $C/share/morpheus
  ln -s ../../../share/morpheus "$T/p/$a/usr/share/morpheus"
done
cp -a "$SHARE" "$T/p/share/morpheus"
# Identifier: factory image + both programs — a new build unpacks itself afresh.
KENNUNG=$(cat "$SHARE/matrix-werk.sqfs.sha256" "$ARM/usr/bin/matrix-morpheus-duo" "$X86/usr/bin/matrix-morpheus-duo" | sha256sum | cut -c1-16)
tar -C "$T/p" --owner=0 --group=0 -cf "$T/nutzlast.tar" aarch64 x86_64 share
GROESSE=16384
sed -e "s/@KENNUNG@/$KENNUNG/" -e "s/@ANFANG@/$((GROESSE + 1))/" "$HERE/weiche-kopf.sh" > "$T/kopf"
[ "$(stat -c %s "$T/kopf")" -lt "$GROESSE" ] || { echo "Kopf zu gross"; exit 1; }
# Pad the header with comment lines to exactly GROESSE bytes (the shell reads up to «exec» and never gets past it).
{ cat "$T/kopf"; head -c $((GROESSE - $(stat -c %s "$T/kopf") - 1)) /dev/zero | tr '\0' '#'; echo; } > "$T/kopf.voll"
[ "$(stat -c %s "$T/kopf.voll")" = "$GROESSE" ] || { echo "Kopfgrösse falsch"; exit 1; }
cat "$T/kopf.voll" "$T/nutzlast.tar" > "$ZIEL.neu"
chmod 755 "$ZIEL.neu"; mv -f "$ZIEL.neu" "$ZIEL"
echo "OK: $ZIEL ($(du -h "$ZIEL" | cut -f1), Kennung $KENNUNG)"
