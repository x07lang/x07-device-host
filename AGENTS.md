# Repository Guide

## Build and test

- `cargo test`
- `bash scripts/ci/check_phase8.sh`
- `bash scripts/ci/check_release_ready.sh`

## Release workflow

- Release tags are `vX.Y.Z` and must match every published crate version in `crates/`.
- `scripts/ci/check_release_ready.sh` is the canonical release gate entry point. Keep the phase checks behind that wrapper.
- Keep `releases/compat/X.Y.Z.json` aligned with the shipped host ABI and assets.
- The release workflow reuses shared helpers from `x07/scripts/release/` through `.release-tools`; do not duplicate archive/checksum/manifest logic locally.
- Linux desktop release jobs depend on `libwebkit2gtk-4.1-dev`. Keep that package install in the workflow unless the Linux UI stack changes away from `wry`.
- GitHub Actions may not have `CARGO_REGISTRY_TOKEN`; in that case, publish the crates locally and verify them on crates.io before treating the GitHub release as complete.
- Release outputs are:
  - desktop host archives
  - mobile template bundle
  - ABI snapshot asset
  - checksums, attestations, and `x07.component.release@0.1.0`
