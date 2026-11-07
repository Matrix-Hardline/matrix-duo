# Matrix for the Surface Duo

**English** · [Deutsch](#deutsch)

> [!WARNING]
> **For experienced users only. You use this at your own risk.** Installing Matrix unlocks and repartitions your
> Surface Duo, resets Android and boots an unofficial system. Although Morpheus never writes the bootloader, firmware
> or calibration data, a failed step, a power loss or an unknown device variant **can leave the Duo unusable
> («bricked»)** — and there is no official way to repair it. Make a full backup first. This software comes **without
> any warranty** (GPL-3.0, sections 15–16); the authors accept no liability for damaged devices or lost data.

Everything needed to put **Matrix** on a first-generation Microsoft Surface Duo — beside Android, which stays. Users
only need **Morpheus**: one file for the laptop that brings everything and works without internet.

**Download:** [Releases](https://github.com/Matrix-Hardline/matrix-duo/releases) → `Morpheus.AppImage` (≈ 1.3 GB).
One file for Linux laptops with Intel/AMD (x86_64) **and** ARM (aarch64), glibc ≥ 2.39 (Ubuntu 24.04, Fedora 41,
Debian 13 or newer).

## Installing Matrix (with Morpheus)

1. **Unlock the Duo's bootloader** — once; this wipes Android completely. Morpheus never does it on its own; it shows
   the steps (developer options › OEM unlocking, then `fastboot flashing unlock`).
2. Start Morpheus: `sh Morpheus.AppImage`. The first start unpacks it once (≈ 1.2 GB in `~/.cache/morpheus`). Choose
   language and keyboard.
3. Connect the Duo with a USB cable (Android with USB debugging, or bootloader). If Morpheus shows «No access», press
   «Allow access» (Linux asks for your password once) and replug the cable.
4. **«Install Matrix».** The Duo boots a live system (memory only); there the installer guides you: a full backup of
   all partitions to the laptop (recommended), the split of the storage (suggested: Android 32 GB), confirmation —
   Android is reset in the process.
5. Then Morpheus starts Matrix from its partition. On the first start: language, name, password.

What else Morpheus does: start Matrix (from Android), **Matrix Recovery** (back up, restore, reinstall Matrix only),
files and photos between laptop and Duo (after «Trust this laptop?» on the Duo).

**Safety:** Morpheus writes only on the Duo and only after confirmation there: the partition table, Android data (on
the first installation) and the Matrix partition. Bootloader, firmware, modem and calibration data are never touched;
Morpheus uses `fastboot boot` (memory only), never `fastboot flash`. Every Duo reads its firmware from itself during the
installation — no file here contains any.

**Status:** alpha. Installed for real on one Duo — from an ARM laptop (Fedora) and from a foreign Intel PC (Bazzite); not yet tried on a second Duo. Do not use without a full backup.

## Hardware status

Measured on one Surface Duo (1st generation, Android 2022.902.48, Microsoft kernel 4.14). «Untested» means: never checked
on the device — it may work or not.

**Works**

| Area | Status |
|---|---|
| Both displays | 1350×1800 each, 60 Hz, GPU-accelerated (Vulkan via Mesa Turnip on KGSL) |
| Touch | multitouch on both panels (own driver from the controller's heatmap, ~100 Hz) |
| Posture sensors | accelerometer, hinge angle, Hall sensors (confirmed, via the sensor DSP): rotation, closed = lock and screens off, folded back = one panel, «laptop» posture |
| Wi-Fi | yes (firmware read from the device during installation) |
| Bluetooth | yes — keyboard, mouse, headphones (A2DP) |
| Sound | speakers and microphone (confirmed); sound over USB-C to a TV |
| Camera | the Duo's only camera (Sony IMX351) runs over our own raw-image pipeline: live image at 30 fps with auto exposure |
| Deep sleep | suspend reaches the SoC's deepest state (CXSD); wake with the power key |
| Battery, charging | level and charging shown, charging works |
| Buttons, vibration | power and volume keys, haptic feedback |
| External screen | USB-C (DisplayPort): 1080p at 60 Hz or 4K at 30 Hz, with sound |
| Video | hardware H.264 encoder works (own client); hardware decoding is experimental in Tube |

**Does not work yet**

| Area | Status |
|---|---|
| Mobile network | no calls, SMS or mobile data — the modem runs only for Wi-Fi |
| Starting without a laptop | Android stays the default system: every start of Matrix is a RAM boot from Morpheus over the cable |
| Bluetooth calls | headset profile (HFP) missing; music works |
| Camera | runs, but not finished: image tuning (colour, sharpness), flash, autofocus control and video recording are still missing |
| Fingerprint sensor | not supported |
| Surface Pen | untested (no pen at hand) |
| GPS | not set up |
| Battery life | standby uses more power than under Android; suspend works, idle is not yet tuned |

## Contents

| Folder | Contents |
|---|---|
| `morpheus/` | laptop scripts (live start, delivery, recovery, tool bundle, one-file build for ARM + Intel), factory image build and filter |
| `morpheus/installer` | installer and recovery helpers in the live system |
| `morpheus/erststart` | first setup (creates one account, only while none exists) |
| `morpheus/begleiter` | pairing with the laptop, companion (files, photos, backup), sudo rule |
| `morpheus/skel` | what the factory image adds per account (colour chain templates, wallpaper sources) |
| `boot/` | kernel build, initramfs, start image (stage 1), squashfs root |
| `system/` | building the Fedora 42 system and its parts (Mesa, Mutter, niri, NetworkManager, sensors …) |
| `geraet/` | services and helpers of the Duo (posture, sleep, touch, sound, keys, haptics, Bluetooth) |
| `patches/` | changes to the kernel, Mesa, Mutter, audio and sensor services |

The apps (and the source of Morpheus) are in the repository
[`matrix`](https://github.com/Matrix-Hardline/matrix). Where everything else comes from: `QUELLEN.md` (sources).

## Licence

**GPL-3.0-or-later** (`LICENSE`) for everything written here. Patches follow the licence of their project (kernel:
GPL-2.0, Mesa: MIT, Mutter: GPL-2.0-or-later …).

---

## Deutsch

> [!WARNING]
> **Nur für erfahrene Nutzerinnen und Nutzer. Die Verwendung erfolgt auf eigene Verantwortung.** Die Installation
> entsperrt und partitioniert das Surface Duo neu, setzt Android zurück und startet ein inoffizielles System. Auch wenn
> Morpheus Bootloader, Firmware und Kalibrierungsdaten nie beschreibt, kann ein fehlgeschlagener Schritt, ein
> Stromausfall oder eine unbekannte Geräteausführung **das Duo unbrauchbar machen («bricken»)** — und dafür gibt es
> keinen offiziellen Reparaturweg. Vorher eine Vollsicherung machen. Die Software kommt **ohne jede Gewährleistung**
> (GPL-3.0, Abschnitte 15–16); die Urheber haften nicht für beschädigte Geräte oder verlorene Daten.

Alles, was es braucht, um **Matrix** auf ein Microsoft Surface Duo (erste Generation) zu bringen — neben Android, das
erhalten bleibt. Für Anwenderinnen und Anwender genügt **Morpheus**: eine einzige Datei für den Laptop, die alles
mitbringt und ohne Internet arbeitet.

**Herunterladen:** [Releases](https://github.com/Matrix-Hardline/matrix-duo/releases) → `Morpheus.AppImage`. Eine Datei
für Linux-Laptops mit Intel/AMD **und** ARM (glibc ≥ 2.39: Ubuntu 24.04, Fedora 41, Debian 13 oder neuer).

1. **Bootloader des Duo entsperren** — einmalig, löscht Android vollständig. Morpheus tut das nie selbst.
2. Morpheus starten: `sh Morpheus.AppImage` (der erste Start packt sich einmal aus, ≈ 1,2 GB). Sprache und Tastatur
   wählen.
3. Duo per USB anschliessen. Zeigt Morpheus «Kein Zugriff»: «Zugriff erlauben» (einmal Passwort), Kabel neu einstecken.
4. **«Matrix installieren»**: Vollsicherung (empfohlen), Aufteilung (Vorschlag: Android 32 GB), Bestätigung — Android
   wird dabei zurückgesetzt.
5. Danach startet Morpheus Matrix von seiner Partition; beim ersten Start Sprache, Name, Passwort.

**Sicherheit:** Bootloader, Firmware, Modem- und Kalibrierungsdaten werden nie angefasst; nur `fastboot boot`, nie
`fastboot flash`. **Stand:** Alpha, an einem Duo echt installiert — vom ARM-Laptop und von einem fremden Intel-PC (Bazzite). Ohne Vollsicherung bitte nicht.

**Hardware-Stand** (ein Duo, Android 2022.902.48, Kernel 4.14):

- **Geht:** beide Bildschirme (60 Hz, GPU), Multitouch, Lage- und Scharniersensoren (Drehen, Zuklappen = Sperre,
  Zurückklappen = ein Bildschirm), WLAN, Bluetooth (Tastatur, Maus, Kopfhörer), Lautsprecher und Mikrofon, Kamera
  (die einzige des Duo, IMX351, läuft mit 30 fps), Tiefschlaf (CXSD), Akku und Laden, Tasten und Vibration, Bildschirm über USB-C mit Ton,
  Hardware-Kodierung H.264 (Dekodierung experimentell).
- **Geht noch nicht:** Mobilfunk (keine Anrufe, SMS, mobilen Daten), Start ohne Laptop (Android bleibt Standard, Matrix
  startet per Kabel aus Morpheus), Bluetooth-Telefonie (HFP), Kamera noch nicht fertig eingerichtet (Bildabstimmung,
  Blitz, Autofokus, Videoaufnahme),
  Fingerabdruck, GPS; Surface Pen nicht geprüft (kein Stift zur Hand); Standby braucht mehr Strom als Android.

**Lizenz:** GPL-3.0-or-later; Patches folgen ihrem Projekt.
