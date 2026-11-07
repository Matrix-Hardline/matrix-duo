#!/bin/bash
# Hide apps from the app list and search (not uninstall): a copy of the launcher with NoDisplay=true in
# /usr/local/share/applications overrides /usr/share/applications (same ID, higher priority). Requested by the owner 31.10.
# Usage: duo-apps-ausblenden.sh [ROOT]   (ROOT = image directory, otherwise /)
R=${1:-}
for id in foot.desktop footclient.desktop foot-server.desktop org.gnome.Console.desktop org.gnome.Screenshot.desktop; do
  src="$R/usr/share/applications/$id"; dst="$R/usr/local/share/applications/$id"
  [ -f "$src" ] || { echo "fehlt: $id"; continue; }
  mkdir -p "$(dirname "$dst")"
  sed '/^NoDisplay=/d; 0,/^\[Desktop Entry\]/s//[Desktop Entry]\nNoDisplay=true/' "$src" > "$dst"
  chmod 644 "$dst"; echo "ausgeblendet: $id"
done
