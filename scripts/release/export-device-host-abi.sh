#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: export-device-host-abi.sh --version <X.Y.Z> --out-dir <DIR>
EOF
  exit 2
}

version=""
out_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      version="${2:-}"; shift 2 ;;
    --out-dir)
      out_dir="${2:-}"; shift 2 ;;
    -h|--help)
      usage ;;
    *)
      echo "unknown argument: $1" >&2
      usage ;;
  esac
done

[[ -n "$version" && -n "$out_dir" ]] || usage
src="arch/host_abi/host_abi.snapshot.json"
[[ -f "$src" ]] || { echo "missing ABI snapshot: $src" >&2; exit 1; }
mkdir -p "$out_dir"
dst="${out_dir}/x07-device-host-abi-${version}.json"
cp -f "$src" "$dst"
printf '%s\n' "$dst"
