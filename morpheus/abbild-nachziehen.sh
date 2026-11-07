#!/bin/bash
# Morpheus M1a (06.11.2026): bring the Duo image (rootfs-duo-42) up to the state of the device — PRODUCT only, nothing personal.
# Run on the laptop as root: abbild-nachziehen.sh <nachziehen.tar> <bgutil.tar> <skel-niri.tar>
#   nachziehen.tar  system files that are new on the device (greetd login, Matrix session, fonts, app entries)
#   bgutil.tar      Tube's YouTube token helper (server/ + plugin/yt_dlp_plugins) — so far only in the «mobile» account
#   skel-niri.tar   the window configuration (~/.config/niri) as the base setup of every new account
set -euo pipefail
R=/home/user/duo-a1/rootfs-duo-42
NZ=$1; BG=$2; SK=$3
say() { echo "abbild-nachziehen: $*"; }

say "1) Systemdateien vom Gerät"
tar -C "$R" -xpf "$NZ"

say "2) Pakete (Anmeldung, Tube, Schrift)"
rm -f "$R/etc/resolv.conf"; cp /etc/resolv.conf "$R/etc/resolv.conf"
mount --bind /proc "$R/proc"
chroot "$R" dnf -y -q --setopt=install_weak_deps=False install greetd greetd-selinux yt-dlp rsms-inter-vf-fonts nodejs 2>&1 | tail -2
umount "$R/proc"
rm -f "$R/etc/resolv.conf"; ln -s ../run/systemd/resolve/stub-resolv.conf "$R/etc/resolv.conf"
# greetd is the login service (not GDM).
ln -sfn /usr/lib/systemd/system/greetd.service "$R/etc/systemd/system/display-manager.service"

say "3) Tubes Token-Helfer für alle Konten"
mkdir -p "$R/usr/local/lib/matrix-tube" "$R/etc/yt-dlp-plugins/bgutil"
rm -rf "$R/usr/local/lib/matrix-tube/bgutil-server" "$R/etc/yt-dlp-plugins/bgutil/yt_dlp_plugins"
T=$(mktemp -d); tar -C "$T" -xf "$BG"
mv "$T/server" "$R/usr/local/lib/matrix-tube/bgutil-server"
mv "$T/plugin/yt_dlp_plugins" "$R/etc/yt-dlp-plugins/bgutil/yt_dlp_plugins"
[ -f "$T/LICENSE" ] && cp "$T/LICENSE" "$R/usr/local/lib/matrix-tube/bgutil-server/LICENSE"
rm -rf "$T"
cat > "$R/etc/systemd/user/bgutil-pot.service" <<'UNIT'
[Unit]
Description=Matrix Tube: PO-Token-Anbieter (bgutil, localhost:4416)
[Service]
WorkingDirectory=/usr/local/lib/matrix-tube/bgutil-server
ExecStart=/usr/bin/node build/main.js --host 127.0.0.1 --port 4416
Restart=on-failure
[Install]
WantedBy=default.target
UNIT

say "4) Benutzerdienste für jedes Konto einschalten"
mkdir -p "$R/etc/systemd/user/default.target.wants"
for u in bgutil-pot duo-bildton; do
  [ -f "$R/etc/systemd/user/$u.service" ] && ln -sfn "/etc/systemd/user/$u.service" "$R/etc/systemd/user/default.target.wants/$u.service"
done

say "5) Grundausstattung neuer Konten (Fenster-Konfiguration)"
mkdir -p "$R/etc/skel/.config/niri"
tar -C "$R/etc/skel/.config/niri" -xf "$SK"
rm -f "$R"/etc/skel/.config/niri/*.vor* "$R"/etc/skel/.config/niri/*.an
chown -R root:root "$R/etc/skel"

say "6) Rechte an die Admin-Gruppe statt an «mobile»"
echo '%wheel ALL=(root) NOPASSWD: /usr/local/bin/duo-panels' > "$R/etc/sudoers.d/duo-panels"
chmod 440 "$R/etc/sudoers.d/duo-panels"
sed -i 's/subject.user == "mobile"/subject.isInGroup("wheel")/' "$R/etc/polkit-1/rules.d/50-duo-networkmanager.rules"

say "Kontrolle"
for f in etc/greetd/config.toml usr/local/bin/niri-canvas-session usr/local/share/wayland-sessions/matrix-canvas.desktop usr/share/fonts/matrix/symbols-rounded.ttf etc/skel/.config/niri/canvas-session.kdl etc/yt-dlp-plugins/bgutil/yt_dlp_plugins/extractor/getpot_bgutil_http.py usr/local/lib/matrix-tube/bgutil-server/build/main.js usr/share/backgrounds/matrix/matrix-standard.jpg; do
  [ -e "$R/$f" ] && echo "  ok  $f" || echo "  FEHLT  $f"
done
chroot "$R" rpm -q greetd yt-dlp rsms-inter-vf-fonts nodejs | sed 's/^/  /'
grep -c mobile "$R/etc/sudoers.d/duo-panels" "$R/etc/polkit-1/rules.d/50-duo-networkmanager.rules" | sed 's/^/  «mobile» noch in: /'
say "FERTIG"
