#!/bin/bash
# Refine the Fedora 42 rootfs for the Duo (as root on the laptop): packages, patched Phosh, duotouch, udev rule, logind, start scripts.
set -e
W=/home/user/duo-a1; R=$W/rootfs-duo-42
echo "== $(date +%T) Pakete ins rootfs (Phosh-Stapel, Werkzeuge)"
dnf -y -q --use-host-config --installroot="$R" --releasever=42 --setopt=install_weak_deps=False install \
  phoc seatd cage foot libinput-utils evtest drm_info device-mapper mesa-dri-drivers gnome-control-center gnome-console phosh-mobile-settings stevia 2>&1 | tail -1
echo "== $(date +%T) gepatchtes Phosh (0.48.0-2.duo) einspielen"
dnf -y -q --installroot="$R" --releasever=42 install "$W/out/phosh-rpm/phosh-0.48.0-2.duo.fc42.aarch64.rpm" "$W/out/phosh-rpm/libphosh-0.48.0-2.duo.fc42.aarch64.rpm" 2>&1 | tail -1
chroot "$R" rpm -q phosh phoc seatd | tr '\n' ' '; echo
echo "== $(date +%T) Duo-Anpassungen"
install -m755 "$W/out/duotouch" "$R/usr/local/bin/duotouch"
install -m755 "$W/out/kms-test" "$R/usr/local/bin/kms-test"
cat > "$R/etc/udev/rules.d/99-duo-touch.rules" <<'U'
SUBSYSTEM=="input", ATTRS{name}=="Surface Duo Touch A", ENV{WL_OUTPUT}="DSI-1", ENV{ID_INPUT_TOUCHSCREEN}="1"
SUBSYSTEM=="input", ATTRS{name}=="Surface Duo Touch B", ENV{WL_OUTPUT}="DSI-2", ENV{ID_INPUT_TOUCHSCREEN}="1"
U
cat > "$R/etc/systemd/system/duotouch.service" <<'U'
[Unit]
Description=Surface Duo touch (hidraw -> uinput, one touchscreen per panel)
After=systemd-udevd.service
[Service]
ExecStart=/usr/local/bin/duotouch /dev/hidraw0 xy xy
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
U
mkdir -p "$R/etc/systemd/logind.conf.d"
printf '[Login]\nHandlePowerKey=ignore\nHandleSuspendKey=ignore\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\n' > "$R/etc/systemd/logind.conf.d/duo.conf"
# Panels + writeback: Virtual-1 off, DSI-1 on, DSI-2 via hotplug (the Phosh patch also allows a double start; hotplug stays as the safe path)
cat > "$R/usr/local/bin/duo-panels" <<'P'
#!/bin/bash
# duo-panels [eins|beide]
echo off > /sys/class/drm/card0-Virtual-1/status
echo on > /sys/class/drm/card0-DSI-1/status
if [ "$1" = "beide" ]; then echo on > /sys/class/drm/card0-DSI-2/status; udevadm trigger --action=change /sys/class/drm/card0; else echo off > /sys/class/drm/card0-DSI-2/status; fi
P
chmod 755 "$R/usr/local/bin/duo-panels"
cp /usr/share/phosh/phoc.ini "$R/etc/phoc-duo.ini" 2>/dev/null || cp "$R/usr/share/phosh/phoc.ini" "$R/etc/phoc-duo.ini"
printf '\n[output:Virtual-1]\nenable = false\n\n[output:DSI-1]\nscale = 2\nx = 0\ny = 0\n\n[output:DSI-2]\nscale = 2\nx = 675\ny = 0\n' >> "$R/etc/phoc-duo.ini"
cat > "$R/usr/local/bin/phosh-duo" <<'P'
#!/bin/bash
# Start Phosh on the Surface Duo (as mobile): phosh-duo [eins|beide]
sudo duo-panels "${1:-beide}"
export XDG_RUNTIME_DIR=/run/user/1000 HOME=/home/mobile XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=Phosh:GNOME
export LIBSEAT_BACKEND=seatd WLR_BACKENDS=drm,libinput WLR_RENDERER=${WLR_RENDERER:-vulkan} MESA_LOADER_DRIVER_OVERRIDE=zink WLR_LIBINPUT_NO_DEVICES=1 WLR_DRM_NO_MODIFIERS=1 WLR_NO_HARDWARE_CURSORS=1
export GSK_RENDERER=${GSK_RENDERER:-vulkan}
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
[ -S $XDG_RUNTIME_DIR/bus ] || (dbus-daemon --session --address=$DBUS_SESSION_BUS_ADDRESS --nofork --nopidfile >/tmp/dbus-session.log 2>&1 &)
sleep 1
exec phoc -S -C /etc/phoc-duo.ini -E /usr/local/bin/phosh-mit-tastatur >/tmp/phosh.log 2>&1
P
chmod 755 "$R/usr/local/bin/phosh-duo"
cat > "$R/usr/local/bin/phosh-mit-tastatur" <<'P'
#!/bin/bash
# started by phoc -E: on-screen keyboard (stevia) + Phosh
(sleep 3; exec /usr/bin/phosh-osk-stevia) >/tmp/stevia.log 2>&1 &
exec /usr/libexec/phosh
P
chmod 755 "$R/usr/local/bin/phosh-mit-tastatur"
printf 'mobile ALL=(root) NOPASSWD: /usr/local/bin/duo-panels\n' > "$R/etc/sudoers.d/duo-panels"; chmod 440 "$R/etc/sudoers.d/duo-panels"
chroot "$R" sh -c 'getent group seat >/dev/null || groupadd -r seat; usermod -aG seat,video,input,render mobile; systemctl enable seatd duotouch >/dev/null 2>&1; loginctl enable-linger mobile 2>/dev/null || true; echo Europe/Zurich > /etc/timezone; ln -sf /usr/share/zoneinfo/Europe/Zurich /etc/localtime'
echo "== $(date +%T) fertig"; du -sh "$R" | cut -f1
# Power button service (switch the panel via wlr-randr; Phosh follows the panel state)
install -m755 "$W/out/duo-powerkey" "$R/usr/local/bin/duo-powerkey"
install -m644 "$W/duo-powerkey.service" "$R/etc/systemd/system/duo-powerkey.service"
chroot "$R" systemctl enable duo-powerkey >/dev/null 2>&1
dnf -y -q --use-host-config --installroot="$R" --releasever=42 --setopt=install_weak_deps=False install wlr-randr wlopm vulkan-tools 2>&1 | tail -1
# Mesa with Turnip KGSL (own build, Cloud-Ordner artefakte/mesa-kgsl or out/mesa-rpm)
[ -d "$W/out/mesa-rpm" ] && dnf -y -q --installroot="$R" --releasever=42 install --allowerasing "$W"/out/mesa-rpm/*.rpm 2>&1 | tail -1
printf 'KERNEL=="kgsl-3d0", MODE="0666"\nKERNEL=="ion", MODE="0666"\n' > "$R/etc/udev/rules.d/98-duo-gpu.rules"
