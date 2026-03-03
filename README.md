# x07-device-host

Device host implementation for x07 “device apps”.

Phase 8 delivers:

- `x07-device-host-assets`: pinned host bootstrap assets
- `x07-device-host-abi`: deterministic host ABI hash (used by x07-wasm device bundles)

Phase 9 adds:

- `x07-device-host-desktop`: desktop system-WebView runner (`tao`/`wry`)

Phase 10 adds:

- `mobile/ios/template`: iOS project template (WKWebView) with embedded host assets
- `mobile/android/template`: Android project template (WebViewAssetLoader) with embedded host assets

## Desktop runner

Build:

```bash
cargo build -p x07-device-host-desktop
```

Print the current host ABI hash:

```bash
./target/debug/x07-device-host-desktop --host-abi-hash
```

Run a device bundle (loads `bundle.manifest.json` + `ui/reducer.wasm`):

```bash
./target/debug/x07-device-host-desktop run --bundle dist/device
```
