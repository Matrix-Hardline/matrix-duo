#!/bin/bash
# Morpheus offline (06.11.2026): pack the laptop tools Morpheus needs, together with their libraries, into one folder
# — fastboot, adb (android-tools), nc (ncat) and telnet. glibc itself stays the laptop's own.
# Usage: werkzeuge-packen.sh <target folder>   (target = usr/bin of the AppImage; tools + libraries go to morpheus-lib/)
set -euo pipefail
Z=$1; L=$Z/morpheus-lib
mkdir -p "$Z" "$L"
for t in fastboot adb ncat telnet; do
  src=$(command -v $t)
  install -m755 "$src" "$L/$t.bin"
  ldd "$src" | awk '/=> \//{print $3}' | while read -r lib; do
    case "$(basename "$lib")" in libc.so*|libm.so*|libpthread.so*|libdl.so*|librt.so*|ld-linux*) continue ;; esac
    cp -L "$lib" "$L/"
  done
  # Small launcher: the bundled libraries first.
  printf '#!/bin/sh\nD=$(cd "$(dirname "$(readlink -f "$0")")/morpheus-lib" && pwd)\nLD_LIBRARY_PATH="$D${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$D/%s.bin" "$@"\n' "$t" > "$Z/$t"
  chmod 755 "$Z/$t"
done
ln -sf ncat "$Z/nc"
echo "werkzeuge: $(ls "$L" | wc -l) Dateien, $(du -sh "$L" | cut -f1)"
