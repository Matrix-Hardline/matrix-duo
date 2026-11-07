#!/bin/sh
# Matrix canvas session: start the service chain. With a direct niri
# start (not via niri.service) graphical-session.target does not become
# active automatically. The Matrix shell (bar/dock/notifications/wallpaper/
# watchdog) starts via local.kdl — here only the systemd side remains.
# (DMS has been replaced since the big cut and is NOT started anymore.)
# R94c: graphical-session.target is RefuseManualStart — the direct start
# wurde still abgewiesen (matrix-pad blieb tot). matrix-session.target
# is the legal puller (Wants=graphical-session.target).
systemctl --user start --no-block matrix-session.target 2>/dev/null
systemctl --user start matrix-sound-hooks.service 2>/dev/null || \
    systemctl --user start matrix-klang-hooks.service 2>/dev/null
systemctl --user start iio-niri.service 2>/dev/null
