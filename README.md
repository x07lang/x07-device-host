> [!IMPORTANT]
> **This repository is archived** (2026-06). X07 has refocused on its core: a deterministic, certifiable execution substrate for agent-written software. This repo (the native device runtime for X07 web UI applications on desktop and mobile) is no longer maintained — no feature work, no releases. The active surface is [`x07lang/x07`](https://github.com/x07lang/x07), `x07-mcp`, `x07-registry`, `x07-wasm-backend`, and `hardproof`. Rationale and roadmap: `x07/docs/roadmap.md`.

# x07-device-host

Native device runtime for X07 web UI applications.

`x07-device-host` runs the same X07 web UI WASM reducer inside system WebViews on desktop and mobile. It is the native shell layer that turns one reducer into a desktop app, an iOS app, and an Android app without rewriting the UI for each platform.

**Start here:** [`x07lang/x07-web-ui`](https://github.com/x07lang/x07-web-ui) · [`x07lang/x07-wasm-backend`](https://github.com/x07lang/x07-wasm-backend) · [Agent Quickstart](https://x07lang.org/docs/getting-started/agent-quickstart)

## When To Use It

Use `x07-device-host` when you want to:

- ship one X07 UI reducer across desktop, iOS, and Android
- access native capabilities such as clipboard, files, notifications, location, audio, or haptics through a controlled host bridge
- package apps for store distribution without remote code loading

If you only need a browser app, `x07-web-ui` plus `x07-wasm` is usually enough.

## Quick Start

Most users install the released component through `x07up`:

```sh
x07up component add device-host
x07-device-host-desktop --version
```

Run a built device bundle on desktop:

```sh
x07-device-host-desktop run --bundle dist/device
```

Mobile project generation happens through `x07-wasm`:

```sh
x07-wasm device package --bundle dist/device --target ios --out-dir dist/ios --json
x07-wasm device package --bundle dist/device --target android --out-dir dist/android --json
```

## What Lives In This Repo

- desktop runner under `crates/x07-device-host-desktop/`
- host assets and host ABI packages
- iOS and Android template projects under `mobile/`

## How It Fits The X07 Ecosystem

- [`x07`](https://github.com/x07lang/x07) is the core language and toolchain
- [`x07-web-ui`](https://github.com/x07lang/x07-web-ui) defines the reducer-side UI contract
- [`x07-wasm-backend`](https://github.com/x07lang/x07-wasm-backend) builds and packages device bundles
- `x07-device-host` is the native runtime that executes those bundles on real devices and desktops
- [`x07-platform`](https://github.com/x07lang/x07-platform) supervises release, deploy, incident, and rollout workflows when the app moves beyond local builds

## Source Development

If you need unreleased development state, work from this repo and use the pinned Rust toolchain:

```sh
cargo clippy -p x07-device-host-desktop --all-targets -- -D warnings
```

Use the current repo CI scripts for the full release-ready validation flow.

## License

Dual-licensed under [Apache 2.0](LICENSE-APACHE) and [MIT](LICENSE).
