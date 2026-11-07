#!/bin/bash
# Surface Duo 1: fill the root directory for hexagonrpcd (-R) from the Android partitions.
# Mapping (rpcd_builder.c): <R>/sensors/config -> /vendor/etc/sensors/config, <R>/sensors/registry -> persist registry,
# <R>/sensors/sns_reg.conf -> /vendor/etc/sensors/sns_reg_config, <R>/socinfo -> /sys/devices/soc0, <R>/dsp.
R=/usr/share/duo/hexagon
mkdir -p $R/sensors/config $R/sensors/registry $R/socinfo $R/dsp $R/acdb
[ -d /android/vendor/etc/sensors ] || /usr/local/bin/android-map.sh >/dev/null 2>&1
cp -u /android/vendor/etc/sensors/config/*.json $R/sensors/config/ 2>/dev/null
cp -u /android/vendor/etc/sensors/sns_reg_config $R/sensors/sns_reg.conf 2>/dev/null
# Registry: writable copy (the DSP writes calibration into it); copy only the first time
# persist/sensors/registry/registry/ is a directory of group files -> its contents go to <R>/sensors/registry/
[ "$(ls $R/sensors/registry 2>/dev/null | wc -l)" -ge 10 ] || cp -r /android/persist/sensors/registry/registry/. $R/sensors/registry/ 2>/dev/null
for f in hw_platform platform_subtype platform_subtype_id platform_version soc_id revision; do
  [ -r /sys/devices/soc0/$f ] && cp /sys/devices/soc0/$f $R/socinfo/$f 2>/dev/null
done
echo "duo-hexagon-root: $(ls $R/sensors/config | wc -l) Konfigdateien, Registry $(ls $R/sensors/registry | wc -l) Dateien, socinfo $(ls $R/socinfo | wc -l)"
