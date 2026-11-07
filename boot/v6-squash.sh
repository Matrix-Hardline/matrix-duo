#!/bin/bash
# v6 squash: like v5-auto, but stage 2 = rootfs.squashfs (read-only, loop) + tmpfs overlay instead of unpacking a tar into tmpfs.
# Requirement: kernel with CONFIG_SQUASHFS (21-kernel-squashfs-bauen.sh) and out/rootfs.squashfs (22-squash-bauen.sh).
exec >/tmp/v6-squash.log 2>&1
N=""; for d in /sys/class/net/*; do [ "$(cat $d/device/../idProduct 2>/dev/null)" = "0104" ] && N=$(basename $d); done
echo "$(date +%T) Schnittstelle: $N"
sudo ip addr replace 172.16.42.2/24 dev "$N"; sudo ip link set "$N" up; sleep 1
ping -c2 -W2 172.16.42.1 | tail -1
ss -ltn | grep -q ":8000" || (cd ~/duo-a1/out && setsid nohup python3 -m http.server 8000 --bind 172.16.42.2 >/tmp/http.log 2>&1 </dev/null &)
sleep 1
echo "== $(date +%T) Syscall-Probe auf dem Duo (Stufe 1):"
(sleep 1; echo 'cd /tmp && wget -q http://172.16.42.2:8000/syscall-probe && chmod +x syscall-probe && ./syscall-probe; echo PROBE-ENDE'; sleep 8) | timeout 12 telnet 172.16.42.1 23 2>&1 | tr -d "\r" | sed -n '/pidfd_open/,/PROBE-ENDE/p'
echo "== $(date +%T) Stufe 2 ausloesen (squashfs + overlay):"
# Root as a squashfs file in tmpfs (/img), mounted read-only via loop (/lower), write layer tmpfs (/ovl), overlay -> /newroot.
# Compared with unpacking the tar this saves ~1.7 GB of RAM: the file stays compressed, unpacked pages only live in the (reclaimable) page cache.
(sleep 1; echo "mkdir -p /img /lower /ovl; mount -t tmpfs -o size=1400m tmpfs /img; mount -t tmpfs -o size=1500m tmpfs /ovl; mkdir -p /ovl/upper /ovl/work; setsid sh -c \"nc -l -p 9000 > /img/rootfs.squashfs; mount -t squashfs -o loop,ro /img/rootfs.squashfs /lower && mount -t overlay overlay -o lowerdir=/lower,upperdir=/ovl/upper,workdir=/ovl/work /newroot && mkdir -p /newroot/proc /newroot/sys /newroot/dev /newroot/run /newroot/tmp && echo duo-stufe2: squashfs+overlay bereit, Marke /go > /dev/kmsg && touch /go || echo duo-stufe2: FEHLER squashfs/overlay > /dev/kmsg\" >/dev/null 2>&1 </dev/null & sleep 1; echo NC-BEREIT"; sleep 4) | timeout 8 telnet 172.16.42.1 23 2>&1 | tr -d "\r" | grep -aoE "NC-BEREIT" | head -1
echo "sende rootfs.squashfs per nc ..."; T0=$(date +%s); nc --send-only 172.16.42.1 9000 < ~/duo-a1/out/rootfs.squashfs && echo "gesendet nach $(( $(date +%s)-T0 )) s"
echo "== $(date +%T) Konsole ttyACM0 (200 s):"
sudo bash -c "stty -F /dev/ttyACM0 115200 raw -echo 2>/dev/null; timeout 150 cat /dev/ttyACM0" 2>/dev/null | tr -d "\r" | grep -av "^$" | cut -c1-160 > /tmp/v5-konsole.txt
echo "Konsole-Zeilen: $(wc -l < /tmp/v5-konsole.txt)"
grep -aE "systemd\[1\]: systemd [0-9]|Welcome|login:|Failed to spawn|Failed to start|emergency|Reached target (multi-user|network)|Started (sshd|NetworkManager|serial-getty)|panic" /tmp/v5-konsole.txt | head -40
echo "== $(date +%T) SSH:"; timeout 3 bash -c "</dev/tcp/172.16.42.1/22" 2>/dev/null && echo "  22 offen" || echo "  22 zu"
timeout 8 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 mobile@172.16.42.1 'uname -a; systemctl --version | head -1; systemctl --failed --no-legend | head; free -m | head -2' 2>&1 | head -12
echo "== $(date +%T) Nachlauf: Uhr, Route, Phosh (beide Panels)"
NOW=$(date -u +"%Y-%m-%d %H:%M:%S")
timeout 60 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 mobile@172.16.42.1 "sudo date -u -s '$NOW' >/dev/null; sudo ip route replace default via 172.16.42.2 dev rndis0 metric 2000; sudo resolvectl dns rndis0 172.16.42.2; sudo mount -o remount,size=4g /; systemctl is-active duotouch seatd | tr '\n' ' '; echo; grep -E '^N: Name' /proc/bus/input/devices | tr '\n' ';'; echo; setsid nohup /usr/local/bin/true # GNOME startet ueber getty@tty1-Autologin (Marker /etc/duo-gnome-autostart); Phosh: phosh-duo eins >/dev/null 2>&1 < /dev/null & sleep 30; pgrep -x phosh >/dev/null && echo PHOSH-LAEUFT || echo PHOSH-FEHLT; grep -aE 'Output .* added|error\(|Protocol' /tmp/phosh.log | tail -3 | cut -c1-120; for c in DSI-1 DSI-2; do echo \"\$c \$(cat /sys/class/drm/card0-\$c/enabled)\"; done" 2>&1
echo "ENDE $(date +%T)"
