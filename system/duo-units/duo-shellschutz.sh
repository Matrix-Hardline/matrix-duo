#!/bin/bash
# duo-shellschutz: let the kernel OOM killer sacrifice the interface (compositor, bar, dock, login, sound) last.
# The user session inherits oom_score_adj 100 from the user service; only root may lower it. Re-apply every 15 s.
# 31.10.2026 for GNOME; 03.11.2026 (round 47) for the canvas: niri-canvas, bar, dock, keyboard, greetd instead of
# gnome-shell — and ONE pass over /proc instead of nine pgrep per round. Watch the compositor's GPU memory:
# every change of >= 64 MB goes into the journal (journalctl -t duo-gpumem). Old version: duo-shellschutz.sh.gnome
declare -A gpu_last
SCHUTZ=" niri niri-canvas matrix-bar matrix-dock matrix-keyboard matrix-notifica matrix-greeter greetd gnome-shell gnome-session-b gdm pipewire wireplumber "
GPU=" niri niri-canvas gnome-shell "
while :; do
    for d in /proc/[0-9]*; do
        read -r name 2>/dev/null < "$d/comm" || continue
        case "$SCHUTZ" in *" $name "*) ;; *) continue ;; esac
        p=${d#/proc/}
        read -r adj 2>/dev/null < "$d/oom_score_adj"
        [ "$adj" = -900 ] || echo -900 2>/dev/null > "$d/oom_score_adj"
        case "$GPU" in *" $name "*) ;; *) continue ;; esac
        f=/sys/class/kgsl/kgsl/proc/$p/kernel
        [ -r "$f" ] || continue
        read -r kb < "$f"; mb=$(( kb / 1048576 )); last=${gpu_last[$p]:-0}
        if [ $(( mb - last )) -ge 64 ] || [ $(( last - mb )) -ge 64 ]; then
            logger -t duo-gpumem "$name $p: ${mb} MB (vorher ${last} MB), RSS $(awk '/VmRSS/{print int($2/1024)}' "$d/status") MB, frei $(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo) MB"
            gpu_last[$p]=$mb
        fi
    done
    # Round 48 (03.11.2026): hanging intermediate children of the compositor. niri forks every program twice; the
    # intermediate child (comm «Command Spawner», never exec) waits for a signal from niri and otherwise ends immediately. If the
    # signal never came, it hung for 6 h and, as a copy of niri, held all window buffers mapped at the time: 700 MB of shared memory.
    # Older than 30 s = hanging; the grandchild program has long been running on its own -> ending it has no consequences.
    read -r up _ < /proc/uptime; up=${up%.*}
    for d in /proc/[0-9]*; do
        read -r name 2>/dev/null < "$d/comm" || continue
        [ "$name" = "Command Spawner" ] || continue
        read -r st 2>/dev/null < "$d/stat" || continue
        rest=${st##*) }; set -- $rest
        ppid=$2; start=${20}
        read -r pname 2>/dev/null < "/proc/$ppid/comm" || continue
        case "$pname" in niri|niri-canvas) ;; *) continue ;; esac
        age=$(( up - start / 100 ))
        if [ "$age" -gt 30 ]; then
            kill -9 "${d#/proc/}" 2>/dev/null && logger -t duo-shellschutz "haengendes niri-Zwischenkind ${d#/proc/} nach ${age} s beendet"
        fi
    done
    sleep 15
done
