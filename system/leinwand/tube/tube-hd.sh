#!/bin/bash
# Matrix Tube, HD setup (R210): PO token provider bgutil (Node service) + yt-dlp plugin.
# Downloads third-party code from the net (GitHub, npm, PyPI) — initiated by the owner.
# Afterwards: service bgutil-pot (user unit) on 127.0.0.1:4416, yt-dlp uses it to fetch HD.
set -e
V=2.0.2
echo "== 1/5 Bauwerkzeuge (Fedora): git, npm, Compiler, canvas-Abhaengigkeiten"
sudo dnf install -y -q git npm gcc-c++ make python3-pip cairo-devel pango-devel libjpeg-turbo-devel giflib-devel librsvg2-devel pixman-devel 2>&1 | tail -1
echo "== 2/5 Anbieter $V holen"
mkdir -p ~/.local/share/matrix-tube; cd ~/.local/share/matrix-tube
rm -rf bgutil-ytdlp-pot-provider
git clone -q --single-branch --branch $V https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git
cd bgutil-ytdlp-pot-provider/server
echo "== 3/5 npm ci + tsc (kann auf dem Duo einige Minuten dauern)"
npm ci --no-audit --no-fund 2>&1 | tail -3
npx tsc
echo "== 4/5 yt-dlp-Plugin"
python3 -m pip install --user -q -U "bgutil-ytdlp-pot-provider==$V"
echo "== 5/5 Dienst (Benutzer-Unit, nur localhost)"
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/bgutil-pot.service <<UNIT
[Unit]
Description=Matrix Tube: PO-Token-Anbieter (bgutil, localhost:4416)
[Service]
WorkingDirectory=%h/.local/share/matrix-tube/bgutil-ytdlp-pot-provider/server
ExecStart=/usr/bin/node build/main.js --host 127.0.0.1 --port 4416
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now bgutil-pot.service
sleep 4; systemctl --user is-active bgutil-pot.service
echo "== Probe: HD-Formate mit Token"
U='https://www.youtube.com/watch?v=9bZkp7q19f0'
timeout 90 yt-dlp -v --js-runtimes node --remote-components ejs:github --extractor-args 'youtube:player_client=mweb,web_safari' -F "$U" 2>&1 | grep -E 'bgutil|pot|^[0-9]+ +(mp4|webm)' | grep -vE 'storyboard' | head -30 | tee /tmp/tube-hd.txt
rm -f /tmp/hd.*
timeout 120 yt-dlp --js-runtimes node --remote-components ejs:github --extractor-args 'youtube:player_client=mweb,web_safari' -f 'bv*[height<=1080]+ba/b' --download-sections '*0-15' --no-part -o '/tmp/hd.%(ext)s' --no-warnings -q "$U" 2>&1 | tail -2 | tee -a /tmp/tube-hd.txt
ls -la /tmp/hd.* 2>&1 | tee -a /tmp/tube-hd.txt
echo "fertig — Ergebnis in /tmp/tube-hd.txt"
