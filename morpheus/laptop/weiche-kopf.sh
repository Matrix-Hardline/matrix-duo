#!/bin/sh
# Morpheus — ONE file for Linux laptops with ARM (aarch64) AND Intel/AMD (x86_64) (06.11.2026).
# In front this switch, behind it a tar with both builds (aarch64/, x86_64/) and the Duo images (share/) only once.
# On first start it unpacks the matching build + images ONCE into the cache (~1.2 GB), after that it starts
# immediately. No FUSE needed. Run: ./Morpheus.AppImage  (or right-click › «Run as program»)
KENNUNG=@KENNUNG@
ANFANG=@ANFANG@
SELF=$(readlink -f "$0")
melde() {
  echo "morpheus: $*" >&2
  command -v notify-send >/dev/null 2>&1 && notify-send -a Morpheus Morpheus "$*" >/dev/null 2>&1 || true
}
case "$(uname -m)" in
  aarch64|arm64) A=aarch64 ;;
  x86_64|amd64) A=x86_64 ;;
  *) melde "Dieser Prozessor ($(uname -m)) wird nicht unterstützt — Morpheus gibt es für ARM (aarch64) und Intel/AMD (x86_64)."; exit 1 ;;
esac
[ "$(uname -s)" = Linux ] || { melde "Morpheus läuft nur unter Linux."; exit 1; }
frei_kb() { mkdir -p "$1" 2>/dev/null && df -Pk "$1" 2>/dev/null | awk 'NR==2{print $4}'; }
# Where to unpack: MORPHEUS_CACHE, otherwise ~/.cache/morpheus — if there is too little space there (live system), next
# to the file (e.g. on the stick), if it is already unpacked there or there is enough space.
NEBEN=$(dirname "$SELF")/.morpheus-cache
if [ -n "${MORPHEUS_CACHE:-}" ]; then
  BASIS=$MORPHEUS_CACHE
elif [ -f "$NEBEN/$KENNUNG/.fertig-$A" ]; then
  BASIS=$NEBEN
else
  BASIS=${XDG_CACHE_HOME:-$HOME/.cache}/morpheus
  if [ ! -f "$BASIS/$KENNUNG/.fertig-$A" ] && [ "$(frei_kb "$BASIS" || echo 0)" -lt 1600000 ] \
     && [ "$(frei_kb "$NEBEN" || echo 0)" -ge 1600000 ]; then
    BASIS=$NEBEN
  fi
fi
C=$BASIS/$KENNUNG
if [ ! -f "$C/.fertig-$A" ]; then
  mkdir -p "$BASIS" || { melde "Zwischenspeicher $BASIS lässt sich nicht anlegen"; exit 1; }
  frei=$(frei_kb "$BASIS")
  if [ "${frei:-0}" -lt 1600000 ]; then
    melde "Zu wenig Platz in $BASIS: Morpheus braucht beim ersten Start etwa 1,5 GB."; exit 1
  fi
  melde "Morpheus wird beim ersten Start ausgepackt (einmalig, etwa 1,2 GB) — bitte einen Moment …"
  mkdir -p "$C" && rm -rf "$C/$A" "$C/share"
  if ! tail -c +"$ANFANG" "$SELF" | tar -x -C "$C" "$A" share; then
    rm -rf "$C"; melde "Auspacken fehlgeschlagen — ist die Datei vollständig kopiert?"; exit 1
  fi
  soll=$(cut -d' ' -f1 "$C/share/morpheus/matrix-werk.sqfs.sha256" 2>/dev/null)
  ist=$(sha256sum "$C/share/morpheus/matrix-werk.sqfs" 2>/dev/null | cut -d' ' -f1)
  if [ -z "$soll" ] || [ "$soll" != "$ist" ]; then
    rm -rf "$C"; melde "Das Werksabbild ist beschädigt (Prüfsumme) — bitte die Datei neu kopieren."; exit 1
  fi
  touch "$C/.fertig-$A"
  # Clear older builds out of the cache (1.2 GB each).
  for alt in "$BASIS"/*; do [ "$alt" = "$C" ] || rm -rf "$alt"; done
  melde "Ausgepackt — Morpheus startet."
fi
export APPDIR="$C/$A" APPIMAGE="$SELF" MORPHEUS_WEICHE="$A"
exec "$C/$A/AppRun" "$@"
