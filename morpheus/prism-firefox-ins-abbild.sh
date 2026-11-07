#!/bin/bash
# Morpheus (06.11.2026, request by the owner): Firefox and Prism (Minecraft Java) work on a FRESHLY installed
# Duo without any rework — just like on the owner's Duo, but without his account.
#
# What was needed by hand on the owner's Duo and moves into the image here:
#   - Prism Launcher 11.1.1 aarch64 (AppImage, unpacked) — previously in /home/mobile/Programme/prism, now system-wide
#     /usr/local/lib/prism (root, read-only; Prism's data lives per account in ~/.local/share/PrismLauncher).
#   - pidfd patch: Qt 6 starts programs with clone(CLONE_PIDFD), which the 4.14 kernel rejects («Launch failed»,
#     the Microsoft sign-in opened no browser). sharun loads it via .preload — now with a fixed system path.
#   - Launcher /usr/local/bin/minecraft: xwayland-satellite when needed (Minecraft 26.x runs via XWayland), Qt on Wayland.
#   - Prism default settings for new accounts (/etc/skel): Java 25 from Fedora (no Java download, no wizard),
#     the system's GLFW (aarch64), 2 GB memory.
#   - Firefox: profile «duo» for new accounts (empty) with the window adjustment (userChrome.css: lift the minimum width,
#     scroll dialog windows instead of cutting them off); Firefox as the default for links (Prism's sign-in opens it).
# Java 25/21, glfw, xwayland-satellite, xdg-utils, firefox, firefox-langpacks are already in the image (checked 06.11.).
#
# Usage on the laptop:  sudo bash prism-firefox-ins-abbild.sh <prism-squashfs-root.tar> <pidfd-shim.so>
set -euo pipefail
R=/home/user/duo-a1/rootfs-duo-42
TAR=$1; SHIM=$2
[ "$(id -u)" = 0 ] || { echo "bitte mit sudo"; exit 1; }
[ -d "$R/usr/local" ] || { echo "$R fehlt"; exit 2; }

P=$R/usr/local/lib/prism
rm -rf "$P"; mkdir -p "$P"
tar -C "$P" -xf "$TAR" --no-same-owner
install -m755 "$SHIM" "$P/pidfd-shim.so"
echo "/usr/local/lib/prism/pidfd-shim.so" > "$P/.preload"
chown -R root:root "$P"; chmod -R go-w "$P"

cat > "$R/usr/local/bin/minecraft" <<'EOF'
#!/bin/sh
# Minecraft (Java) on the Surface Duo: Prism Launcher (aarch64), Java 25 from Fedora, OpenGL = Zink on Turnip.
# Minecraft 26.x picks XWayland by itself.
D=/usr/local/lib/prism
# X11: xwayland-satellite if none is running; ends together with Prism (otherwise it would linger as an orphan).
OWN=""
if [ -z "$DISPLAY" ] && command -v xwayland-satellite >/dev/null; then
    if ! pgrep -x xwayland-satell >/dev/null; then
        setsid xwayland-satellite :7 >/dev/null 2>&1 &
        OWN=$!
    fi
    export DISPLAY=:7
fi
export QT_QPA_PLATFORM=wayland
# Prism's language = Matrix language (account before device), once on first start — otherwise Prism's wizard asks.
CFG=${XDG_DATA_HOME:-$HOME/.local/share}/PrismLauncher/prismlauncher.cfg
if [ -f "$CFG" ] && ! grep -q "^Language=" "$CFG"; then
    L=$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/matrix/languages" 2>/dev/null || cat /etc/matrix/languages 2>/dev/null)
    case "$L" in en*) PL=en_GB ;; *) PL=de ;; esac
    sed -i "/^\[General\]/a Language=$PL" "$CFG"
fi
# pidfd-shim: sharun laedt ihn ueber $D/.preload (Qt 6 + Kernel 4.14, siehe pidfd-shim.c)
"$D/AppRun" "$@"
rc=$?
# Second call (--launch to a running Prism) ends immediately: then do not stop anything.
if [ -n "$OWN" ] && ! pgrep -x prismlauncher >/dev/null; then
    kill "$OWN" 2>/dev/null
fi
exit $rc
EOF
chmod 755 "$R/usr/local/bin/minecraft"

cat > "$R/usr/local/share/applications/minecraft.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Minecraft
Comment=Minecraft Java Edition (Prism Launcher)
Comment[de]=Minecraft Java Edition (Prism Launcher)
Exec=/usr/local/bin/minecraft
Icon=/usr/local/lib/prism/org.prismlauncher.PrismLauncher.png
Categories=Game;
EOF

S=$R/etc/skel
mkdir -p "$S/.local/share/PrismLauncher"
cat > "$S/.local/share/PrismLauncher/prismlauncher.cfg" <<'EOF'
[General]
ConfigVersion=1.3
ApplicationTheme=dark
IconTheme=pe_colored
AutomaticJavaDownload=false
AutomaticJavaSwitch=false
IgnoreJavaWizard=true
UserAskedAboutAutomaticJavaDownload=true
JavaPath=/usr/lib/jvm/java-25-openjdk/bin/java
UseNativeGLFW=true
CustomGLFWPath=/usr/lib64/libglfw.so.3
MaxMemAlloc=2048
MinMemAlloc=512
EOF

F=$S/.config/mozilla/firefox
mkdir -p "$F/duo/chrome"
cat > "$F/profiles.ini" <<'EOF'
[Profile0]
Name=duo
IsRelative=1
Path=duo
Default=1

[General]
StartWithLastProfile=1
Version=2
EOF
# 11457493C5A56847 = ID of the installation /usr/lib64/firefox (the same on every Duo): without this mapping
# Firefox created its own «default-release» profile and the adjustment would not apply.
cat > "$F/installs.ini" <<'EOF'
[11457493C5A56847]
Default=duo
Locked=1
EOF
echo 'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);' > "$F/duo/user.js"
cat > "$F/duo/chrome/userChrome.css" <<'EOF'
/* Duo: lift the Firefox window's minimum width so it fits on one panel */
:root { min-width: 200px !important; }

/* Duo: notification popups (e.g. «Add extension») never taller than the window — the content scrolls,
   the button row always stays visible. */
.popup-notification-body-container {
  max-height: 42vh !important;
  overflow-y: auto !important;
}
#addon-webext-perm-list,
#addon-webext-perm-list-required,
#addon-webext-perm-list-optional,
#addon-webext-perm-list-data-collection {
  max-height: 24vh !important;
  overflow-y: auto !important;
}
popupnotification .popup-notification-footer-container,
popupnotification .panel-footer {
  flex-shrink: 0 !important;
}
EOF
cat > "$S/.config/mimeapps.list" <<'EOF'
[Default Applications]
text/html=org.mozilla.firefox.desktop
x-scheme-handler/http=org.mozilla.firefox.desktop
x-scheme-handler/https=org.mozilla.firefox.desktop
x-scheme-handler/about=org.mozilla.firefox.desktop
x-scheme-handler/unknown=org.mozilla.firefox.desktop
EOF
chown -R root:root "$S/.local" "$S/.config/mozilla" "$S/.config/mimeapps.list"
echo "prism-firefox: Prism $(du -sh "$P" | cut -f1) in /usr/local/lib/prism, Starter, Eintrag, Vorlagen fuer neue Konten — FERTIG"
