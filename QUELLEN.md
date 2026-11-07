# Sources · Quellen

What the factory image (and therefore `Morpheus.AppImage`) contains and where it comes from.
*Was im Werksabbild (und damit in `Morpheus.AppImage`) steckt und woher es kommt.*

| Part | Origin | Licence |
|---|---|---|
| Fedora 42 (aarch64), packages | https://fedoraproject.org — sources: https://src.fedoraproject.org | per package |
| Kernel 4.14 (msm-4.14) | Microsoft, `surface-duo-oss` — https://github.com/microsoft/surface-duo-oss-kernel.msm-4.14 ; changes: `patches/kernel-*.patch`, configuration: `boot/` | GPL-2.0 |
| niri (window manager «niri-canvas») | https://github.com/YaLTeR/niri (revision a30ca7983b2f) + Smithay (ff5fa7df392c) ; changes: `canvas/` in the repository `matrix` | GPL-3.0 |
| Mesa (Turnip on KGSL) | https://gitlab.freedesktop.org/mesa/mesa (25.1) ; changes: `patches/mesa-*.patch` | MIT |
| Mutter | https://gitlab.gnome.org/GNOME/mutter (48) ; changes: `patches/mutter-*.patch` | GPL-2.0-or-later |
| hexagonrpc, libssc, pd-mapper, tqftpserv | Linux community (postmarketOS and others) ; changes: `patches/` | per project |
| Prism Launcher (Minecraft) | https://github.com/PrismLauncher/PrismLauncher (11.1.1, AppImage) | GPL-3.0 |
| Matrix apps, Morpheus, MatrixKit | repository `matrix` | GPL-3.0-or-later / MIT |
| Wallpapers (`/usr/share/backgrounds/matrix`, 24 pictures, scaled to 3000 px) | Unsplash, Pexels, Pixabay — photographer and picture id in the file name, overview in `QUELLEN.txt` beside them | Unsplash, Pexels and Pixabay licences; rights stay with the authors |
| Colour chain (matugen templates in `/etc/skel/.config/matugen`) | `morpheus/skel` in this repository | GPL-3.0-or-later |
| Laptop tools in Morpheus (fastboot, adb, ncat, telnet) | Fedora 42 packages `android-tools`, `nmap-ncat`, `telnet` (x86_64 and aarch64) | Apache-2.0 / ncat licence / BSD |
| Firmware of the Duo | **not included** — read from the partitions of each device during installation | — |

The exact package set of a factory image: `rpm -qa` in the installed system.

**Deutsch:** Die Tabelle nennt jeden Bestandteil mit Herkunft und Lizenz. Die Firmware des Duo ist in keiner Datei
enthalten; jedes Gerät liest sie beim Installieren aus sich selbst. Den genauen Paketstand zeigt `rpm -qa`.
