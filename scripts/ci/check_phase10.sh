#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

IOS_TEMPLATE_DIR="${ROOT_DIR}/mobile/ios/template"
ANDROID_TEMPLATE_DIR="${ROOT_DIR}/mobile/android/template"

test -d "${IOS_TEMPLATE_DIR}"
test -d "${ANDROID_TEMPLATE_DIR}"

export X07_DEVICE_HOST_ROOT_DIR="${ROOT_DIR}"

python3 - <<'PY'
import hashlib
import os
import pathlib
import sys

root = pathlib.Path(os.environ["X07_DEVICE_HOST_ROOT_DIR"])
canonical_assets = root / "crates" / "x07-device-host-assets" / "assets"

targets = [
    ("ios", root / "mobile" / "ios" / "template" / "X07DeviceApp" / "x07"),
    ("android", root / "mobile" / "android" / "template" / "app" / "src" / "main" / "assets" / "x07"),
]

token_targets = [
    (
        "ios",
        root / "mobile" / "ios" / "template",
        ["__X07_DISPLAY_NAME__", "__X07_IOS_BUNDLE_ID__", "__X07_VERSION__", "__X07_BUILD__"],
    ),
    (
        "android",
        root / "mobile" / "android" / "template",
        [
            "__X07_DISPLAY_NAME__",
            "__X07_ANDROID_APPLICATION_ID__",
            "__X07_ANDROID_MIN_SDK__",
            "__X07_VERSION__",
            "__X07_BUILD__",
        ],
    ),
]

asset_names = ["index.html", "bootstrap.js", "app-host.mjs"]

def sha256(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def iter_files(d: pathlib.Path) -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for p in d.rglob("*"):
        if not p.is_file():
            continue
        if p.name == ".DS_Store" or p.name.startswith("._"):
            continue
        out.append(p)
    return out

for platform, dir_path, tokens in token_targets:
    files = iter_files(dir_path)
    hay = b""
    for p in files:
        try:
            hay += p.read_bytes()
        except Exception as e:
            print(f"failed to read template file ({platform}): {p}: {e}", file=sys.stderr)
            sys.exit(1)
    for tok in tokens:
        if tok.encode("utf-8") not in hay:
            print(f"missing token {tok} under {dir_path}", file=sys.stderr)
            sys.exit(1)

for platform, dst_root in targets:
    for name in asset_names:
        src = canonical_assets / name
        dst = dst_root / name
        if not dst.is_file():
            print(f"missing template asset ({platform}): {dst}", file=sys.stderr)
            sys.exit(1)
        if src.read_bytes() != dst.read_bytes():
            print(
                f"template asset mismatch ({platform}): {name} sha256 src={sha256(src)} dst={sha256(dst)}",
                file=sys.stderr,
            )
            sys.exit(1)

print("ok: phase10 templates")
PY
