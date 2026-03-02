#!/usr/bin/env bash
set -euo pipefail

bash ./scripts/ci/check_phase8_assets.sh
cargo test -p x07-device-host-assets
cargo test -p x07-device-host-abi

