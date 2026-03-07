const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });
const textDecoderStrict = new TextDecoder("utf-8", { fatal: true });

const MAX_EFFECT_LOOPS = 16;
const MAX_EFFECTS_PER_STEP = 32;
const MAX_EFFECT_INJECT_BYTES = 1 << 20;
const MAX_HTTP_BODY_BYTES = 1 << 20;

function alignUp(x, align) {
  if (align <= 1) return x;
  return (x + (align - 1)) & ~(align - 1);
}

function globalU32(exported, name) {
  if (typeof exported === "number") return exported >>> 0;
  if (exported && typeof exported === "object" && "value" in exported) {
    return (exported.value >>> 0) >>> 0;
  }
  throw new Error(`missing wasm global export ${name}`);
}

async function instantiateCoreWasm(wasmUrl, imports) {
  const resp = await fetch(wasmUrl);
  if (!resp.ok) {
    throw new Error(`fetch wasm failed: ${resp.status} ${resp.statusText}`);
  }
  const contentType = resp.headers.get("content-type") || "";
  const want = "application/wasm";
  const mimeOk = contentType.toLowerCase() === want;

  if (WebAssembly.instantiateStreaming) {
    if (!mimeOk) {
      throw new Error(`wasm MIME must be ${want}; got: ${contentType || "(missing)"}`);
    }
    const { instance, module } = await WebAssembly.instantiateStreaming(resp, imports);
    return { instance, module };
  }

  const buf = await resp.arrayBuffer();
  const { instance, module } = await WebAssembly.instantiate(buf, imports);
  return { instance, module };
}

function createSolveV2Core(exports, { arenaCapBytes, maxOutputBytes }) {
  if (!exports || typeof exports !== "object") {
    throw new Error("missing wasm exports");
  }
  const memory = exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("missing wasm memory export");
  }
  const solve = exports.x07_solve_v2;
  if (typeof solve !== "function") {
    throw new Error("missing wasm export x07_solve_v2");
  }

  const heapBase = globalU32(exports.__heap_base, "__heap_base");
  const dataEnd = globalU32(exports.__data_end, "__data_end");

  function ensureMemory(needBytes) {
    const haveBytes = memory.buffer.byteLength;
    if (needBytes <= haveBytes) return;
    const page = 65536;
    const delta = needBytes - haveBytes;
    const pages = Math.ceil(delta / page);
    memory.grow(pages);
  }

  function callSolveV2(inputBytes) {
    const allocBase = Math.max(heapBase, dataEnd) >>> 0;
    const retptr = alignUp(allocBase, 8) >>> 0;
    const inputPtr = alignUp(retptr + 8, 8) >>> 0;
    const arenaPtr = alignUp(inputPtr + inputBytes.length, 8) >>> 0;
    const arenaEnd = arenaPtr + arenaCapBytes;

    ensureMemory(arenaEnd);
    const u8 = new Uint8Array(memory.buffer);
    const dv = new DataView(memory.buffer);

    dv.setUint32(retptr + 0, 0, true);
    dv.setUint32(retptr + 4, 0, true);
    u8.set(inputBytes, inputPtr);

    solve(retptr, arenaPtr, arenaCapBytes, inputPtr, inputBytes.length);

    const outPtr = dv.getUint32(retptr + 0, true) >>> 0;
    const outLen = dv.getUint32(retptr + 4, true) >>> 0;
    if (outLen > maxOutputBytes) {
      throw new Error(`output too large: outLen=${outLen} maxOutputBytes=${maxOutputBytes}`);
    }

    if (outPtr < arenaPtr || outPtr + outLen > arenaEnd) {
      throw new Error(
        `output not within arena: out=[${outPtr},${outPtr + outLen}) arena=[${arenaPtr},${arenaEnd})`,
      );
    }

    const out = u8.slice(outPtr, outPtr + outLen);
    return out;
  }

  return { callSolveV2 };
}

function decodePointerToken(raw) {
  return String(raw).replace(/~1/g, "/").replace(/~0/g, "~");
}

function parseJsonPointer(path) {
  const p = String(path ?? "");
  if (p === "") return [];
  if (!p.startsWith("/")) throw new Error(`invalid JSON Pointer: ${p}`);
  return p
    .slice(1)
    .split("/")
    .map(decodePointerToken);
}

