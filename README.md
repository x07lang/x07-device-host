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
| **Desktop runner** (`crates/x07-device-host-desktop/`) | System WebView runner using `tao`/`wry` (macOS, Linux, Windows) with the M0 safe subset: file import, host-owned blob sandbox, local notifications, and deterministic `unsupported` replies for the rest |
| **iOS template** (`mobile/ios/template/`) | WKWebView project template with embedded host assets (store-safe, no remote code loading) plus the M0 native bridge for permissions, camera, files, blobs, foreground location, and local notifications |
| **Android template** (`mobile/android/template/`) | WebViewAssetLoader project template with embedded host assets (store-safe, no remote code loading) plus the M0 native bridge for permissions, camera, files, blobs, foreground location, and local notifications |

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
cargo install --locked x07-device-host-desktop --version 0.2.1
```

Use the git install path only when you need unreleased development state from this repo:

```bash
cargo install --locked --git https://github.com/x07lang/x07-device-host.git x07-device-host-desktop
```

Print the current host ABI hash:

```bash
./target/debug/x07-device-host-desktop --host-abi-hash
```

Run a device bundle (loads `bundle.manifest.json`, `app.manifest.json` when present, `ui/reducer.wasm`, and any embedded profile sidecars):

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

Generated Android projects now include a pinned Gradle wrapper (`./gradlew`) for the AGP 8.2 line used by the template. Run Android builds with a supported JDK (17 or 21); on a workstation with Android Studio installed, the bundled JBR works:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug
```

Current device bundles may embed these sidecars under `profile/`:

- `device.profile.json`
- `device.capabilities.json`
- `device.telemetry.profile.json`

The host now serves `app.manifest.json` directly from the bundle root so the embedded bootstrap can pick up runtime settings such as `apiPrefix`, `componentEsmUrl`, and the `webUi` solve limits emitted by `x07-wasm device build`. When `app.manifest.json` omits capabilities, the host bootstrap still falls back to the capabilities sidecar from `bundle.manifest.json`, so reducer-side network allowlists continue to apply in packaged device apps. The telemetry profile sidecar configures native OTLP log export on desktop, iOS, and Android for both `http/json` and `http/protobuf`, including the standard `app.lifecycle`, `app.http`, `runtime.error`, `bridge.timing`, `reducer.timing`, `policy.violation`, and `host.webview_crash` event classes. The template-local host assets emit `x07.device.telemetry.configure` and `x07.device.telemetry.event`, and the Android/iOS templates route those IPC envelopes through native OTLP sinks instead of relying on the WebView network stack.

For the M0 native surface, the host distinguishes build-time capability allowlisting from runtime permission outcomes:

- Capability checks happen before every native request.
- Capture/import operations write bytes into a host-owned blob sandbox and return only manifests to the reducer.
- `x07-wasm device package` projects enabled M0 capabilities into generated iOS `Info.plist` usage strings and Android runtime-permission declarations.

Native templates now emit the `host.webview_crash` event from the platform WebView crash hooks, and the shared host assets populate the OTLP resource attributes expected by the platform release observability flow:

- `x07.app_id`
- `x07.target`
- `x07.release.exec_id`
- `x07.release.plan_id`
- `x07.package.sha256`
- `x07.provider.kind`
- `x07.provider.lane`
- `x07.rollout.percent`

Template networking defaults now cover collector development endpoints too:

- Android declares `android.permission.INTERNET` and `android:usesCleartextTraffic="true"` for HTTP OTLP collectors.
- iOS includes `NSAllowsArbitraryLoads` so the native `URLSession` telemetry sink can reach HTTP OTLP endpoints.

`scripts/ci/check_phase10.sh` validates the template asset sync plus the native telemetry hooks, crash hooks, Android cleartext support, and iOS ATS settings.

## Avoiding CI Reruns

Before pushing desktop-runner changes, run:

```bash
cargo clippy -p x07-device-host-desktop --all-targets -- -D warnings
```

Two recurring CI failure modes in this repo are worth checking locally first:

- Desktop bundle-loading helpers should not return a large `Diagnostic` directly in a `Result` error path; `clippy::result_large_err` is enforced in the macOS `phase9` job.
- Ubuntu jobs that run `scripts/ci/check_phase9.sh` or `scripts/ci/check_release_ready.sh` need `xz-utils` and `libwebkit2gtk-4.1-dev`, because those gates compile the desktop host and require the system WebKit/GLib pkg-config files.

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
