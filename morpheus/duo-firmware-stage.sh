#!/bin/bash
# Copy missing firmware files from the device (Android partitions, ro) to /lib/firmware. Idempotent.
F=/lib/firmware; I=/android/firmware_mnt/image; V=/android/vendor
cp -n $I/modem.* $I/adsp.* $I/venus.* $I/cdsp.* $I/slpi.* $I/wlanmdsp.mbn $I/bdwlan.bin $I/*.jsn $I/ipa_fws.* $F/ 2>/dev/null
[ -d $I/modem_pr ] && cp -rn $I/modem_pr $F/ 2>/dev/null
mkdir -p $F/wlan/qca_cld
[ -e $F/wlan/qca_cld/WCNSS_qcom_cfg.ini ] || cp -L $V/etc/wifi/WCNSS_qcom_cfg.ini $F/wlan/qca_cld/ 2>/dev/null
# Morpheus (06.11.2026): the Wi-Fi addresses of THIS device (from the chip serial number, like duo-wlfwd-start) —
# previously a fixed address for every Duo stood here.
if [ ! -e $F/wlan/qca_cld/wlan_mac.bin ]; then
  S=$(cat /sys/devices/soc0/serial_number 2>/dev/null || cat /etc/machine-id); H=$(printf '%s' "$S" | sha256sum | cut -c1-5 | tr a-f A-F)
  printf "Intf0MacAddress=024D53%s0\nIntf1MacAddress=024D53%s1\nIntf2MacAddress=024D53%s2\nIntf3MacAddress=024D53%s3\nEND\n" $H $H $H $H > $F/wlan/qca_cld/wlan_mac.bin
fi
for a in a640_gmu.bin a640_zap.mdt a640_zap.b00 a640_zap.b01 a640_zap.b02 a630_sqe.fw; do [ -e $F/$a ] || cp -n $V/firmware/$a $F/ 2>/dev/null; done
ls $F/modem.mdt $F/wlanmdsp.mbn $F/wlan/qca_cld/WCNSS_qcom_cfg.ini 2>&1 | grep -c "No such" | sed 's/^/fehlend: /'

# Morpheus (06.11.2026): EVERY device-bound file per the mapping list (target <TAB> partition:path), built from
# comparing against the partitions — the factory image carries no firmware, every Duo fetches its own. Read-only.
Q=/usr/local/share/morpheus/firmware-quellen.tsv
if [ -r $Q ]; then
  SLOT=$(tr ' ' '\n' < /proc/cmdline | sed -n 's/^androidboot.slot_suffix=_//p' | head -1); SLOT=${SLOT:-a}
  B=/android/bluetooth; mkdir -p $B
  mountpoint -q $B || mount -o ro /dev/disk/by-partlabel/bluetooth_$SLOT $B 2>/dev/null || mount -o ro /dev/disk/by-partlabel/bluetooth $B 2>/dev/null
  n=0; fehlt=0
  while IFS=$'\t' read -r ziel quelle; do
    [ "$quelle" = "?" ] && continue
    teil=${quelle%%:*}; pfad=${quelle#*:}
    case $teil in
      modem*) von=/android/firmware_mnt/$pfad ;;
      vendor) von=/android/vendor/$pfad ;;
      bluetooth*) von=$B/$pfad ;;
      *) continue ;;
    esac
    [ -e "/$ziel" ] && continue
    if [ -e "$von" ]; then mkdir -p "$(dirname "/$ziel")"; cp -n "$von" "/$ziel" && n=$((n+1)); else fehlt=$((fehlt+1)); fi
  done < $Q
  echo "Zuordnungsliste: $n nachgeholt, $fehlt nicht gefunden"
fi
