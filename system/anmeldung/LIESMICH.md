# Matrix login on the Duo (02.11.2026, round 33)

The login screen at boot is `matrix-greeter` in the window house (without iced; `--iced` = old version).
Top (DSI-1): clock, date, person, password field, log in, restart/power off (tap twice).
Bottom (DSI-2): Swiss on-screen keyboard (kit family `fam::lay_keyboard`).
Probe in a running session: `matrix-greeter --probe` (login only simulated; power off twice = exit).

## Setup
1. `sudo dnf install greetd` (owner — download)
2. `sudo sh ~/anmeldung/einrichten.sh` — writes /etc/greetd/{config.toml,matrix-anmeldung.kdl},
   /usr/local/bin/matrix-anmeldung-sitzung, greetd.service.d/duo.conf; gdm off, greetd on.
3. `sudo reboot`

## Way back (over SSH from the Surface)
`sudo sh ~/anmeldung/rueckweg.sh && sudo reboot` — gdm back on. Greeter log: /tmp/matrix-anmeldung.log,
greetd: `journalctl -b -u greetd`.

## Orientation as one truth (02.11.2026)
duo-haltung stores every applied rotation (/var/lib/duo/ausrichtung + niri-ausgaenge.kdl, checked with
`niri-canvas validate`) and publishes it to /run/duo/niri-ausgaenge.kdl when the service starts. The login
(matrix-anmeldung.kdl) and the session (~/.config/niri/device.kdl) include the file BEFORE their fixed output blocks
(with duplicate blocks, niri uses the FIRST one). After a stage change 2 s instead of 12 s. The login niri runs with
--session (otherwise there is no DisplayConfig on the bus → «The name is not activatable»). greetd starts after duo-haltung.
Backups: /usr/local/sbin/duo-haltung.py.vor-ausrichtung, ~/.config/niri/device.kdl.vor-ausrichtung.
