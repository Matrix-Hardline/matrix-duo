# morpheus-netz (06.11.2026, test on a foreign PC): the USB network to the Duo — sourced by the laptop scripts.
# The Duo (stage 1, live system, Matrix) is 172.16.42.1 on its USB gadget (1d6b:0104, RNDIS); the laptop must be
# 172.16.42.2 on that interface BEFORE anything can reach the Duo. On a fresh PC no such address exists: the scripts
# used to wait for the Duo first and set the address afterwards, so they waited forever.
#
#   duo_netz_name      -> the interface of the Duo's USB gadget (empty if none)
#   netz_hoch [name]   -> make sure it carries 172.16.42.2/24 (0 = ok); prints why when it cannot
#
# Order: already there -> NetworkManager connection owned by THIS user (allowed without a password for the logged-in
# user, autoconnect so a replug keeps working) -> pkexec (asks for the password).

duo_netz_name() {
  local d
  for d in /sys/class/net/*; do
    [ "$(cat "$d/device/../idProduct" 2>/dev/null)" = "0104" ] && [ "$(cat "$d/device/../idVendor" 2>/dev/null)" = "1d6b" ] \
      && { basename "$d"; return 0; }
  done
  return 1
}

netz_hoch() {
  local n=${1:-$(duo_netz_name)} err
  [ -n "$n" ] || return 1
  ip -br addr show "$n" 2>/dev/null | grep -q " 172\.16\.42\.2/" && return 0
  if command -v nmcli >/dev/null 2>&1 && nmcli -t general status >/dev/null 2>&1; then
    nmcli connection delete morpheus-duo >/dev/null 2>&1
    if err=$(nmcli connection add type ethernet con-name morpheus-duo ifname "$n" \
          ipv4.method manual ipv4.addresses 172.16.42.2/24 ipv4.never-default yes ipv6.method disabled \
          connection.autoconnect yes connection.permissions "user:$(id -un)" 2>&1) \
       && err=$(nmcli -w 15 connection up morpheus-duo 2>&1); then
      sleep 1
      ip -br addr show "$n" 2>/dev/null | grep -q " 172\.16\.42\.2/" && return 0
    fi
    echo "morpheus: NetworkManager richtet das USB-Netz nicht ein: $(echo "$err" | tail -1)" >&2
  fi
  if command -v pkexec >/dev/null 2>&1; then
    echo "morpheus: Linux fragt jetzt nach deinem Passwort (USB-Netz zum Duo)" >&2
    pkexec sh -c "ip addr replace 172.16.42.2/24 dev '$n' && ip link set '$n' up" && return 0
  fi
  echo "morpheus: USB-Netz zum Duo fehlt — von Hand: sudo ip addr add 172.16.42.2/24 dev $n" >&2
  return 1
}

# Once per wait-loop turn: as soon as the Duo's gadget is there, give it the address (quietly; errors once).
netz_wach() {
  local n
  n=$(duo_netz_name) || return 0
  ip -br addr show "$n" 2>/dev/null | grep -q " 172\.16\.42\.2/" && return 0
  [ -n "${NETZ_VERSUCHT:-}" ] && return 0
  NETZ_VERSUCHT=1
  netz_hoch "$n" || true
}
