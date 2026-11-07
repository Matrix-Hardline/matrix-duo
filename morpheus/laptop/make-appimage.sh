#!/usr/bin/env bash
# Build a type-2 AppImage for a MatrixKit app — without appimagetool.
#
# The generic type-2 runtime is extracted from any existing AppImage
# (its ELF prefix, length = e_shoff + e_shnum * e_shentsize); the
# squashfs is built by mksquashfs, which on a bootc host lives in a
# throwaway container of the matrix image (the image itself ships
# squashfs-tools since R137, so future hosts have it natively).
#
# Usage (on the build PC):
#   make-appimage.sh <binary> <name> <icon.png> <donor.AppImage> <out.AppImage>
# Example:
#   make-appimage.sh ~/mkbuild/target/release/matrix-for-surface \
#     "Matrix for Surface" /tmp/mfs-icons/hicolor/256x256/apps/matrix-for-surface.png \
#     "$HOME/Programme/Dune 2000.AppImage" "$HOME/Programme/Matrix for Surface.AppImage"
set -euo pipefail

BIN="$1"; NAME="$2"; ICON="$3"; DONOR="$4"; OUT="$5"
# R207: optional font folder (6th argument) — ends up under
# usr/share/fonts in the AppDir; the window house finds it via $APPDIR.
FONTS="${6:-}"
# R207: further binaries next to the app (7th argument: folder) —
# Hardline bundles the node, Rabbit finds it next to itself.
EXTRA="${7:-}"
APP_ID="$(basename "$BIN")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/AppDir/usr/bin"
cp "$BIN" "$WORK/AppDir/usr/bin/"
cp "$ICON" "$WORK/AppDir/$APP_ID.png"
ln -sf "$APP_ID.png" "$WORK/AppDir/.DirIcon"
ln -sf "usr/bin/$APP_ID" "$WORK/AppDir/AppRun"
if [ -n "$EXTRA" ]; then
    cp -a "$EXTRA"/. "$WORK/AppDir/usr/bin/"
fi
if [ -n "$FONTS" ]; then
    mkdir -p "$WORK/AppDir/usr/share/fonts"
    cp -a "$FONTS"/. "$WORK/AppDir/usr/share/fonts/"
fi
# Morpheus offline (06.11.2026): DATA=<folder> ends up under usr/share (images the app brings along).
if [ -n "${DATA:-}" ]; then
    mkdir -p "$WORK/AppDir/usr/share"
    cp -a "$DATA"/. "$WORK/AppDir/usr/share/"
fi
cat > "$WORK/AppDir/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$NAME
Exec=$APP_ID
Icon=$APP_ID
Categories=System;
EOF

# Runtime length from the donor's ELF header (little-endian 64 bit).
OFFSET="$(python3 - "$DONOR" <<'PY'
import struct, sys
h = open(sys.argv[1], "rb").read(64)
assert h[:4] == b"\x7fELF", "donor is not an ELF"
shoff = struct.unpack_from("<Q", h, 0x28)[0]
shent = struct.unpack_from("<H", h, 0x3a)[0]
shnum = struct.unpack_from("<H", h, 0x3c)[0]
print(shoff + shent * shnum)
PY
)"
head -c "$OFFSET" "$DONOR" > "$WORK/runtime"
MAGIC="$(od -An -t x1 -j 8 -N 3 "$WORK/runtime" | tr -d ' \n')"
[ "$MAGIC" = "414902" ] || {
    echo "donor runtime magic is not AI\\x02 (got $MAGIC)" >&2; exit 1
}

if command -v mksquashfs >/dev/null; then
    mksquashfs "$WORK/AppDir" "$WORK/app.squashfs" -root-owned -noappend -quiet -comp gzip -no-progress
else
    podman run --rm -v "$WORK:/work:Z" localhost/matrix:latest bash -c \
        "dnf -y -q install squashfs-tools >/dev/null 2>&1 && \
         mksquashfs /work/AppDir /work/app.squashfs -root-owned -noappend -quiet -comp gzip"
fi

cat "$WORK/runtime" "$WORK/app.squashfs" > "$OUT"
chmod +x "$OUT"
echo "OK: $OUT ($(du -h "$OUT" | cut -f1))"
