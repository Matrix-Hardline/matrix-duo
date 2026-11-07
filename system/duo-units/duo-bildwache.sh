#!/bin/bash
# NOT IN USE (03.11.2026): the underflow count is not a sign of noise (reboot loop during the test).
# The noise is fixed by niri patch 0015 «first light»; detection would be register dsi0_ctrl_reg 0xB4.
# duo-bildwache (03.11.2026): heal noise on the login screen.
# When the display is first switched on, the Duo driver (msm-sde, 4.14) randomly reports «dsi FIFO UNDERFLOW»; then
# both panels show noise until niri restarts (A/B test 03.11.: old and new niri each affected in 1 of 3 starts;
# power-off/on of the monitors does NOT heal it, a greetd restart does). This watcher follows the kernel messages:
# underflow within the first 20 s after the login niri starts AND nobody logged in -> restart greetd (max. 3 in 5 min).
# A running session is never touched.
LOG() { logger -t duo-bildwache "$*"; }
declare -a tries=()
dmesg -W --level=err,warn 2>/dev/null | while read -r line; do
    case "$line" in *"FIFO UNDERFLOW"*) ;; *) continue ;; esac
    sleep 1   # the messages come in bursts
    pid=$(pgrep -f "niri-canvas --session -c /etc/greetd/matrix-anmeldung.kdl" | head -1)
    [ -n "$pid" ] || continue
    pgrep -u 1000 -x niri-canvas >/dev/null && continue          # the person (uid 1000, any name) is logged in: never intervene
    read -r up _ < /proc/uptime; up=${up%.*}
    read -r st < /proc/$pid/stat 2>/dev/null || continue
    rest=${st##*) }; set -- $rest; age=$(( up - ${20} / 100 ))
    [ "$age" -le 20 ] || continue
    now=$up; keep=(); for t in "${tries[@]}"; do [ $(( now - t )) -lt 300 ] && keep+=("$t"); done; tries=("${keep[@]}")
    if [ "${#tries[@]}" -ge 3 ]; then LOG "Unterlauf am Anmeldebildschirm — schon 3 Neustarts in 5 min, ich warte"; continue; fi
    tries+=("$now")
    LOG "Unterlauf ${age} s nach Start der Anmeldung — Anmeldebildschirm neu (Versuch ${#tries[@]})"
    systemctl restart greetd
    sleep 5
done
