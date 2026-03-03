#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

python3 - "$ROOT_DIR" <<'PY'
import hashlib, json, pathlib, sys

ROOT = pathlib.Path(sys.argv[1])
ASSETS = ROOT / "crates" / "x07-device-host-assets" / "assets"
SNAPSHOT = ROOT / "arch" / "host_abi" / "host_abi.snapshot.json"

paths = ["index.html", "bootstrap.js", "main.mjs", "app-host.mjs"]

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

doc = {
  "schema_version": "x07.device.host_abi.snapshot@0.1.0",
  "kind": "device_host_abi_snapshot",
  "host_abi_hash": abi_hash,
  "abi": abi,
}

if not SNAPSHOT.is_file():
  print(f"missing snapshot: {SNAPSHOT}", file=sys.stderr)
  print("---- computed snapshot (commit this) ----", file=sys.stderr)
  print(json.dumps(doc, indent=2, sort_keys=True), file=sys.stderr)
  sys.exit(1)

want = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
if want != doc:
  print("FAIL: arch/host_abi/host_abi.snapshot.json does not match computed ABI from assets", file=sys.stderr)
  print(f"snapshot={SNAPSHOT}", file=sys.stderr)
  print("---- computed ----", file=sys.stderr)
  print(json.dumps(doc, indent=2, sort_keys=True), file=sys.stderr)
  print("---- file ----", file=sys.stderr)
  print(json.dumps(want, indent=2, sort_keys=True), file=sys.stderr)
  sys.exit(1)

print("ok: host_abi.snapshot.json matches assets")
PY
