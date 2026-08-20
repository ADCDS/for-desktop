#!/bin/sh
# Install the Stoat push-to-talk helper. Run with sudo.
#
# The helper runs as root because reading /dev/input requires it. The
# alternative -- adding your account to the `input` group -- would let every
# program you run read every keystroke; this watches exactly one keycode.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo: sudo $0 [username]" >&2
  exit 1
fi

USER_NAME="${1:-${SUDO_USER:-}}"
if [ -z "$USER_NAME" ]; then
  echo "could not determine the desktop user; pass it: sudo $0 <username>" >&2
  exit 1
fi
UID_VALUE="$(id -u "$USER_NAME")"

SRC_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
install -d /usr/local/lib/stoat-ptt
install -m 0755 "$SRC_DIR/stoat-ptt-helper.py" /usr/local/lib/stoat-ptt/stoat-ptt-helper.py
sed "s|__UID__|$UID_VALUE|" "$SRC_DIR/stoat-ptt.service" > /etc/systemd/system/stoat-ptt.service

systemctl daemon-reload
systemctl enable --now stoat-ptt.service
systemctl --no-pager --lines=5 status stoat-ptt.service || true

echo
echo "Installed. Socket: /run/stoat-ptt.sock (owned by $USER_NAME)"
echo "Uninstall: sudo systemctl disable --now stoat-ptt.service && sudo rm -rf /etc/systemd/system/stoat-ptt.service /usr/local/lib/stoat-ptt"
