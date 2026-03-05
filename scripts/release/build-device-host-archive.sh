#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: build-device-host-archive.sh --component x07-device-host-desktop --version <X.Y.Z> --target <TARGET> --out-dir <DIR>
EOF
  exit 2
}

component=""
version=""
target=""
out_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --component)
      component="${2:-}"; shift 2 ;;
    --version)
      version="${2:-}"; shift 2 ;;
    --target)
      target="${2:-}"; shift 2 ;;
    --out-dir)
      out_dir="${2:-}"; shift 2 ;;
    -h|--help)
      usage ;;
    *)
      echo "unknown argument: $1" >&2
      usage ;;
  esac
done

[[ "$component" == "x07-device-host-desktop" ]] || {
  echo "--component must be x07-device-host-desktop" >&2
  exit 2
}
[[ -n "$version" && -n "$target" && -n "$out_dir" ]] || usage

tools_dir="${X07_RELEASE_TOOLS_DIR:-../x07/scripts/release}"
[[ -f "${tools_dir}/_build-rust-archive.sh" ]] || {
  echo "missing release tools helper: ${tools_dir}/_build-rust-archive.sh" >&2
  exit 1
}

exec bash "${tools_dir}/_build-rust-archive.sh" \
  --package x07-device-host-desktop \
  --bins x07-device-host-desktop \
  --asset-prefix x07-device-host-desktop \
  --version "$version" \
  --target "$target" \
  --out-dir "$out_dir"
