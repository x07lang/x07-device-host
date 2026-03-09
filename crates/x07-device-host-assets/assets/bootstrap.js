import { createDeviceTelemetryRuntime, mountWebUiApp } from "./app-host.mjs";

function hasIpc() {
  return Boolean(globalThis.ipc && typeof globalThis.ipc.postMessage === "function");
}

function postIpc(msg) {
  if (!hasIpc()) return;
  try {
    globalThis.ipc.postMessage(JSON.stringify(msg));
  } catch (_) {}
}

async function loadJsonIfOk(url) {
  try {
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_) {
    return null;
  }
}

function bundleRefUrl(fileRef) {
  if (!fileRef || typeof fileRef !== "object") return null;
  const path = typeof fileRef.path === "string" ? fileRef.path : null;
  if (!path) return null;
  return path.startsWith("./") ? path : `./${path}`;
}

async function loadBundleSidecar(bundleManifest, key) {
  const url = bundleRefUrl(bundleManifest?.[key] ?? null);
  if (!url) return null;
  return (await loadJsonIfOk(url)) || null;
}

function installLifecycleTelemetry(telemetry) {
  if (!telemetry) return;
  globalThis.addEventListener?.("visibilitychange", () => {
    const state = String(globalThis.document?.visibilityState ?? "unknown");
    telemetry.emit(
      "app.lifecycle",
      state === "hidden" ? "app.background" : "app.foreground",
      { visibility_state: state },
    );
  });
  globalThis.addEventListener?.("pagehide", () => {
    telemetry.emit("app.lifecycle", "app.stop", { reason: "pagehide" });
  });
  globalThis.addEventListener?.("error", (ev) => {
    const msg = String(ev?.message ?? ev?.error?.message ?? "unhandled error");
    telemetry.emit(
      "runtime.error",
      "runtime.error",
      { stage: "window.error", message: msg },
      { body: String(ev?.error?.stack ?? msg), severity: "error" },
    );
  });
  globalThis.addEventListener?.("unhandledrejection", (ev) => {
    const reason = ev?.reason;
    const msg = String(reason?.message ?? reason ?? "unhandled rejection");
    telemetry.emit(
      "runtime.error",
      "runtime.error",
      { stage: "window.unhandledrejection", message: msg },
      { body: String(reason?.stack ?? msg), severity: "error" },
    );
  });
}

async function main() {
  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app");

  const manifest = (await loadJsonIfOk("./app.manifest.json")) || null;
  const bundleManifest = (await loadJsonIfOk("./bundle.manifest.json")) || null;
  const deviceProfile = (await loadBundleSidecar(bundleManifest, "profile")) || null;
  const telemetryProfile = (await loadBundleSidecar(bundleManifest, "telemetry_profile")) || null;

  const telemetry = createDeviceTelemetryRuntime({
    postIpc,
    telemetryProfile,
    bundleManifest,
    deviceProfile,
  });
  telemetry.configure();
  installLifecycleTelemetry(telemetry);
  telemetry.emit("app.lifecycle", "app.start", {
    has_app_manifest: Boolean(manifest),
    has_bundle_manifest: Boolean(bundleManifest),
    host_mode: hasIpc() ? "device" : "web",
  });

  const defaultWasmUrl = hasIpc() ? "./ui/reducer.wasm" : "./app.wasm";
  const wasmUrl = manifest?.wasmUrl ?? manifest?.wasm_url ?? defaultWasmUrl;
  const apiPrefix = manifest?.apiPrefix ?? manifest?.api_prefix ?? null;
  const appMeta = manifest?.app ?? null;
  const policySnapshotSha256 =
    manifest?.policySnapshotSha256 ?? manifest?.policy_snapshot_sha256 ?? null;

  let capabilities = manifest?.capabilities ?? manifest?.caps ?? null;
  const capabilitiesUrl = manifest?.capabilitiesUrl ?? manifest?.capabilities_url ?? null;
  if (!capabilities && typeof capabilitiesUrl === "string" && capabilitiesUrl) {
    capabilities = (await loadJsonIfOk(capabilitiesUrl)) || null;
  }
  if (!capabilities) {
    capabilities = (await loadBundleSidecar(bundleManifest, "capabilities")) || null;
  }

  let componentEsmUrl = null;
  if (manifest?.componentEsmUrl || manifest?.component_esm_url) {
    componentEsmUrl = manifest.componentEsmUrl ?? manifest.component_esm_url ?? null;
  } else {
    try {
      await import("./transpiled/app.mjs");
      componentEsmUrl = "./transpiled/app.mjs";
    } catch (_) {}
  }

  try {
    const mounted = await mountWebUiApp({
      wasmUrl,
      componentEsmUrl,
      root,
      apiPrefix,
      appMeta,
      capabilities,
      policySnapshotSha256,
      telemetry,
    });
    globalThis.__x07 = mounted;
    telemetry.emit("app.lifecycle", "app.ready", {
      reducer_mode: componentEsmUrl ? "component+esm" : "core",
    });
    postIpc({ v: 1, kind: "x07.device.ui.ready" });
  } catch (err) {
    const msg = err && typeof err === "object" && "stack" in err ? String(err.stack) : String(err);
    root.textContent = "x07 host: failed to mount reducer wasm";
    const pre = document.createElement("pre");
    pre.textContent = msg;
    root.appendChild(pre);
    telemetry.emit(
      "runtime.error",
      "bootstrap.error",
      { stage: "bootstrap", message: msg },
      { body: msg, severity: "error" },
    );
    postIpc({ v: 1, kind: "x07.device.ui.error", message: msg });
  }
}

main();