function applyJsonPatch(doc, patchset) {
  let root = doc;
  const ops = Array.isArray(patchset) ? patchset : [];
  for (const op of ops) {
    if (!op || typeof op !== "object") throw new Error("invalid patch op");
    const kind = String(op.op ?? "");
    const path = String(op.path ?? "");
    const tokens = parseJsonPointer(path);

    if (tokens.length === 0) {
      if (kind === "add" || kind === "replace") {
        root = op.value;
        continue;
      }
      if (kind === "remove") {
        root = null;
        continue;
      }
      throw new Error(`unsupported op: ${kind}`);
    }

    let parent = root;
    for (let i = 0; i < tokens.length - 1; i++) {
      const t = tokens[i];
      if (Array.isArray(parent)) {
        const idx = t === "-" ? parent.length : Number(t);
        if (!Number.isFinite(idx) || idx < 0 || idx >= parent.length) {
          throw new Error(`invalid array index in path: ${path}`);
        }
        parent = parent[idx];
      } else if (parent && typeof parent === "object") {
        if (!(t in parent)) throw new Error(`missing object key in path: ${path}`);
        parent = parent[t];
      } else {
        throw new Error(`invalid parent in path: ${path}`);
      }
    }

    const last = tokens[tokens.length - 1];
    if (Array.isArray(parent)) {
      const idx = last === "-" ? parent.length : Number(last);
      if (!Number.isFinite(idx) || idx < 0) throw new Error(`invalid array index in path: ${path}`);
      if (kind === "add") {
        if (idx > parent.length) throw new Error(`add index out of bounds: ${path}`);
        parent.splice(idx, 0, op.value);
        continue;
      }
      if (kind === "remove") {
        if (idx >= parent.length) throw new Error(`remove index out of bounds: ${path}`);
        parent.splice(idx, 1);
        continue;
      }
      if (kind === "replace") {
        if (idx >= parent.length) throw new Error(`replace index out of bounds: ${path}`);
        parent[idx] = op.value;
        continue;
      }
      throw new Error(`unsupported op: ${kind}`);
    }

    if (!parent || typeof parent !== "object") throw new Error(`invalid parent in path: ${path}`);
    if (kind === "add" || kind === "replace") {
      parent[last] = op.value;
      continue;
    }
    if (kind === "remove") {
      if (!(last in parent)) throw new Error(`remove missing key: ${path}`);
      delete parent[last];
      continue;
    }
    throw new Error(`unsupported op: ${kind}`);
  }
  return root;
}

function stableJson(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return JSON.stringify(value);
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (t !== "object") return "null";
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
}

function buildAllowedEventsMap(node, out) {
  if (!node || typeof node !== "object") return;
  const key = node.key != null ? String(node.key) : "";
  if (key) {
    const on = Array.isArray(node.on) ? node.on : [];
    const set = out.get(key) || new Set();
    for (const h of on) {
      if (!h || typeof h !== "object") continue;
      const type = String(h.type || "");
      if (!type) continue;
      set.add(type);
    }
    out.set(key, set);
  }
  const children = Array.isArray(node.children) ? node.children : [];
  for (const c of children) buildAllowedEventsMap(c, out);
}

