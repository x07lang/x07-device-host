#!/usr/bin/env bash
set -euo pipefail

# Smoke is optional on CI runners without a GUI.
if [ "${X07_DEVICE_HOST_SMOKE:-1}" = "0" ]; then
  echo "smoke disabled (X07_DEVICE_HOST_SMOKE=0)"
  exit 0
fi

BIN="${X07_DEVICE_HOST_DESKTOP:-./target/debug/x07-device-host-desktop}"
if [ ! -x "$BIN" ]; then
  BIN="./target/release/x07-device-host-desktop"
fi

"$BIN" --help >/dev/null
echo "ok"
