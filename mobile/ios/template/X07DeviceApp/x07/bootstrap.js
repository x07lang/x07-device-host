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
  const file =
    fileRef.file && typeof fileRef.file === "object" ? fileRef.file : fileRef;
  const path = typeof file.path === "string" ? file.path : null;
  if (!path) return null;
  return path.startsWith("./") ? path : `./${path}`;
}

async function loadBundleSidecar(bundleManifest, key) {
  const url = bundleRefUrl(bundleManifest?.[key] ?? null);
  if (!url) return null;
  return (await loadJsonIfOk(url)) || null;
}

function deriveApiPrefix(manifest, deviceProfile) {
  const manifestPrefix = manifest?.apiPrefix ?? manifest?.api_prefix ?? null;
  if (typeof manifestPrefix === "string" && manifestPrefix) {
    return manifestPrefix;
  }
  const backend = deviceProfile?.backend;
  if (!backend || backend.mode !== "remote_http") {
    return null;
  }
  const baseUrl = typeof backend.base_url === "string" ? backend.base_url : "";
  return baseUrl || null;
}

function normalizeCapabilitiesForHost(capabilities, deviceProfile) {
  if (!capabilities || typeof capabilities !== "object") {
    return capabilities;
  }
  const net = capabilities.network;
  if (net && typeof net === "object" && net.mode === "allowlist" && Array.isArray(net.allowlist)) {
    return capabilities;
  }

  const backend = deviceProfile?.backend;
  if (!backend || backend.mode !== "remote_http" || typeof backend.base_url !== "string") {
    return capabilities;
  }

  try {
    const baseUrl = new URL(backend.base_url);
    const proto =
      baseUrl.protocol === "https:" ? "https" : baseUrl.protocol === "http:" ? "http" : "";
    if (!proto) return capabilities;
    const port = baseUrl.port
      ? Number(baseUrl.port)
      : baseUrl.protocol === "https:"
        ? 443
        : 80;
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
      return capabilities;
    }

    const allowedHosts = new Set();
    if (Array.isArray(net?.allow_hosts)) {
      for (const host of net.allow_hosts) {
        if (typeof host === "string" && host) {
          allowedHosts.add(host.toLowerCase());
        }
      }
    }
    if (Array.isArray(backend.allowed_hosts)) {
      for (const host of backend.allowed_hosts) {
        if (typeof host === "string" && host) {
          allowedHosts.add(host.toLowerCase());
        }
      }
    }
    if (allowedHosts.size !== 0 && !allowedHosts.has(baseUrl.hostname.toLowerCase())) {
      return capabilities;
    }

    return {
      ...capabilities,
      network: {
        mode: "allowlist",
        allowlist: [
          {
            proto,
            host: baseUrl.hostname.toLowerCase(),
            port,
          },
        ],
      },
    };
  } catch (_) {
    return capabilities;
  }
}

function deriveWebUiRuntime(manifest) {
  const raw = manifest?.webUi ?? manifest?.web_ui ?? null;
  if (!raw || typeof raw !== "object") return {};

  const arenaCapBytes = Number(raw.arenaCapBytes ?? raw.arena_cap_bytes ?? 0);
  const maxOutputBytes = Number(raw.maxOutputBytes ?? raw.max_output_bytes ?? 0);
  const out = {};

  if (Number.isFinite(arenaCapBytes) && arenaCapBytes > 0) {
    out.arenaCapBytes = arenaCapBytes;
  }
  if (Number.isFinite(maxOutputBytes) && maxOutputBytes > 0) {
    out.maxOutputBytes = maxOutputBytes;
  }
  return out;
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
  const bundleManifest = hasIpc() ? (await loadJsonIfOk("./bundle.manifest.json")) || null : null;
  const deviceProfile = (await loadBundleSidecar(bundleManifest, "profile")) || null;
  const telemetryProfile = (await loadBundleSidecar(bundleManifest, "telemetry_profile")) || null;

  const telemetry = createDeviceTelemetryRuntime({
    postIpc,
    telemetryProfile,
    bundleManifest,
    deviceProfile,
  });
  if (hasIpc()) {
    globalThis.__x07DeviceNativeBridge = "m0";
  }
  telemetry.configure();
  installLifecycleTelemetry(telemetry);
  telemetry.emit("app.lifecycle", "app.start", {
    has_app_manifest: Boolean(manifest),
    has_bundle_manifest: Boolean(bundleManifest),
    host_mode: hasIpc() ? "device" : "web",
  });

  const defaultWasmUrl = hasIpc() ? "./ui/reducer.wasm" : "./app.wasm";
  const wasmUrl = manifest?.wasmUrl ?? manifest?.wasm_url ?? defaultWasmUrl;
  const apiPrefix = deriveApiPrefix(manifest, deviceProfile);
  const appMeta = manifest?.app ?? null;
  const policySnapshotSha256 =
    manifest?.policySnapshotSha256 ?? manifest?.policy_snapshot_sha256 ?? null;
  const webUiRuntime = deriveWebUiRuntime(manifest);

  let capabilities = manifest?.capabilities ?? manifest?.caps ?? null;
  const capabilitiesUrl = manifest?.capabilitiesUrl ?? manifest?.capabilities_url ?? null;
  if (!capabilities && typeof capabilitiesUrl === "string" && capabilitiesUrl) {
    capabilities = (await loadJsonIfOk(capabilitiesUrl)) || null;
  }
  if (!capabilities) {
    capabilities = (await loadBundleSidecar(bundleManifest, "capabilities")) || null;
  }
  capabilities = normalizeCapabilitiesForHost(capabilities, deviceProfile);

  let componentEsmUrl = null;
  if (manifest?.componentEsmUrl || manifest?.component_esm_url) {
    componentEsmUrl = manifest.componentEsmUrl ?? manifest.component_esm_url ?? null;
  } else if (hasIpc()) {
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
      ...webUiRuntime,
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
