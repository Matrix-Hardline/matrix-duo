#!/bin/bash
# Minimal Fedora 42 rootfs.img for the Surface Duo (M2: only USB network + SSH, no GUI). Native on the laptop, own code.
set -e -o pipefail
W=/home/user/duo-a1; R=$W/rootfs-duo-42
rm -rf "$R"; mkdir -p "$R"
echo "== $(date +%T) Pakete"
dnf -y -q --use-host-config --installroot="$R" --releasever=42 --setopt=install_weak_deps=False install \
  @core systemd-pam dbus-daemon dbus-broker NetworkManager openssh-server iproute iputils vim-minimal less util-linux passwd 2>&1 | tail -2
echo "== $(date +%T) Benutzer, SSH, USB-Netz"
chroot "$R" useradd -m -u 1000 -G wheel mobile
HM=$(openssl passwd -6 1234); HR=$(openssl passwd -6 surface)
sed -i "s|^mobile:[^:]*:|mobile:${HM}:|; s|^root:[^:]*:|root:${HR}:|" "$R/etc/shadow"
echo "duo" > "$R/etc/hostname"
mkdir -p "$R/etc/ssh/sshd_config.d"; printf 'PasswordAuthentication yes\nPermitRootLogin no\n' > "$R/etc/ssh/sshd_config.d/50-duo.conf"
# USB gadget network: Duo = 172.16.42.1, the laptop gets 172.16.42.2 via DHCP (as with the exploration boot file)
cat > "$R/usr/local/sbin/duo-usb-net" <<'G'
#!/bin/bash
# USB network via configfs (NCM); UDC of the Duo: a600000.dwc3
G=/sys/kernel/config/usb_gadget/duo
mountpoint -q /sys/kernel/config || mount -t configfs configfs /sys/kernel/config
mkdir -p $G && cd $G
echo 0x1d6b > idVendor; echo 0x0104 > idProduct
mkdir -p strings/0x409; echo "Surface-Duo-Fedora" > strings/0x409/product; echo "Matrix" > strings/0x409/manufacturer; echo duo1 > strings/0x409/serialnumber
mkdir -p functions/ncm.usb0 configs/c.1/strings/0x409; echo NCM > configs/c.1/strings/0x409/configuration
[ -e configs/c.1/ncm.usb0 ] || ln -s functions/ncm.usb0 configs/c.1/
for i in $(seq 60); do U=$(ls /sys/class/udc 2>/dev/null | head -1); [ -n "$U" ] && break; sleep 1; done
echo "$U" > UDC
for i in $(seq 30); do ip link show usb0 >/dev/null 2>&1 && break; sleep 1; done
ip addr add 172.16.42.1/24 dev usb0 2>/dev/null; ip link set usb0 up
G
chmod 755 "$R/usr/local/sbin/duo-usb-net"
cat > "$R/etc/systemd/system/duo-usb-net.service" <<'U'
[Unit]
Description=Surface Duo: USB-Netz (NCM-Gadget) 172.16.42.1
DefaultDependencies=no
After=sysinit.target
Before=network.target sshd.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/duo-usb-net
[Install]
WantedBy=sysinit.target
U
# DHCP for the laptop on usb0 via NetworkManager (shared)
mkdir -p "$R/etc/NetworkManager/system-connections"
printf '[connection]\nid=usb0-shared\ntype=ethernet\ninterface-name=usb0\nautoconnect=true\n[ipv4]\nmethod=shared\naddress1=172.16.42.1/24\n[ipv6]\nmethod=ignore\n' > "$R/etc/NetworkManager/system-connections/usb0.nmconnection"
chmod 600 "$R/etc/NetworkManager/system-connections/usb0.nmconnection"
chroot "$R" systemctl enable sshd NetworkManager duo-usb-net.service 2>&1 | tail -1
chroot "$R" systemctl set-default multi-user.target
# SELinux off in the guest (kernel 4.14 does not know Fedora's policy) – in addition to the cmdline
sed -i 's/^SELINUX=.*/SELINUX=disabled/' "$R/etc/selinux/config" 2>/dev/null || true
echo "BAU-ENDE $(date +%T)"
