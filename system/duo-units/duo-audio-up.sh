#!/bin/bash
# Surface Duo 1: start the ADSP, then load the techpack audio modules in vendor order (after Droidian's sfduo-audio-up.sh).
# Firmware adsp.mdt/b0x in /lib/firmware (from the modem partition). HARD LOCK: no audio modules without an ONLINE ADSP (kernel softlock).
KVER=$(uname -r); SET=/lib/modules/$KVER/audio
[ -n "$(ls $SET/*.ko 2>/dev/null)" ] || { echo "duo-audio: keine Audiomodule in $SET"; exit 1; }
for f in adsp.mdt venus.mdt; do [ -e /lib/firmware/$f ] || cp -n /android/firmware_mnt/image/${f%.mdt}.* /lib/firmware/ 2>/dev/null; done
depmod -a 2>/dev/null
adsp_state() { for d in /sys/bus/msm_subsys/devices/*/; do [ "$(cat $d/name 2>/dev/null)" = adsp ] && { cat $d/state; return; }; done; echo UNBEKANNT; }
for d in /sys/bus/msm_subsys/devices/*/; do [ "$(cat $d/name 2>/dev/null)" = adsp ] && echo RELATED > $d/restart_level; done
[ -e /sys/kernel/boot_adsp/boot ] || modprobe adsp_loader_dlkm 2>&1 | grep -v "^$"   # pulls in apr_dlkm + dependencies (depmod)
echo 1 > /sys/kernel/boot_adsp/boot 2>/dev/null
for i in $(seq 1 20); do [ "$(adsp_state)" = ONLINE ] && break; sleep 1; done
echo "duo-audio: ADSP $(adsp_state) nach ${i}s"
[ "$(adsp_state)" = ONLINE ] || { echo "duo-audio: ADSP nicht ONLINE – Audiokette wird NICHT geladen"; exit 1; }
# SSR route (patch duo_no_pdr): after the ADSP boot, apr must report «Q6 is Up» and create the children (sound-tavil)
for i in $(seq 1 20); do dmesg | grep -q "Q6 is Up" && break; sleep 1; done
dmesg | grep -q "Q6 is Up" && echo "duo-audio: apr meldet Q6 is Up nach ${i}s" || echo "duo-audio: WARNUNG: kein «Q6 is Up» – Soundkarte wird vermutlich nicht erscheinen"
ls /sys/bus/platform/devices | grep -qE "sound-tavil|sound" && echo "duo-audio: sound-Gerät angelegt"
for m in wglink_dlkm q6_pdr_dlkm q6_notifier_dlkm apr_dlkm q6_dlkm native_dlkm pinctrl_wcd_dlkm swr_dlkm swr_ctrl_dlkm platform_dlkm hdmi_dlkm wcd_spi_dlkm stub_dlkm wcd_core_dlkm wcd9xxx_dlkm mbhc_dlkm wsa881x_dlkm wcd934x_dlkm machine_dlkm; do
  grep -q "^$m " /proc/modules || modprobe $m 2>&1 | grep -v "^$"
done
for m in apr_dlkm q6_dlkm wcd934x_dlkm machine_dlkm; do grep -q "^$m " /proc/modules || echo "duo-audio: Modul $m fehlt"; done
for i in $(seq 1 15); do grep -q sm8150 /proc/asound/cards 2>/dev/null && { echo "duo-audio: Soundkarte da"; cat /proc/asound/cards; break; }; sleep 1; done
grep -q sm8150 /proc/asound/cards 2>/dev/null || { echo "duo-audio: keine Soundkarte nach 15 s"; exit 1; }
# Boot sound (request 30.10.): set the speaker path, then play the sound directly via ALSA; if the greeter's PipeWire holds the card, go through that PipeWire.
sleep 2; timeout 40 bash /usr/local/sbin/duo-mixer-speaker.sh 0 >/dev/null 2>&1
if ! timeout 10 aplay -q -D plughw:0,0 /usr/share/sounds/duo/boot.wav 2>/dev/null; then
  runuser -u gdm -- env XDG_RUNTIME_DIR=/run/user/42 timeout 10 pw-play /usr/share/sounds/duo/boot.wav 2>/dev/null || echo "duo-audio: Startklang nicht abspielbar"
fi
exit 0
echo "duo-audio: keine Soundkarte nach 15 s"; cat /proc/asound/cards 2>/dev/null; exit 1
