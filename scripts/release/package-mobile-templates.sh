#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: package-mobile-templates.sh --version <X.Y.Z> --out-dir <DIR>
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
[[ -d mobile ]] || { echo "missing mobile/ directory" >&2; exit 1; }

archive_base="x07-device-host-mobile-templates-${version}"
archive_path="${out_dir}/${archive_base}.zip"
stage_root="${out_dir}/.stage/${archive_base}"

rm -rf "${stage_root}" "${archive_path}"
mkdir -p "${stage_root}/mobile"
cp -R mobile/. "${stage_root}/mobile/"

if [[ -f README.md ]]; then
  cp -f README.md "${stage_root}/"
fi

python3 - "$stage_root" "$archive_path" <<'PY'
import pathlib
import sys
import zipfile

stage_root = pathlib.Path(sys.argv[1]).resolve()
archive_path = pathlib.Path(sys.argv[2]).resolve()
archive_path.parent.mkdir(parents=True, exist_ok=True)

with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(stage_root.rglob("*")):
        if path.is_file():
            zf.write(path, arcname=str(pathlib.Path(stage_root.name) / path.relative_to(stage_root)))
PY

printf '%s\n' "$archive_path"
