#!/bin/bash
# begleiter-einrichten (Morpheus, 06.11.2026): set up the Duo side of «Morpheus on the laptop» — on a running
# Duo (root /) or in the build template of the factory image (root = rootfs). As root:
#   begleiter-einrichten.sh <root> <folder with matrix-trust, matrix-kopplung, matrix-begleiter, …>
set -euo pipefail
R=${1:?Wurzel}; Q=${2:?Quelle}
install -m755 "$Q/matrix-trust" "$Q/matrix-kopplung" "$Q/matrix-begleiter" "$Q/duo-in-den-bootloader" "$Q/morpheus-recovery" "$R/usr/local/bin/"
install -D -m644 "$Q/matrix-kopplung.service" "$R/etc/systemd/user/matrix-kopplung.service"
mkdir -p "$R/etc/systemd/user/default.target.wants"
ln -sf /etc/systemd/user/matrix-kopplung.service "$R/etc/systemd/user/default.target.wants/matrix-kopplung.service"
# sudoers: check first, then install — a broken file would lock sudo out entirely.
install -m440 "$Q/matrix-begleiter.sudoers" "$R/etc/sudoers.d/.matrix-begleiter.neu"
visudo -c -q -f "$R/etc/sudoers.d/.matrix-begleiter.neu"
mv "$R/etc/sudoers.d/.matrix-begleiter.neu" "$R/etc/sudoers.d/matrix-begleiter"
echo "begleiter: eingerichtet in $R"
