#!/bin/bash
# Copy missing firmware files from the device (Android partitions, ro) to /lib/firmware. Idempotent.
F=/lib/firmware; I=/android/firmware_mnt/image; V=/android/vendor
cp -n $I/modem.* $I/adsp.* $I/venus.* $I/cdsp.* $I/slpi.* $I/wlanmdsp.mbn $I/bdwlan.bin $I/*.jsn $I/ipa_fws.* $F/ 2>/dev/null
[ -d $I/modem_pr ] && cp -rn $I/modem_pr $F/ 2>/dev/null
mkdir -p $F/wlan/qca_cld
[ -e $F/wlan/qca_cld/WCNSS_qcom_cfg.ini ] || cp -L $V/etc/wifi/WCNSS_qcom_cfg.ini $F/wlan/qca_cld/ 2>/dev/null
[ -e $F/wlan/qca_cld/wlan_mac.bin ] || printf "Intf0MacAddress=024D5344554F\nIntf1MacAddress=024D53445550\nIntf2MacAddress=024D53445551\nIntf3MacAddress=024D53445552\nEND\n" > $F/wlan/qca_cld/wlan_mac.bin
for a in a640_gmu.bin a640_zap.mdt a640_zap.b00 a640_zap.b01 a640_zap.b02 a630_sqe.fw; do [ -e $F/$a ] || cp -n $V/firmware/$a $F/ 2>/dev/null; done
ls $F/modem.mdt $F/wlanmdsp.mbn $F/wlan/qca_cld/WCNSS_qcom_cfg.ini 2>&1 | grep -c "No such" | sed 's/^/fehlend: /'
