#!/bin/bash
# Check the factory image: nothing personal, everything needed.
M=/var/tmp/werk-m; mkdir -p $M; mountpoint -q $M || mount -o ro,loop /home/user/duo-a1/out/werk/matrix-werk.sqfs $M
cd $M
echo "== Konten (uid>=1000):"; awk -F: '$3>=1000 && $3<60000' etc/passwd; grep -c mobile etc/passwd etc/shadow etc/group etc/gshadow | tr '\n' ' '; echo
echo "== home:"; ls -A home; echo "== root:"; ls -A root | tr '\n' ' '; echo
echo "== WLAN-Profile:"; ls etc/NetworkManager/system-connections
echo "== SSH-Schlüssel:"; ls etc/ssh/ | grep host || echo keine
echo "== machine-id:"; wc -c < etc/machine-id
echo "== Freigabe/Bluetooth:"; ls -A var/lib/matrix/anmeldung var/lib/bluetooth 2>&1 | tr '\n' ' '; echo
# Traces of our own workshop: the search terms (account, Wi-Fi names, home network) live in a LOCAL file
# (spuren.txt next to this script, one line = one regular expression) — they do not belong in a repo.
SP="$(dirname "$(readlink -f "$0")")/spuren.txt"
MUSTER='\bmobile\b|192\.168\.'; [ -f "$SP" ] && MUSTER="$MUSTER|$(grep -v '^#' "$SP" | paste -sd'|')"
echo "== Spuren (Konto/Heimnetz) in etc + usr/local:"; grep -rlIE "$MUSTER" etc usr/local/bin usr/local/share/applications 2>/dev/null | grep -vE "^etc/(services|protocols|hosts|security/access.conf|chrony.conf|nftables|samba|cups|avahi|ppp|pki|java)" | head -20
echo "== Firmware übrig:"; find usr/lib/firmware -type f | wc -l
echo "== Nötiges da:"; for f in etc/greetd/config.toml usr/local/bin/matrix-greeter usr/local/bin/matrix-erststart-helfer etc/systemd/system/sockets.target.wants/matrix-erststart.socket usr/local/bin/duo-wlfwd-start etc/skel/.config/niri/canvas-session.kdl usr/local/bin/niri-canvas usr/local/bin/matrix-bar usr/share/backgrounds/matrix/matrix-standard.jpg etc/yt-dlp-plugins/bgutil/yt_dlp_plugins/extractor/getpot_bgutil_http.py; do { [ -e "$f" ] || [ -L "$f" ]; } && echo "  ok $f" || echo "  FEHLT $f"; done
grep ExecStart etc/systemd/system/duo-wlfwd.service
cd /; umount $M
