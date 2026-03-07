#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /path/to/x07-web-ui" >&2
  exit 2
fi

SRC_ROOT="$(cd "$1" && pwd)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_HOST_DIR="${SRC_ROOT}/host"
VENDOR_SNAPSHOT_PATH="${ROOT_DIR}/vendor/x07-web-ui/host/host.snapshot.json"
ASSETS_DIR="${ROOT_DIR}/crates/x07-device-host-assets/assets"
IOS_HOST_DIR="${ROOT_DIR}/mobile/ios/template/X07DeviceApp/x07"
ANDROID_HOST_DIR="${ROOT_DIR}/mobile/android/template/app/src/main/assets/x07"
SNAPSHOT_PATH="${ROOT_DIR}/arch/host_abi/host_abi.snapshot.json"

PYTHON=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON="python"
else
  echo "python not found on PATH" >&2
  exit 1
fi

cp "${SRC_HOST_DIR}/host.snapshot.json" "${VENDOR_SNAPSHOT_PATH}"

for host_file in index.html bootstrap.js main.mjs app-host.mjs; do
  cp "${SRC_HOST_DIR}/${host_file}" "${ASSETS_DIR}/${host_file}"
  cp "${SRC_HOST_DIR}/${host_file}" "${IOS_HOST_DIR}/${host_file}"
  cp "${SRC_HOST_DIR}/${host_file}" "${ANDROID_HOST_DIR}/${host_file}"
done

"${PYTHON}" - "${ASSETS_DIR}" "${SNAPSHOT_PATH}" <<'PY'
import hashlib
import json
import pathlib
import sys

assets_dir = pathlib.Path(sys.argv[1])
snapshot_path = pathlib.Path(sys.argv[2])
paths = ["index.html", "bootstrap.js", "main.mjs", "app-host.mjs"]

assets = []
for rel in paths:
    path = assets_dir / rel
    data = path.read_bytes()
    assets.append(
        {
            "path": rel,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes_len": len(data),
        }
    )

abi = {
    "abi_name": "webview_host_v1",
    "abi_version": "0.1.0",
    "assets": [{"path": a["path"], "sha256": a["sha256"]} for a in assets],
    "bridge_protocol_version": "web_ui_bridge_v1",
}
doc = {
    "schema_version": "x07.device.host_abi.snapshot@0.1.0",
    "kind": "device_host_abi_snapshot",
    "host_abi_hash": hashlib.sha256(
        json.dumps(abi, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).hexdigest(),
    "abi": abi,
}
snapshot_path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

bash "${ROOT_DIR}/scripts/ci/check_phase8_assets.sh"

echo "ok: synced x07-web-ui host assets"
