#!/bin/bash
# Sound test on the Duo: show the card, set ONLY the speaker path (no bulk start values: «AIF4_VI Mixer SPKR_VI_1» hangs
# the kernel in soc_dpcm_runtime_update and blocks the whole card, 30.10. 00:16), then a quiet 2 s tone via ALSA.
cat /proc/asound/cards; C=$(grep -oE "^ *[0-9]+" /proc/asound/cards | head -1 | tr -d " "); C=${C:-0}
bash /usr/local/sbin/duo-mixer-speaker.sh $C
python3 - <<'PY'
import math,wave,struct
w=wave.open('/tmp/ton.wav','w'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
fr=b''.join(struct.pack('<hh', int(4000*math.sin(2*math.pi*440*i/48000)), int(4000*math.sin(2*math.pi*440*i/48000))) for i in range(48000*2))
w.writeframes(fr); w.close()
PY
aplay -l | grep -E "Gerät 0:|device 0:" | head -1
timeout 12 aplay -q -D plughw:$C,0 /tmp/ton.wav; echo "aplay rc=$?"
