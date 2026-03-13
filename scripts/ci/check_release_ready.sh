#!/usr/bin/env bash
set -euo pipefail

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

root="$(repo_root)"
cd "$root"

bash scripts/ci/check_phase9.sh
bash scripts/ci/check_phase10.sh

python3 - <<'PY'
import json
import pathlib
import sys

root = pathlib.Path.cwd()
compat_path = root / "releases" / "compat" / "0.2.5.json"
if not compat_path.is_file():
    print(f"missing compat file: {compat_path}", file=sys.stderr)
    sys.exit(1)

compat = json.loads(compat_path.read_text(encoding="utf-8"))
if compat.get("device_host") != "0.2.5":
    print(f"unexpected device_host version in {compat_path}: {compat.get('device_host')!r}", file=sys.stderr)
    sys.exit(1)
if compat.get("x07_core") != ">=0.1.58,<0.2.0":
    print(f"unexpected x07_core range in {compat_path}: {compat.get('x07_core')!r}", file=sys.stderr)
    sys.exit(1)

readme = (root / "README.md").read_text(encoding="utf-8")
for needle in [
    "x07.device.telemetry.configure",
    "x07.device.telemetry.event",
    "host.webview_crash",
    "NSAllowsArbitraryLoads",
    "usesCleartextTraffic",
    "audio.playback",
    "haptics.present",
    "device.audio.play",
    "device.audio.stop",
    "device.haptics.trigger",
    "clipboard.read_text",
    "clipboard.write_text",
    "files.pick_multiple",
    "files.save",
    "files.drop",
    "share.present",
]:
    if needle not in readme:
        print(f"README missing telemetry release note marker: {needle}", file=sys.stderr)
        sys.exit(1)

print("ok: release-ready telemetry docs")
PY
