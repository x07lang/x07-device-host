import { mountWebUiApp } from "./app-host.mjs";

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

async function main() {
  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app");

  const manifest = (await loadJsonIfOk("./app.manifest.json")) || null;

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
    });
    globalThis.__x07 = mounted;
    postIpc({ v: 1, kind: "x07.device.ui.ready" });
  } catch (err) {
    const msg = err && typeof err === "object" && "stack" in err ? String(err.stack) : String(err);
    root.textContent = "x07 host: failed to mount reducer wasm";
    const pre = document.createElement("pre");
    pre.textContent = msg;
    root.appendChild(pre);
    postIpc({ v: 1, kind: "x07.device.ui.error", message: msg });
  }
}

main();

