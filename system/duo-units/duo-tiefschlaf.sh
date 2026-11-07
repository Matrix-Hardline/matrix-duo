#!/bin/sh
# duo-tiefschlaf (03.11.2026): enables the CPU deep sleep that Microsoft's kernel command line
# (lpm_levels.sleep_disabled=1) forbids — Android writes the same N after boot. Measured: −20 mA in the dark.
# Fallback safety: a marker exists while deep sleep is enabled; a clean shutdown removes it.
# If it is still there at boot (freeze -> long power press), deep sleep stays OFF this time.
# Disable entirely: systemctl disable --now duo-tiefschlaf
P=/sys/module/lpm_levels/parameters/sleep_disabled
M=/var/lib/duo/tiefschlaf-aktiv
mkdir -p /var/lib/duo
if [ -e "$M" ]; then
  rm -f "$M"; sync
  echo "duo-tiefschlaf: letzter Lauf endete unsauber mit freiem Tiefschlaf — diesmal bleibt er aus"
  exec sleep infinity
fi
sleep 60
date > "$M"; sync
echo N > "$P" && echo "duo-tiefschlaf: CPU-Tiefschlaf frei ($(cat $P))"
exec sleep infinity
