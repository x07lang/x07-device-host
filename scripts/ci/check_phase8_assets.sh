#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

python3 - "$ROOT_DIR" <<'PY'
import hashlib, json, pathlib, sys

ROOT = pathlib.Path(sys.argv[1])
ASSETS = ROOT / "crates" / "x07-device-host-assets" / "assets"
SNAPSHOT = ROOT / "arch" / "host_abi" / "host_abi.snapshot.json"
WEB_UI_SNAPSHOT = ROOT / "vendor" / "x07-web-ui" / "host" / "host.snapshot.json"

paths = ["index.html", "bootstrap.js", "main.mjs", "app-host.mjs"]

def sha256_bytes(data: bytes) -> str:
  h = hashlib.sha256()
  h.update(data)
  return h.hexdigest()

computed_assets = []
for rel in paths:
  p = ASSETS / rel
  if not p.exists():
    print(f"missing asset: {p}", file=sys.stderr)
    sys.exit(2)
  data = p.read_bytes()
  computed_assets.append({"path": rel, "sha256": sha256_bytes(data), "bytes_len": len(data)})

abi = {
  "abi_name": "webview_host_v1",
  "abi_version": "0.1.0",
  "assets": [{"path": a["path"], "sha256": a["sha256"]} for a in computed_assets],
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

if not WEB_UI_SNAPSHOT.is_file():
  print(f"missing canonical web-ui host snapshot: {WEB_UI_SNAPSHOT}", file=sys.stderr)
  sys.exit(1)

web = json.loads(WEB_UI_SNAPSHOT.read_text(encoding="utf-8"))

ok = True
for k in ("abi_name", "abi_version", "bridge_protocol_version", "host_abi_hash", "assets"):
  if k not in web:
    print(f"FAIL: host.snapshot.json missing key {k}: {WEB_UI_SNAPSHOT}", file=sys.stderr)
    ok = False

if web.get("abi_name") != abi["abi_name"]:
  print(f"FAIL: abi_name mismatch: want={abi['abi_name']} got={web.get('abi_name')}", file=sys.stderr)
  ok = False
if web.get("abi_version") != abi["abi_version"]:
  print(f"FAIL: abi_version mismatch: want={abi['abi_version']} got={web.get('abi_version')}", file=sys.stderr)
  ok = False
if web.get("bridge_protocol_version") != abi["bridge_protocol_version"]:
  print(
    f"FAIL: bridge_protocol_version mismatch: want={abi['bridge_protocol_version']} got={web.get('bridge_protocol_version')}",
    file=sys.stderr,
  )
  ok = False
if web.get("host_abi_hash") != abi_hash:
  print(f"FAIL: host_abi_hash mismatch: want={abi_hash} got={web.get('host_abi_hash')}", file=sys.stderr)
  ok = False

web_assets = web.get("assets")
if not isinstance(web_assets, list):
  print(f"FAIL: host.snapshot.json assets must be an array: {WEB_UI_SNAPSHOT}", file=sys.stderr)
  ok = False
  web_assets = []

def sort_key(a: dict) -> str:
  return str(a.get("path", ""))

want_assets = sorted(computed_assets, key=sort_key)
got_assets = sorted([a for a in web_assets if isinstance(a, dict)], key=sort_key)

if got_assets != want_assets:
  print(f"FAIL: device host assets do not match canonical web-ui host snapshot: {WEB_UI_SNAPSHOT}", file=sys.stderr)
  print("---- computed ----", file=sys.stderr)
  print(json.dumps(want_assets, indent=2, sort_keys=True), file=sys.stderr)
  print("---- file ----", file=sys.stderr)
  print(json.dumps(got_assets, indent=2, sort_keys=True), file=sys.stderr)
  ok = False

if not ok:
  sys.exit(1)

print("ok: host_abi.snapshot.json matches assets")
PY
