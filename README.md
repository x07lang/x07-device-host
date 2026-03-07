# x07-device-host

Cross-platform device shell for [X07](https://github.com/x07lang/x07) "device apps" — runs x07 web UI WASM reducers inside the platform's system WebView (WKWebView on macOS/iOS, Android System WebView on Android).

x07-device-host is designed for **100% agentic coding** — an AI coding agent builds, packages, and tests device apps entirely on its own using structured contracts, deterministic bundles, and machine-readable outputs. No human needs to write X07 by hand.

## Prerequisites

The [X07 toolchain](https://github.com/x07lang/x07) must be installed before using x07-device-host. If you (or your agent) are new to X07, start with the **[Agent Quickstart](https://x07lang.org/docs/getting-started/agent-quickstart)** — it covers toolchain setup, project structure, and the workflow conventions an agent needs to be productive.

## What it includes

| Surface | Description |
|---------|-------------|
| **Host assets** (`crates/x07-device-host-assets/`) | Pinned host bootstrap assets consumed by device bundles (kept in sync with the canonical web host snapshot: `vendor/x07-web-ui/host/host.snapshot.json`) |
| **Host ABI** (`crates/x07-device-host-abi/`) | Deterministic host ABI hash used by `x07-wasm device` bundles for compatibility verification (snapshot: `arch/host_abi/host_abi.snapshot.json`) |
| **Desktop runner** (`crates/x07-device-host-desktop/`) | System WebView runner using `tao`/`wry` (macOS, Linux, Windows) |
| **iOS template** (`mobile/ios/template/`) | WKWebView project template with embedded host assets (store-safe, no remote code loading) |
| **Android template** (`mobile/android/template/`) | WebViewAssetLoader project template with embedded host assets (store-safe, no remote code loading) |

## Architecture

All platforms use the **same approach**: x07 web UI WASM reducer + canonical host assets running inside the platform's system WebView. This gives you:

- **One UI runtime** everywhere (WebView) — same `std.web_ui.*` reducer, same wasm artifact
- **Mature rendering** — OS vendor's rendering engine, accessibility stack, and security updates
- **Store compliance** — no remote code loading; UI wasm + host assets are embedded in the app bundle; updates happen via store releases

The host enforces a locked-down bridge:

- Only local HTML/JS/wasm assets loaded from the device bundle
- No navigation to arbitrary URLs (iOS cancels non-`x07:`; Android allowlists `https://appassets.androidplatform.net` + `x07:` only)
- Android template disables file/content URL access (`allowFileAccess=false`, `allowContentAccess=false`)
- CSP restricts scripts to `self` and WebAssembly compilation via `'wasm-unsafe-eval'` (no `'unsafe-eval'`)
- All HTTP calls go through `x07.device.http.fetch` with allowlisted hostnames, timeouts, and budgets
- Single structured message channel with schema-versioned envelopes

## Desktop runner

Build:

```bash
x07up component add device-host
x07-device-host-desktop --version
```

Fallback:

```bash
cargo install --locked x07-device-host-desktop --version 0.1.3
```

Use the git install path only when you need unreleased development state from this repo:

```bash
cargo install --locked --git https://github.com/x07lang/x07-device-host.git x07-device-host-desktop
```

Print the current host ABI hash:

```bash
./target/debug/x07-device-host-desktop --host-abi-hash
```

Run a device bundle (loads `bundle.manifest.json` + `ui/reducer.wasm`):

```bash
./target/debug/x07-device-host-desktop run --bundle dist/device
```

## Mobile project generation

Mobile projects are generated via `x07-wasm device package` (in [x07-wasm-backend](https://github.com/x07lang/x07-wasm-backend)):

```bash
x07-wasm device package --bundle dist/device --target ios --out-dir dist/ios --json
x07-wasm device package --bundle dist/device --target android --out-dir dist/android --json
```

Generated projects embed the device bundle under `x07/` — no remote code loading at runtime.

## Links

- Recommended install flow:
  - `x07up component add device-host`
  - `x07-device-host-desktop --version`
- [X07 Agent Quickstart](https://x07lang.org/docs/getting-started/agent-quickstart) — start here
- [X07 toolchain](https://github.com/x07lang/x07)
- [X07 website](https://x07lang.org)
- [WASM build tooling](https://github.com/x07lang/x07-wasm-backend) — `x07-wasm device build/verify/run/package`

## License

Dual-licensed under [Apache 2.0](LICENSE-APACHE) and [MIT](LICENSE).
