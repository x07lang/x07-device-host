import { mountWebUiApp } from "./app-host.mjs";

function postIpc(msg) {
  try {
    if (globalThis.ipc && typeof globalThis.ipc.postMessage === "function") {
      globalThis.ipc.postMessage(JSON.stringify(msg));
    }
  } catch (_) {}
}

async function main() {
  const root = document.getElementById("app");
  if (!root) throw new Error("missing #app");

  try {
    const mounted = await mountWebUiApp({
      wasmUrl: "./ui/reducer.wasm",
      componentEsmUrl: null,
      root,
      apiPrefix: null,
      appMeta: null,
      capabilities: null,
      policySnapshotSha256: null,
    });
    globalThis.__x07 = mounted;
    postIpc({ v: 1, kind: "x07.device.ui.ready" });
  } catch (err) {
    const msg = err && typeof err === "object" && "stack" in err ? String(err.stack) : String(err);
    root.textContent = "x07-device-host: failed to mount reducer wasm";
    const pre = document.createElement("pre");
    pre.textContent = msg;
    root.appendChild(pre);
    postIpc({ v: 1, kind: "x07.device.ui.error", message: msg });
  }
}

main();
