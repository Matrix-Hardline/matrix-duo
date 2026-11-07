#!/bin/sh
# Set up Matrix login on the Duo (after `sudo dnf install greetd`).
# Way back: rueckweg.sh (gdm on again). Takes effect only on the next boot.
set -e
D=$(dirname "$0")
# The greeter's account: Fedora creates «greetd», older packages «greeter».
U=greetd; getent passwd greetd >/dev/null || U=greeter
sed "s/^user = .*/user = \"$U\"/" "$D/config.toml" > /etc/greetd/config.toml
chmod 644 /etc/greetd/config.toml
install -m644 "$D/matrix-anmeldung.kdl" /etc/greetd/matrix-anmeldung.kdl
install -m755 "$D/matrix-anmeldung-sitzung" /usr/local/bin/matrix-anmeldung-sitzung
install -d /etc/systemd/system/greetd.service.d
install -m644 "$D/duo.conf" /etc/systemd/system/greetd.service.d/duo.conf
restorecon -R /etc/greetd /usr/local/bin/matrix-anmeldung-sitzung 2>/dev/null || true
systemctl daemon-reload
systemctl disable gdm.service
systemctl enable greetd.service
echo "Matrix Anmeldung eingerichtet — gilt ab dem nächsten Start."
