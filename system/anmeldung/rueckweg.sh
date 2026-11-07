#!/bin/sh
# Back to gdm (over SSH, in case the login screen does not appear).
systemctl disable greetd.service
systemctl enable gdm.service
echo "gdm wieder aktiv — sudo reboot"
