# Repository Guide

## Build and test

- `cargo test`
- `bash scripts/ci/check_phase8.sh`

## Release workflow

- Release tags are `vX.Y.Z` and must match every published crate version in `crates/`.
- Keep `releases/compat/X.Y.Z.json` aligned with the shipped host ABI and assets.
- The release workflow reuses shared helpers from `x07/scripts/release/` through `.release-tools`; do not duplicate archive/checksum/manifest logic locally.
- Linux desktop release jobs depend on `libwebkit2gtk-4.1-dev`. Keep that package install in the workflow unless the Linux UI stack changes away from `wry`.
- Release outputs are:
  - desktop host archives
  - mobile template bundle
  - ABI snapshot asset
  - checksums, attestations, and `x07.component.release@0.1.0`
