#!/usr/bin/env bash
set -euo pipefail

./scripts/ci/check_phase8.sh

cargo build -p x07-device-host-desktop

./scripts/ci/check_phase9_smoke.sh