const TAG_ALLOWLIST = new Set([
  "a",
  "b",
  "br",
  "button",
  "code",
  "div",
  "em",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "label",
  "li",
  "ol",
  "option",
  "p",
  "pre",
  "select",
  "small",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const GLOBAL_ATTR_ALLOWLIST = new Set([
  "alt",
  "autocomplete",
  "autofocus",
  "checked",
  "disabled",
  "for",
  "href",
  "id",
  "inputmode",
  "max",
  "maxlength",
  "min",
  "minlength",
  "name",
  "pattern",
  "placeholder",
  "readonly",
  "required",
  "role",
  "rows",
  "selected",
  "size",
  "src",
  "step",
  "tabindex",
  "title",
  "type",
  "value",
]);

function sanitizeTag(rawTag) {
  const tag = String(rawTag ?? "div").toLowerCase();
  if (TAG_ALLOWLIST.has(tag)) return tag;
  return "div";
}

function sanitizeSameOriginUrlPath(raw) {
  const s0 = String(raw ?? "").trim();
  if (!s0) return null;

  let url;
  try {
    url = new URL(s0, document.baseURI);
  } catch (_) {
    return null;
  }

  const origin = String(globalThis.location?.origin ?? "");
  if (!origin || url.origin !== origin) return null;

  return `${url.pathname}${url.search}${url.hash}`;
}

function sanitizeAttr(tag, rawName, rawValue) {
  const name = String(rawName ?? "").toLowerCase();
  if (!name) return null;

  if (name === "data-x07-key") return null;
  if (name === "style" || name === "class") return null;
  if (name.startsWith("on")) return null;
  if (name === "srcdoc") return null;

  if (name.startsWith("data-") || name.startsWith("aria-")) {
    return { name, value: String(rawValue ?? "") };
  }

  if (!GLOBAL_ATTR_ALLOWLIST.has(name)) return null;
  if (name === "href") {
    if (tag !== "a") return null;
    const value = sanitizeSameOriginUrlPath(rawValue);
    if (value == null) return null;
    return { name, value };
  }
  if (name === "src") {
    if (tag !== "img") return null;
    const value = sanitizeSameOriginUrlPath(rawValue);
    if (value == null) return null;
    return { name, value };
  }

  return { name, value: String(rawValue ?? "") };
}

function sanitizeAttrs(tag, attrs) {
  const next = attrs && typeof attrs === "object" ? attrs : {};
  const out = {};
  for (const [k, v] of Object.entries(next)) {
    const sv = sanitizeAttr(tag, k, v);
    if (!sv) continue;
    out[sv.name] = sv.value;
  }
  return out;
}

export const __x07_host_private = {
  sanitizeTag,
  sanitizeSameOriginUrlPath,
  sanitizeAttr,
  sanitizeAttrs,
  reconcileNode,
  render,
  snapshotFocusedControl,
  restoreFocusedControl,
};

function setAttrs(el, tag, attrs) {
  const next = sanitizeAttrs(tag, attrs);
  const prevNames = new Set();
  for (const name of el.getAttributeNames()) prevNames.add(name);
  for (const [k, v] of Object.entries(next)) {
    prevNames.delete(k);
    if (v == null) continue;
    el.setAttribute(k, String(v));
  }
  for (const k of prevNames) {
    if (k === "data-x07-key") continue;
    el.removeAttribute(k);
  }
}

function setClass(el, cls) {
  if (Array.isArray(cls)) {
    el.className = cls.filter((c) => c != null && String(c).length > 0).map(String).join(" ");
    return;
  }
  if (typeof cls === "string") {
    el.className = cls;
    return;
  }
  el.className = "";
}

function setStyle(el, style) {
  const next = style && typeof style === "object" ? style : {};
  const prev = new Set();
  for (const k of Array.from(el.style)) prev.add(k);
  for (const [k, v] of Object.entries(next)) {
    prev.delete(k);
    if (v == null) continue;
    el.style.setProperty(k, String(v));
  }
  for (const k of prev) {
    el.style.removeProperty(k);
  }
}

function sameNodeSequence(prevNodes, nextNodes) {
  if (prevNodes.length !== nextNodes.length) return false;
  for (let i = 0; i < prevNodes.length; i++) {
    if (prevNodes[i] !== nextNodes[i]) return false;
  }
  return true;
}

function reconcileNode(prevNode, prevDom, nextNode) {
  if (!nextNode || typeof nextNode !== "object") {
    return document.createTextNode("");
  }
  const kind = String(nextNode.k || "");
  const key = nextNode.key != null ? String(nextNode.key) : "";

  if (kind === "text") {
    const text = String(nextNode.text ?? "");
    const reuse = prevDom && prevDom.nodeType === 3 && prevDom.__x07Key === key;
    const node = reuse ? prevDom : document.createTextNode(text);
    node.__x07Key = key;
    if (reuse && node.textContent !== text) node.textContent = text;
    return node;
  }

  if (kind !== "el") {
    const node = document.createTextNode("");
    node.__x07Key = key;
    return node;
  }

  const tag = String(nextNode.tag || "div");
  const safeTag = sanitizeTag(tag);
  const canReuse =
    prevDom &&
    prevDom.nodeType === 1 &&
    prevDom.__x07Key === key &&
    String(prevDom.tagName || "").toLowerCase() === safeTag;
  const el = canReuse ? prevDom : document.createElement(safeTag);
  el.__x07Key = key;
  if (key) el.dataset.x07Key = key;

  const props = nextNode.props && typeof nextNode.props === "object" ? nextNode.props : {};
  setAttrs(el, safeTag, props.attrs);
  setClass(el, props.class);
  setStyle(el, props.style);

  const prevChildren = prevNode && typeof prevNode === "object" ? prevNode.children : [];
  const nextChildren = Array.isArray(nextNode.children) ? nextNode.children : [];
  const prevDomChildren = Array.from(el.childNodes);

  const prevByKey = new Map();
  if (Array.isArray(prevChildren)) {
    for (let i = 0; i < prevChildren.length; i++) {
      const pn = prevChildren[i];
      const pd = prevDomChildren[i];
      const pk = pn && typeof pn === "object" && pn.key != null ? String(pn.key) : "";
      if (pk && pd) prevByKey.set(pk, { node: pn, dom: pd });
    }
  }

  const newDomChildren = [];
  for (const cn of nextChildren) {
    const ck = cn && typeof cn === "object" && cn.key != null ? String(cn.key) : "";
    const prev = ck ? prevByKey.get(ck) : null;
    const childDom = reconcileNode(prev ? prev.node : null, prev ? prev.dom : null, cn);
    newDomChildren.push(childDom);
  }
  if (!sameNodeSequence(prevDomChildren, newDomChildren)) {
    el.replaceChildren(...newDomChildren);
  }

  return el;
}

function supportsTextSelection(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea";
}

function snapshotFocusedControl(root) {
  const active = globalThis.document?.activeElement;
  if (!active || active.nodeType !== 1) return null;
  if (typeof root?.contains === "function" && !root.contains(active)) return null;

  const keyed =
    active?.dataset?.x07Key && typeof active.dataset.x07Key === "string"
      ? active
      : active?.closest?.("[data-x07-key]") ?? null;
  const key = keyed?.dataset?.x07Key || "";
  if (!key) return null;

  const snap = { key };
  if (!supportsTextSelection(keyed)) {
    return snap;
  }

  const start = keyed.selectionStart;
  const end = keyed.selectionEnd;
  const direction = keyed.selectionDirection;
  if (Number.isInteger(start) && Number.isInteger(end)) {
    snap.selectionStart = start;
    snap.selectionEnd = end;
    if (typeof direction === "string" && direction) {
      snap.selectionDirection = direction;
    }
  }
  return snap;
}

function findKeyedElement(root, key) {
  if (!root || !key) return null;
  if (root.nodeType === 1 && root?.dataset?.x07Key === key) {
    return root;
  }
  const children = Array.isArray(root?.childNodes) ? root.childNodes : Array.from(root?.childNodes || []);
  for (const child of children) {
    const found = findKeyedElement(child, key);
    if (found) return found;
  }
  return null;
}

function restoreFocusedControl(root, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const key = typeof snapshot.key === "string" ? snapshot.key : "";
  if (!key) return;

  const target = findKeyedElement(root, key);
  if (!target || typeof target.focus !== "function") return;

  try {
    target.focus({ preventScroll: true });
  } catch (_) {
    target.focus();
  }

  if (!supportsTextSelection(target) || typeof target.setSelectionRange !== "function") {
    return;
  }

  const start = snapshot.selectionStart;
  const end = snapshot.selectionEnd;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return;

  try {
    target.setSelectionRange(start, end, snapshot.selectionDirection || "none");
  } catch (_) {}
}

function render(root, prevTree, nextTree) {
  if (!nextTree || typeof nextTree !== "object") {
    root.textContent = "";
    return;
  }
  const focusSnapshot = snapshotFocusedControl(root);
  const prevNode = prevTree && typeof prevTree === "object" ? prevTree.root : null;
  const nextNode = nextTree.root;
  const prevDom = root.firstChild;
  const nextDom = reconcileNode(prevNode, prevDom, nextNode);
  const prevRootChildren = Array.from(root.childNodes);
  if (!sameNodeSequence(prevRootChildren, [nextDom])) {
    root.replaceChildren(nextDom);
  }
  restoreFocusedControl(root, focusSnapshot);
}

function downloadJson(filename, doc) {
  const bytes = textEncoder.encode(JSON.stringify(doc, null, 2) + "\n");
  const blob = new Blob([bytes], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    s += String.fromCharCode(...chunk);
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  const s = atob(String(b64 ?? ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function joinUrlPath(prefix, path) {
  const pfx = String(prefix ?? "");
  const p = String(path ?? "");
  if (!pfx || pfx === "/") return p;
  if (!p) return pfx;
  if (p.startsWith(pfx + "/") || p === pfx) return p;
  if (pfx.endsWith("/") && p.startsWith("/")) return pfx + p.slice(1);
  if (!pfx.endsWith("/") && !p.startsWith("/")) return `${pfx}/${p}`;
  return pfx + p;
}

function capsAllowsExternalHttpUrl(capabilities, urlObj) {
  if (!capabilities || typeof capabilities !== "object") return false;
  const net = capabilities.network;
  if (!net || typeof net !== "object") return false;

  const mode = String(net.mode ?? "");
  if (mode !== "allowlist") return false;

  const allowlist = Array.isArray(net.allowlist) ? net.allowlist : [];

  const proto = urlObj.protocol === "https:" ? "https" : urlObj.protocol === "http:" ? "http" : "";
  const host = String(urlObj.hostname ?? "").toLowerCase();
  const port = urlObj.port
    ? Number(urlObj.port)
    : urlObj.protocol === "https:"
      ? 443
      : urlObj.protocol === "http:"
        ? 80
        : 0;

  if (!proto || !host || !Number.isFinite(port) || port < 0 || port > 65535) return false;

  for (const e of allowlist) {
    if (!e || typeof e !== "object") continue;
    const eProto = String(e.proto ?? "");
    const eHost = String(e.host ?? "").toLowerCase();
    const ePort = Number(e.port ?? -1);
    if (eProto !== proto) continue;
    if (eHost !== host) continue;
    if (!Number.isFinite(ePort) || ePort !== port) continue;
    return true;
  }

  return false;
}

function enforceFetchAllowed(capabilities, rawUrl) {
  const hrefBase = String(globalThis.location?.href ?? "http://localhost/");
  const originBase = String(globalThis.location?.origin ?? "");

  const urlObj = new URL(String(rawUrl ?? ""), hrefBase);

  // Always allow same-origin (supports relative /api/... fetch by default).
  if (originBase && urlObj.origin === originBase) return;

  // Only allow cross-origin HTTP(S) when explicitly allowlisted.
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
    throw new Error(`fetch denied (unsupported scheme): ${urlObj.protocol}`);
  }
  if (!capsAllowsExternalHttpUrl(capabilities, urlObj)) {
    throw new Error(`fetch denied by capabilities: ${urlObj.href}`);
  }
}

function sortedHeaderPairsFromHeaders(headers) {
  const out = [];
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h || typeof h !== "object") continue;
      const k = String(h.k ?? "");
      if (!k) continue;
      out.push([k, String(h.v ?? "")]);
    }
  } else if (headers && typeof headers.forEach === "function") {
    headers.forEach((v, k) => out.push([String(k), String(v)]));
  } else if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) out.push([String(k), String(v)]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return out;
}

function streamPayloadToBytes(payload) {
  if (!payload || typeof payload !== "object") return new Uint8Array();
  const bytesLen = Number(payload.bytes_len ?? 0);
  if (!Number.isFinite(bytesLen) || bytesLen < 0) throw new Error("invalid stream_payload.bytes_len");

  if (typeof payload.base64 === "string") {
    const bytes = base64ToBytes(payload.base64);
    if (bytes.length !== bytesLen) throw new Error("stream_payload.bytes_len mismatch (base64)");
    return bytes;
  }
  if (typeof payload.text === "string") {
    const bytes = textEncoder.encode(payload.text);
    if (bytes.length !== bytesLen) throw new Error("stream_payload.bytes_len mismatch (text)");
    return bytes;
  }
  if (bytesLen === 0) return new Uint8Array();
  throw new Error("stream_payload missing base64/text for non-empty body");
}

function bytesToStreamPayload(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const payload = { bytes_len: u8.length, base64: bytesToBase64(u8) };
  try {
    const txt = textDecoderStrict.decode(u8);
    payload.text = txt;
  } catch (_) {}
  return payload;
}

function parseHttpRequestEffect(effect) {
  if (!effect || typeof effect !== "object") return null;
  if (effect.v !== 1 || effect.kind !== "x07.web_ui.effect.http.request") return null;
  const req = effect.request;
  if (!req || typeof req !== "object") throw new Error("invalid http request effect.request");
  if (req.schema_version !== "x07.http.request.envelope@0.1.0") {
    throw new Error(`unsupported http request schema_version: ${String(req.schema_version ?? "")}`);
  }
  return req;
}

function parseStorageGetEffect(effect) {
  if (!effect || typeof effect !== "object") return null;
  if (effect.v !== 1 || effect.kind !== "x07.web_ui.effect.storage.get") return null;
  const key = effect.key;
  if (typeof key !== "string") throw new Error("invalid storage.get effect.key");
  return { key };
}

function parseStorageSetEffect(effect) {
  if (!effect || typeof effect !== "object") return null;
  if (effect.v !== 1 || effect.kind !== "x07.web_ui.effect.storage.set") return null;
  const key = effect.key;
  const value = effect.value;
  if (typeof key !== "string") throw new Error("invalid storage.set effect.key");
  if (typeof value !== "string") throw new Error("invalid storage.set effect.value (must be string)");
  return { key, value };
}

function parseNavPushEffect(effect) {
  if (!effect || typeof effect !== "object") return null;
  if (effect.v !== 1 || effect.kind !== "x07.web_ui.effect.nav.push") return null;
  const path = effect.path;
  if (typeof path !== "string") throw new Error("invalid nav.push effect.path");
  return { path };
}

function parseNavReplaceEffect(effect) {
  if (!effect || typeof effect !== "object") return null;
  if (effect.v !== 1 || effect.kind !== "x07.web_ui.effect.nav.replace") return null;
  const path = effect.path;
  if (typeof path !== "string") throw new Error("invalid nav.replace effect.path");
  return { path };
}

function parseTimerSetEffect(effect) {
  if (!effect || typeof effect !== "object") return null;
  if (effect.v !== 1 || effect.kind !== "x07.web_ui.effect.timer.set") return null;
  const id = effect.id;
  const delayMs = Number(effect.delay_ms ?? 0);
  if (typeof id !== "string") throw new Error("invalid timer.set effect.id");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("invalid timer.set effect.delay_ms");
  return { id, delayMs: Math.floor(delayMs) };
}

function parseTimerClearEffect(effect) {
  if (!effect || typeof effect !== "object") return null;
  if (effect.v !== 1 || effect.kind !== "x07.web_ui.effect.timer.clear") return null;
  const id = effect.id;
  if (typeof id !== "string") throw new Error("invalid timer.clear effect.id");
  return { id };
}

export async function mountWebUiApp({
  wasmUrl,
  componentEsmUrl,
  root,
  arenaCapBytes = 1 << 20,
  maxOutputBytes = 1 << 20,
  apiPrefix = null,
  appMeta = null,
  capabilities = null,
  policySnapshotSha256 = null,
} = {}) {
  if (!wasmUrl && !componentEsmUrl) throw new Error("missing wasmUrl/componentEsmUrl");
  if (!root) throw new Error("missing root");

  const trace = {
    v: 1,
    kind: "x07.web_ui.trace",
    steps: [],
    meta: {
      wasmUrl: wasmUrl || null,
      componentEsmUrl: componentEsmUrl || null,
      startedAtUnixMs: Date.now(),
      policySnapshotSha256:
        typeof policySnapshotSha256 === "string" && policySnapshotSha256 ? policySnapshotSha256 : null,
    },
  };

  const appTrace =
    apiPrefix != null
      ? {
          schema_version: "x07.app.trace@0.1.0",
          meta: {
            tool: { name: "x07-web-ui", version: "0.0.0" },
            app: appMeta && typeof appMeta === "object" ? appMeta : null,
            created_utc: new Date().toISOString(),
          },
          steps: [],
        }
      : null;

  const effectExchanges = [];
  const timers = new Map();

  let app = null;
  if (componentEsmUrl) {
    const m = await import(componentEsmUrl);
    if (!m || typeof m !== "object") throw new Error("invalid component ESM module");
    const init = m.init;
    const step = m.step;
    if (typeof init !== "function" || typeof step !== "function") {
      throw new Error("component ESM module must export init and step functions");
    }
    app = {
      kind: "component+esm",
      init: async () => {
        const out = await init();
        return out instanceof Uint8Array ? out : textEncoder.encode(String(out ?? ""));
      },
      step: async (inputBytes) => {
        const out = await step(inputBytes);
        return out instanceof Uint8Array ? out : textEncoder.encode(String(out ?? ""));
      },
    };
  } else {
    const { instance } = await instantiateCoreWasm(wasmUrl, {});
    const core = createSolveV2Core(instance.exports, { arenaCapBytes, maxOutputBytes });
    app = {
      kind: "core",
      init: async () => {
        const env = { v: 1, kind: "x07.web_ui.dispatch", state: null, event: { type: "init" } };
        const inputBytes = textEncoder.encode(JSON.stringify(env));
        return core.callSolveV2(inputBytes);
      },
      step: async (inputBytes) => core.callSolveV2(inputBytes),
    };
  }

  let state = null;
  let ui = null;
  let allowedEvents = new Map();

  function commitFrame(frame) {
    const nextState = frame?.state ?? null;
    const nextUi = frame?.ui ?? null;
    const patches = frame?.patches ?? [];

    if (ui != null) {
      const patched = applyJsonPatch(JSON.parse(stableJson(ui)), patches);
      const a = stableJson(patched);
      const b = stableJson(nextUi);
      if (a !== b) {
        throw new Error(`patchset does not match ui tree: patched!=ui`);
      }
    }

    state = nextState;
    const prevUi = ui;
    ui = nextUi;
    allowedEvents = new Map();
    if (ui && typeof ui === "object") buildAllowedEventsMap(ui.root, allowedEvents);
    render(root, prevUi, ui);
  }

  async function callReducer(env, initCall) {
    const inputBytes = textEncoder.encode(JSON.stringify(env));
    const started = performance.now();
    const outBytes = initCall ? await app.init() : await app.step(inputBytes);
    const wallMs = performance.now() - started;

    const frameText = textDecoder.decode(outBytes);
    const frame = JSON.parse(frameText);
    trace.steps.push({ env, frame, wallMs });
    return { frame, wallMs };
  }

  function recordEffectExchange(effect, injection) {
    effectExchanges.push({ i: effectExchanges.length, effect, injection });
  }

  function addInjectionDelta(delta, key, value) {
    if (!(key in delta)) {
      delta[key] = value;
      return;
    }
    const prev = delta[key];
    if (
      prev &&
      typeof prev === "object" &&
      !Array.isArray(prev) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      delta[key] = { ...prev, ...value };
      return;
    }
    throw new Error(`duplicate effect injection key: ${key}`);
  }

  function checkInjectionBudget(delta) {
    const n = textEncoder.encode(stableJson(delta)).length;
    if (n > MAX_EFFECT_INJECT_BYTES) {
      throw new Error(`effect injection too large: bytes=${n} max=${MAX_EFFECT_INJECT_BYTES}`);
    }
  }

  async function runEffectsLoop(event, env0, firstFrame, uiWallMs0) {
    let frame = firstFrame;
    let uiMs = uiWallMs0;
    let httpMs = 0;
    const exchanges = [];

    for (let i = 0; i < MAX_EFFECT_LOOPS; i++) {
      const effects = Array.isArray(frame?.effects) ? frame.effects : [];
      if (effects.length === 0) break;
      if (effects.length > MAX_EFFECTS_PER_STEP) {
        throw new Error(`too many effects: n=${effects.length} max=${MAX_EFFECTS_PER_STEP}`);
      }

      const delta = {};
      const injectedState = state && typeof state === "object" ? { ...state } : {};

      for (const eff of effects) {
        const req0 = parseHttpRequestEffect(eff);
        if (req0) {
          if (apiPrefix == null) throw new Error("http effects require apiPrefix");
          if (typeof req0.id !== "string" || !req0.id) {
            throw new Error("http request effect missing id");
          }
          if (typeof req0.path !== "string" || !req0.path) {
            throw new Error("http request effect missing path");
          }
          const execPath = joinUrlPath(apiPrefix, req0.path);
          const url =
            execPath +
            (typeof req0.query === "string" && req0.query ? `?${String(req0.query)}` : "");

          const reqEnv = {
            schema_version: "x07.http.request.envelope@0.1.0",
            id: String(req0.id ?? ""),
            method: String(req0.method ?? "GET"),
            path: execPath,
            query: typeof req0.query === "string" ? req0.query : "",
            headers: Array.isArray(req0.headers)
              ? req0.headers
                  .map((h) =>
                    h && typeof h === "object"
                      ? { k: String(h.k ?? ""), v: String(h.v ?? "") }
                      : null,
                  )
                  .filter((x) => x && x.k)
              : [],
            body: req0.body && typeof req0.body === "object" ? req0.body : { bytes_len: 0 },
          };

          const reqBodyBytes = streamPayloadToBytes(reqEnv.body);
          const reqHeaders = new Headers();
          for (const [k, v] of sortedHeaderPairsFromHeaders(reqEnv.headers)) {
            if (!k) continue;
            reqHeaders.set(k, v);
          }

          enforceFetchAllowed(capabilities, url);
          const startedHttp = performance.now();
          const resp = await fetch(url, {
            method: reqEnv.method,
            headers: reqHeaders,
            body: reqBodyBytes.length ? reqBodyBytes : undefined,
          });
          const respBuf = new Uint8Array(await resp.arrayBuffer());
          httpMs += performance.now() - startedHttp;

          if (respBuf.length > MAX_HTTP_BODY_BYTES) {
            throw new Error(
              `http response body too large: bytes=${respBuf.length} max=${MAX_HTTP_BODY_BYTES}`,
            );
          }

          const respHeadersPairs = sortedHeaderPairsFromHeaders(resp.headers).map(([k, v]) => ({
            k,
            v,
          }));
          const respEnv = {
            schema_version: "x07.http.response.envelope@0.1.0",
            request_id: reqEnv.id,
            status: resp.status,
            headers: respHeadersPairs,
            body: bytesToStreamPayload(respBuf),
          };

          exchanges.push({ request: reqEnv, response: respEnv });

          injectedState.__x07_http = { response: respEnv };
          addInjectionDelta(delta, "__x07_http", { response: respEnv });
          recordEffectExchange(eff, { __x07_http: { response: respEnv } });
          continue;
        }

        const storageGet = parseStorageGetEffect(eff);
        if (storageGet) {
          const raw = globalThis.localStorage?.getItem?.(storageGet.key) ?? null;
          const value = raw == null ? null : String(raw);
          const inj = { get: { key: storageGet.key, value } };
          const prev = injectedState.__x07_storage;
          injectedState.__x07_storage =
            prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev, ...inj } : inj;
          addInjectionDelta(delta, "__x07_storage", inj);
          recordEffectExchange(eff, { __x07_storage: inj });
          continue;
        }

        const storageSet = parseStorageSetEffect(eff);
        if (storageSet) {
          globalThis.localStorage?.setItem?.(storageSet.key, storageSet.value);
          const inj = { set: { key: storageSet.key, value: storageSet.value, ok: true } };
          const prev = injectedState.__x07_storage;
          injectedState.__x07_storage =
            prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev, ...inj } : inj;
          addInjectionDelta(delta, "__x07_storage", inj);
          recordEffectExchange(eff, { __x07_storage: inj });
          continue;
        }

        const navPush = parseNavPushEffect(eff);
        if (navPush) {
          globalThis.history?.pushState?.({}, "", navPush.path);
          const href = String(globalThis.location?.href ?? "");
          const inj = { op: "push", path: navPush.path, href };
          injectedState.__x07_nav = inj;
          addInjectionDelta(delta, "__x07_nav", inj);
          recordEffectExchange(eff, { __x07_nav: inj });
          continue;
        }

        const navReplace = parseNavReplaceEffect(eff);
        if (navReplace) {
          globalThis.history?.replaceState?.({}, "", navReplace.path);
          const href = String(globalThis.location?.href ?? "");
          const inj = { op: "replace", path: navReplace.path, href };
          injectedState.__x07_nav = inj;
          addInjectionDelta(delta, "__x07_nav", inj);
          recordEffectExchange(eff, { __x07_nav: inj });
          continue;
        }

        const timerSet = parseTimerSetEffect(eff);
        if (timerSet) {
          if (timers.has(timerSet.id)) {
            clearTimeout(timers.get(timerSet.id));
            timers.delete(timerSet.id);
          }
          const handle = setTimeout(() => {
            void dispatch({ type: "timer", id: timerSet.id }).catch((err) => console.error(err));
          }, timerSet.delayMs);
          timers.set(timerSet.id, handle);
          const inj = { set: { id: timerSet.id, delay_ms: timerSet.delayMs, ok: true } };
          const prev = injectedState.__x07_timer;
          injectedState.__x07_timer =
            prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev, ...inj } : inj;
          addInjectionDelta(delta, "__x07_timer", inj);
          recordEffectExchange(eff, { __x07_timer: inj });
          continue;
        }

        const timerClear = parseTimerClearEffect(eff);
        if (timerClear) {
          if (timers.has(timerClear.id)) {
            clearTimeout(timers.get(timerClear.id));
            timers.delete(timerClear.id);
          }
          const inj = { clear: { id: timerClear.id, ok: true } };
          const prev = injectedState.__x07_timer;
          injectedState.__x07_timer =
            prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev, ...inj } : inj;
          addInjectionDelta(delta, "__x07_timer", inj);
          recordEffectExchange(eff, { __x07_timer: inj });
          continue;
        }

        throw new Error(`unsupported effect: ${stableJson(eff)}`);
      }

      checkInjectionBudget(delta);

      const env = { v: 1, kind: "x07.web_ui.dispatch", state: injectedState, event };
      const out = await callReducer(env, false);
      uiMs += out.wallMs;
      frame = out.frame;
      commitFrame(frame);
    }

    if (appTrace) {
      const totalMs = uiMs + httpMs;
      appTrace.steps.push({
        i: appTrace.steps.length,
        ui_dispatch: env0,
        ui_frame: frame,
        http: exchanges,
        timing: {
          ui_ms: Math.round(uiMs),
          http_ms: Math.round(httpMs),
          total_ms: Math.round(totalMs),
        },
      });
    }

    return frame;
  }

  async function dispatch(event) {
    const env0 = { v: 1, kind: "x07.web_ui.dispatch", state, event };
    const out = await callReducer(env0, false);
    commitFrame(out.frame);
    return runEffectsLoop(event, env0, out.frame, out.wallMs);
  }

  try {
    const event = { type: "init" };
    const env0 = { v: 1, kind: "x07.web_ui.dispatch", state: null, event };
    const out = await callReducer(env0, true);
    commitFrame(out.frame);
    await runEffectsLoop(event, env0, out.frame, out.wallMs);
  } catch (err) {
    const incident = {
      v: 1,
      kind: "x07.web_ui.incident",
      error: String(err?.stack || err),
      policySnapshotSha256:
        typeof policySnapshotSha256 === "string" && policySnapshotSha256 ? policySnapshotSha256 : null,
      trace,
      effectExchanges,
      appTrace,
    };
    console.error(err);
    downloadJson("incident.json", incident);
    throw err;
  }

  root.addEventListener(
    "click",
    (ev) => {
      const el = ev?.target?.closest?.("[data-x07-key]");
      const target = el?.dataset?.x07Key || "";
      if (!target) return;
      if (!(allowedEvents.get(target)?.has("click") ?? false)) return;
      ev.preventDefault();
      void dispatch({ type: "click", target }).catch((err) => console.error(err));
    },
    true,
  );
  root.addEventListener(
    "input",
    (ev) => {
      const el = ev?.target?.closest?.("[data-x07-key]");
      const target = el?.dataset?.x07Key || "";
      if (!target) return;
      if (!(allowedEvents.get(target)?.has("input") ?? false)) return;
      const value = ev?.target?.value ?? "";
      void dispatch({ type: "input", target, value: String(value) }).catch((err) =>
        console.error(err),
      );
    },
    true,
  );
  root.addEventListener(
    "change",
    (ev) => {
      const el = ev?.target?.closest?.("[data-x07-key]");
      const target = el?.dataset?.x07Key || "";
      if (!target) return;
      if (!(allowedEvents.get(target)?.has("change") ?? false)) return;
      const value = ev?.target?.value ?? "";
      void dispatch({ type: "change", target, value: String(value) }).catch((err) =>
        console.error(err),
      );
    },
    true,
  );
  root.addEventListener(
    "submit",
    (ev) => {
      const el = ev?.target?.closest?.("[data-x07-key]");
      const target = el?.dataset?.x07Key || "";
      if (!target) return;
      if (!(allowedEvents.get(target)?.has("submit") ?? false)) return;
      ev.preventDefault();
      void dispatch({ type: "submit", target }).catch((err) => console.error(err));
    },
    true,
  );

  return {
    dispatch,
    getState: () => state,
    getUi: () => ui,
    trace,
    appTrace,
    downloadTrace: () => downloadJson("trace.json", trace),
    downloadAppTrace: () => (appTrace ? downloadJson("app.trace.json", appTrace) : null),
  };
}
