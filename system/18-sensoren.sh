#!/bin/bash
# Surface Duo 1: run the libssc tool (ssccli) on the Duo – help, sensor search, short measurement – output to ~/duo-a1/out/ssc.txt
# Usage on the laptop: ~/duo-a1/18-sensoren.sh [ssccli arguments]   (without arguments: --help, then the sensor list)
S="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=20 mobile@172.16.42.1"
O=/home/user/duo-a1/out/ssc.txt
if [ $# -gt 0 ]; then
  $S "sudo timeout 60 ssccli $*" 2>&1 | tee "$O"
else
  $S "sudo bash -c 'echo == ssccli --help; timeout 20 ssccli --help 2>&1; echo; echo == Sensorliste; timeout 60 ssccli --list 2>&1 || timeout 60 ssccli -l 2>&1 || timeout 60 ssccli list 2>&1'" 2>&1 | tee "$O"
fi
echo "(gespeichert in $O)"
