#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

python3 - "$ROOT_DIR" <<'PY'
import hashlib, json, pathlib, sys

ROOT = pathlib.Path(sys.argv[1])
ASSETS = ROOT / "crates" / "x07-device-host-assets" / "assets"
paths = ["index.html", "bootstrap.js"]

def sha256_file(p: pathlib.Path) -> str:
  h = hashlib.sha256()
  h.update(p.read_bytes())
  return h.hexdigest()

files = []
for rel in paths:
  p = ASSETS / rel
  if not p.exists():
    print(f"missing asset: {p}", file=sys.stderr)
    sys.exit(2)
  files.append({"path": rel, "sha256": sha256_file(p)})

abi = {
  "abi_name": "webview_host_v1",
  "abi_version": "0.1.0",
  "assets": files,
  "bridge_protocol_version": "web_ui_bridge_v1",
}

abi_bytes = json.dumps(abi, separators=(",", ":"), sort_keys=True).encode("utf-8")
abi_hash = hashlib.sha256(abi_bytes).hexdigest()

print(json.dumps({"abi": abi, "host_abi_hash": abi_hash}, indent=2, sort_keys=True))
PY
