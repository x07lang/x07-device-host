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

function sanitizeTelemetryValue(raw) {
  if (raw == null) return null;
  const t = typeof raw;
  if (t === "string" || t === "boolean") return raw;
  if (t === "number") return Number.isFinite(raw) ? raw : null;
  if (Array.isArray(raw)) return stableJson(raw);
  if (t === "object") return stableJson(raw);
  return String(raw);
}

function collectTelemetryAttributes(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k) continue;
    const clean = sanitizeTelemetryValue(v);
    if (clean == null) continue;
    out[k] = clean;
  }
  return out;
}

function otlpSeverity(raw) {
  const severity = String(raw ?? "info").toLowerCase();
  switch (severity) {
    case "trace":
      return { number: 1, text: "TRACE" };
    case "debug":
      return { number: 5, text: "DEBUG" };
    case "warn":
    case "warning":
      return { number: 13, text: "WARN" };
    case "error":
      return { number: 17, text: "ERROR" };
    case "fatal":
      return { number: 21, text: "FATAL" };
    default:
      return { number: 9, text: "INFO" };
  }
}

function otlpAnyValuePayload(raw) {
  if (raw == null) return { stringValue: "" };
  if (typeof raw === "string") return { stringValue: raw };
  if (typeof raw === "boolean") return { boolValue: raw };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { stringValue: String(raw) };
    if (Number.isInteger(raw)) return { intValue: String(raw) };
    return { doubleValue: raw };
  }
  return { stringValue: stableJson(raw) };
}

function otlpAttributeItems(raw) {
  const attrs = collectTelemetryAttributes(raw);
  return Object.entries(attrs).map(([key, value]) => ({
    key,
    value: otlpAnyValuePayload(value),
  }));
}

function encodeProtoTag(fieldNumber, wireType) {
  return encodeProtoVarint((fieldNumber << 3) | wireType);
}

function encodeProtoVarint(raw) {
  let value = typeof raw === "bigint" ? raw : BigInt(raw >>> 0 === raw ? raw : Math.trunc(raw));
  if (value < 0n) {
    value = BigInt.asUintN(64, value);
  }
  const out = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value !== 0n) byte |= 0x80;
    out.push(byte);
  } while (value !== 0n);
  return Uint8Array.from(out);
}

function encodeProtoLengthDelimited(fieldNumber, payload) {
  return concatProtoBytes([
    encodeProtoTag(fieldNumber, 2),
    encodeProtoVarint(payload.length),
    payload,
  ]);
}

function encodeProtoString(fieldNumber, value) {
  return encodeProtoLengthDelimited(fieldNumber, textEncoder.encode(String(value ?? "")));
}

function encodeProtoFixed64(fieldNumber, value) {
  const out = new Uint8Array(1 + 8 + 9);
  const tag = encodeProtoTag(fieldNumber, 1);
  out.set(tag, 0);
  let cursor = tag.length;
  let current = typeof value === "bigint" ? value : BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    out[cursor + i] = Number(current & 0xffn);
    current >>= 8n;
  }
  return out.slice(0, cursor + 8);
}

function encodeProtoDouble(fieldNumber, value) {
  const tag = encodeProtoTag(fieldNumber, 1);
  const bytes = new Uint8Array(tag.length + 8);
  bytes.set(tag, 0);
  const view = new DataView(bytes.buffer, tag.length, 8);
  view.setFloat64(0, Number(value ?? 0), true);
  return bytes;
}

function concatProtoBytes(parts) {
  const items = Array.isArray(parts) ? parts : [];
  const total = items.reduce((sum, item) => sum + (item?.length ?? 0), 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const item of items) {
    if (!item || !item.length) continue;
    out.set(item, cursor);
    cursor += item.length;
  }
  return out;
}

function encodeProtoAnyValue(raw) {
  if (raw == null) return encodeProtoString(1, "");
  if (typeof raw === "string") return encodeProtoString(1, raw);
  if (typeof raw === "boolean") {
    return concatProtoBytes([encodeProtoTag(2, 0), encodeProtoVarint(raw ? 1 : 0)]);
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return encodeProtoString(1, String(raw));
    if (Number.isInteger(raw)) {
      return concatProtoBytes([encodeProtoTag(3, 0), encodeProtoVarint(BigInt(raw))]);
    }
    return encodeProtoDouble(4, raw);
  }
  return encodeProtoString(1, stableJson(raw));
}

function encodeProtoKeyValue(key, value) {
  return concatProtoBytes([
    encodeProtoString(1, key),
    encodeProtoLengthDelimited(2, encodeProtoAnyValue(value)),
  ]);
}

function encodeProtoAttributes(raw) {
  return otlpAttributeItems(raw).map((item) =>
    encodeProtoLengthDelimited(1, encodeProtoKeyValue(item.key, item.value.stringValue ?? item.value.boolValue ?? item.value.intValue ?? item.value.doubleValue ?? ""))
  );
}

function encodeProtoInstrumentationScope(name, version) {
  return concatProtoBytes([encodeProtoString(1, name), encodeProtoString(2, version)]);
}

function logRecordBody(rawBody, name) {
  const body = typeof rawBody === "string" && rawBody ? rawBody : String(name ?? "");
  return body || "event";
}

function timeUnixNanoBigInt(timeUnixMs) {
  const millis = Number.isFinite(Number(timeUnixMs)) ? Math.trunc(Number(timeUnixMs)) : Date.now();
  return BigInt(millis) * 1000000n;
}

function buildOtlpLogWire(resource, event, scopeName, scopeVersion) {
  const severity = otlpSeverity(event?.severity ?? "info");
  const body = logRecordBody(event?.body, event?.name);
  const eventAttributes = {
    "x07.event.class": String(event?.class ?? ""),
    "x07.event.name": String(event?.name ?? ""),
    ...(event?.attributes && typeof event.attributes === "object" ? event.attributes : {}),
  };
  const timeUnixNano = timeUnixNanoBigInt(event?.time_unix_ms ?? Date.now());
  const jsonPayload = {
    resourceLogs: [
      {
        resource: {
          attributes: otlpAttributeItems(resource),
        },
        scopeLogs: [
          {
            scope: {
              name: scopeName,
              version: scopeVersion,
            },
            logRecords: [
              {
                timeUnixNano: timeUnixNano.toString(),
                severityNumber: severity.number,
                severityText: severity.text,
                body: otlpAnyValuePayload(body),
                attributes: otlpAttributeItems(eventAttributes),
              },
            ],
          },
        ],
      },
    ],
  };

  const resourceMessage = concatProtoBytes(encodeProtoAttributes(resource));
  const logRecordMessage = concatProtoBytes([
    encodeProtoFixed64(1, timeUnixNano),
    encodeProtoLengthDelimited(5, encodeProtoAnyValue(body)),
    concatProtoBytes([encodeProtoTag(6, 0), encodeProtoVarint(severity.number)]),
    encodeProtoString(7, severity.text),
    ...otlpAttributeItems(eventAttributes).map((item) =>
      encodeProtoLengthDelimited(8, encodeProtoKeyValue(item.key, item.value.stringValue ?? item.value.boolValue ?? item.value.intValue ?? item.value.doubleValue ?? ""))
    ),
  ]);
  const scopeLogsMessage = concatProtoBytes([
    encodeProtoLengthDelimited(1, encodeProtoInstrumentationScope(scopeName, scopeVersion)),
    encodeProtoLengthDelimited(2, logRecordMessage),
  ]);
  const resourceLogsMessage = concatProtoBytes([
    encodeProtoLengthDelimited(1, resourceMessage),
    encodeProtoLengthDelimited(2, scopeLogsMessage),
  ]);
  const protobufPayload = encodeProtoLengthDelimited(1, resourceLogsMessage);
  return {
    json: jsonPayload,
    protobuf_b64: globalThis.btoa
      ? globalThis.btoa(String.fromCharCode(...protobufPayload))
      : null,
  };
}

export function createDeviceTelemetryRuntime({
  postIpc,
  telemetryProfile = null,
  bundleManifest = null,
  deviceProfile = null,
} = {}) {
  const noop = {
    configure() {},
    emit() {},
    getResource: () => ({}),
  };

  if (!postIpc || typeof postIpc !== "function") return noop;
  if (!telemetryProfile || typeof telemetryProfile !== "object") return noop;

  const transport = telemetryProfile.transport;
  if (!transport || typeof transport !== "object") return noop;
  const protocol = String(transport.protocol ?? "");
  const endpoint = String(transport.endpoint ?? "");
  if ((protocol !== "http/json" && protocol !== "http/protobuf") || !/^https?:\/\//.test(endpoint)) {
    return noop;
  }

  const allowed = new Set(
    (Array.isArray(telemetryProfile.event_classes) ? telemetryProfile.event_classes : [])
      .map((name) => String(name ?? ""))
      .filter(Boolean),
  );
  if (allowed.size === 0) return noop;

  const profileResource =
    telemetryProfile.resource && typeof telemetryProfile.resource === "object"
      ? telemetryProfile.resource
      : {};
  const resource = collectTelemetryAttributes({
    "x07.app_id": profileResource.app_id ?? deviceProfile?.identity?.app_id ?? null,
    "x07.target": profileResource.target ?? bundleManifest?.target ?? deviceProfile?.target ?? null,
    "x07.release.exec_id": profileResource.release_exec_id ?? null,
    "x07.release.plan_id": profileResource.release_plan_id ?? null,
    "x07.package.sha256": profileResource.package_sha256 ?? bundleManifest?.bundle_digest ?? null,
    "x07.provider.kind": profileResource.provider_kind ?? null,
    "x07.provider.lane": profileResource.provider_lane ?? null,
    "x07.rollout.percent": profileResource.rollout_percent ?? null,
  });
  let configured = false;
  const scopeName = "x07-device-host-webview";
  const scopeVersion = "0.1.7";

  function configure() {
    if (configured) return;
    configured = true;
    postIpc({
      v: 1,
      kind: "x07.device.telemetry.configure",
      transport: { protocol, endpoint },
      resource,
      event_classes: Array.from(allowed.values()),
    });
  }

  function emit(eventClass, name, attributes = {}, options = {}) {
    if (!allowed.has(String(eventClass ?? ""))) return;
    configure();
    const event = {
      class: String(eventClass ?? ""),
      name: String(name ?? ""),
      severity: String(options.severity ?? "info"),
      time_unix_ms: Date.now(),
      body: typeof options.body === "string" ? options.body : null,
      attributes: collectTelemetryAttributes(attributes),
    };
    postIpc({
      v: 1,
      kind: "x07.device.telemetry.event",
      transport: { protocol, endpoint },
      resource,
      event,
      wire: buildOtlpLogWire(resource, event, scopeName, scopeVersion),
    });
  }

  return {
    configure,
    emit,
    getResource: () => ({ ...resource }),
  };
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
  parseAnyDeviceEffect,
  normalizeDeviceResult,
  normalizeDeviceHostEvent,
  capabilityAllowed,
  mkDeviceResult,
  createBrowserNativeHost,
  normalizeDeviceFileItem,
  streamPayloadToBytes,
  bytesToStreamPayload,
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
  const payload = { bytes_len: u8.length };
  try {
    payload.text = textDecoderStrict.decode(u8);
    return payload;
  } catch (_) {}
  payload.base64 = bytesToBase64(u8);
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

const DEVICE_RESULT_STATUSES = new Set([
  "ok",
  "denied",
  "cancelled",
  "unsupported",
  "timeout",
  "error",
]);

function bytesToHex(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let out = "";
  for (const b of u8) out += b.toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error("crypto.subtle is unavailable");
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", u8);
  return bytesToHex(new Uint8Array(digest));
}

function parseJsonMaybe(raw) {
  if (typeof raw === "string") return JSON.parse(raw);
  return raw;
}

function deviceHostMeta(platform) {
  return {
    platform: String(platform || "unknown"),
    host_mode:
      Boolean(globalThis.ipc && typeof globalThis.ipc.postMessage === "function") ? "device" : "web",
  };
}

function mapPermissionToCapability(permission) {
  switch (String(permission || "")) {
    case "camera":
      return "camera.photo";
    case "location_foreground":
      return "location.foreground";
    case "notifications":
      return "notifications.local";
    default:
      return "";
  }
}

function capabilityAllowed(capabilities, capability) {
  const device = capabilities?.device;
  switch (String(capability || "")) {
    case "camera.photo":
      return device?.camera?.photo === true;
    case "audio.playback":
      return device?.audio?.playback === true;
    case "haptics.present":
      return device?.haptics?.present === true;
    case "clipboard.read_text":
      return device?.clipboard?.read_text === true;
    case "clipboard.write_text":
      return device?.clipboard?.write_text === true;
    case "files.pick":
      return device?.files?.pick === true || device?.files?.pick_multiple === true;
    case "files.pick_multiple":
      return device?.files?.pick_multiple === true || device?.files?.pick === true;
    case "files.save":
      return device?.files?.save === true;
    case "files.drop":
      return device?.files?.drop === true;
    case "blob_store":
      return device?.blob_store?.enabled === true;
    case "location.foreground":
      return device?.location?.foreground === true;
    case "notifications.local":
      return device?.notifications?.local === true;
    case "share.present":
      return device?.share?.present === true;
    default:
      return false;
  }
}

function buildShareClipboardText(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const parts = [];
  if (typeof data.title === "string" && data.title.trim() !== "") {
    parts.push(data.title.trim());
  }
  if (typeof data.text === "string" && data.text.trim() !== "") {
    parts.push(data.text.trim());
  }
  if (typeof data.url === "string" && data.url.trim() !== "") {
    parts.push(data.url.trim());
  }
  return parts.join("\n\n");
}

function copyTextViaExecCommand(text) {
  const doc = globalThis.document;
  if (!doc?.createElement || !doc?.body || typeof doc.execCommand !== "function") {
    return false;
  }
  const textarea = doc.createElement("textarea");
  textarea.value = String(text ?? "");
  textarea.setAttribute("readonly", "readonly");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  textarea.style.opacity = "0";
  doc.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange?.(0, textarea.value.length);
    return doc.execCommand("copy") === true;
  } catch (_) {
    return false;
  } finally {
    textarea.remove();
  }
}

async function fallbackShareToClipboard(request, payload, hostMeta) {
  const text = buildShareClipboardText(payload);
  if (!text) {
    return { family: request.family, result: mkDeviceResult(request, "unsupported", {}, hostMeta) };
  }
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return {
        family: request.family,
        result: mkDeviceResult(
          request,
          "ok",
          { delivered_via: "clipboard", text_len: text.length },
          hostMeta,
        ),
      };
    } catch (_) {}
  }
  if (copyTextViaExecCommand(text)) {
    return {
      family: request.family,
      result: mkDeviceResult(
        request,
        "ok",
        { delivered_via: "exec_command", text_len: text.length },
        hostMeta,
      ),
    };
  }
  return {
    family: request.family,
    result: mkDeviceResult(request, "denied", {}, hostMeta),
  };
}

function blobQuotaConfig(capabilities) {
  const cfg = capabilities?.device?.blob_store;
  return {
    maxTotalBytes: Number(cfg?.max_total_bytes ?? 64 * 1024 * 1024),
    maxItemBytes: Number(cfg?.max_item_bytes ?? 16 * 1024 * 1024),
  };
}

function mkDeviceResult(request, status, payload = {}, hostMeta = {}) {
  const nextStatus = DEVICE_RESULT_STATUSES.has(String(status || "")) ? String(status) : "error";
  return {
    request_id: String(request?.request_id ?? ""),
    op: String(request?.op ?? ""),
    capability: String(request?.capability ?? ""),
    status: nextStatus,
    payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {},
    host_meta: hostMeta && typeof hostMeta === "object" ? hostMeta : {},
  };
}

function normalizeDeviceResult(request, raw, family, platform) {
  const doc = raw && typeof raw === "object" ? raw : {};
  const payload = normalizeDevicePayload(
    String(doc.family || family || request?.family || ""),
    doc.payload && typeof doc.payload === "object" && !Array.isArray(doc.payload) ? doc.payload : {},
  );
  return {
    family: String(doc.family || family || request?.family || ""),
    result: mkDeviceResult(request, doc.status, payload, {
      ...deviceHostMeta(platform),
      ...(doc.host_meta && typeof doc.host_meta === "object" ? doc.host_meta : {}),
    }),
  };
}

function buildMissingBlobManifest(handle, source = "blob_store") {
  return {
    handle: String(handle || ""),
    sha256: "",
    mime: "application/octet-stream",
    byte_size: 0,
    created_at_ms: 0,
    source: String(source || "blob_store"),
    local_state: "missing",
  };
}

function normalizeBlobManifest(raw, fallbackSource = "files") {
  const doc = raw && typeof raw === "object" ? raw : {};
  return {
    handle: String(doc.handle || ""),
    sha256: typeof doc.sha256 === "string" ? doc.sha256 : "",
    mime: String(doc.mime || "application/octet-stream"),
    byte_size: Number.isFinite(Number(doc.byte_size)) ? Math.max(0, Math.floor(Number(doc.byte_size))) : 0,
    created_at_ms:
      Number.isFinite(Number(doc.created_at_ms)) ? Math.max(0, Math.floor(Number(doc.created_at_ms))) : 0,
    source: String(doc.source || fallbackSource || "files"),
    local_state: typeof doc.local_state === "string" && doc.local_state ? doc.local_state : "present",
  };
}

function normalizeDeviceFileItem(raw, fallbackSource = "files") {
  const doc = raw && typeof raw === "object" ? raw : {};
  const looksLikeBlob = typeof doc.handle === "string" && doc.handle.length > 0;
  const blob =
    doc.blob && typeof doc.blob === "object"
      ? normalizeBlobManifest(doc.blob, fallbackSource)
      : looksLikeBlob
        ? normalizeBlobManifest(doc, fallbackSource)
        : null;
  const item = {
    name: typeof doc.name === "string" ? doc.name : "",
    mime: String(doc.mime || blob?.mime || "application/octet-stream"),
    byte_size:
      Number.isFinite(Number(doc.byte_size)) && Number(doc.byte_size) >= 0
        ? Math.floor(Number(doc.byte_size))
        : Number(blob?.byte_size ?? 0),
  };
  if (Number.isFinite(Number(doc.last_modified_ms))) {
    item.last_modified_ms = Math.max(0, Math.floor(Number(doc.last_modified_ms)));
  }
  if (blob) item.blob = blob;
  return item;
}

function normalizeDeviceFileItems(rawItems, fallbackSource = "files") {
  const items = Array.isArray(rawItems) ? rawItems : [];
  return items
    .map((item) => normalizeDeviceFileItem(item, fallbackSource))
    .filter((item) => item.name || item.blob);
}

function normalizeDevicePayload(family, rawPayload) {
  const payload =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload) ? { ...rawPayload } : {};
  if (family !== "files") {
    return payload;
  }
  if (!Array.isArray(payload.items) && !Array.isArray(payload.blobs)) {
    return payload;
  }
  const rawItems = Array.isArray(payload.items) ? payload.items : payload.blobs;
  const items = normalizeDeviceFileItems(rawItems, String(payload.source || "files"));
  payload.items = items;
  payload.blobs = items.map((item) => item.blob).filter(Boolean);
  return payload;
}

function normalizePermissionState(raw) {
  switch (String(raw || "")) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    case "prompt":
    case "default":
      return "prompt";
    case "restricted":
      return "restricted";
    default:
      return "unsupported";
  }
}

function normalizeDeviceHostEvent(raw) {
  const doc = raw && typeof raw === "object" ? raw : {};
  const type = String(doc.type ?? "");
  if (!type) throw new Error("device host event missing type");
  if (type !== "files.drop") {
    return { ...doc, type };
  }
  const rawItems = Array.isArray(doc.items) ? doc.items : Array.isArray(doc.blobs) ? doc.blobs : [];
  const target = typeof doc.target === "string" ? doc.target : "";
  return {
    type,
    target,
    items: normalizeDeviceFileItems(rawItems, "files.drop"),
  };
}

function parseCommonDeviceRequest(effect, expectedKind, family, expectedOp, fallbackCapability = "") {
  if (!effect || typeof effect !== "object") return null;
  if (effect.v !== 1 || effect.kind !== expectedKind) return null;
  const requestId = effect.request_id;
  const op = typeof effect.op === "string" && effect.op ? effect.op : expectedOp;
  const capability =
    typeof effect.capability === "string" && effect.capability
      ? effect.capability
      : fallbackCapability;
  const payload = effect.payload && typeof effect.payload === "object" && !Array.isArray(effect.payload)
    ? effect.payload
    : {};
  if (typeof requestId !== "string" || !requestId) {
    throw new Error(`invalid ${expectedKind} request_id`);
  }
  if (op !== expectedOp) {
    throw new Error(`invalid ${expectedKind} op`);
  }
  if (typeof capability !== "string" || !capability) {
    throw new Error(`invalid ${expectedKind} capability`);
  }
  return { family, kind: expectedKind, request_id: requestId, op, capability, payload };
}

function parseDevicePermissionsEffect(effect) {
  const query = parseCommonDeviceRequest(
    effect,
    "x07.web_ui.effect.device.permissions.query",
    "permissions",
    "permissions.query",
    "",
  );
  if (query) {
    const permission = typeof query.payload.permission === "string" ? query.payload.permission : query.capability;
    if (!permission) throw new Error("permissions.query missing payload.permission");
    query.capability = mapPermissionToCapability(permission);
    query.payload = { permission };
    return query;
  }
  const request = parseCommonDeviceRequest(
    effect,
    "x07.web_ui.effect.device.permissions.request",
    "permissions",
    "permissions.request",
    "",
  );
  if (!request) return null;
  const permission = typeof request.payload.permission === "string" ? request.payload.permission : request.capability;
  if (!permission) throw new Error("permissions.request missing payload.permission");
  request.capability = mapPermissionToCapability(permission);
  request.payload = { permission };
  return request;
}

function parseDeviceCameraEffect(effect) {
  return parseCommonDeviceRequest(
    effect,
    "x07.web_ui.effect.device.camera.capture",
    "camera",
    "camera.capture",
    "camera.photo",
  );
}

function parseDeviceAudioEffect(effect) {
  return (
    parseCommonDeviceRequest(
      effect,
      "x07.web_ui.effect.device.audio.play",
      "audio",
      "audio.play",
      "audio.playback",
    ) ||
    parseCommonDeviceRequest(
      effect,
      "x07.web_ui.effect.device.audio.stop",
      "audio",
      "audio.stop",
      "audio.playback",
    )
  );
}

function parseDeviceHapticsEffect(effect) {
  return parseCommonDeviceRequest(
    effect,
    "x07.web_ui.effect.device.haptics.trigger",
    "haptics",
    "haptics.trigger",
    "haptics.present",
  );
}

function parseDeviceClipboardEffect(effect) {
  return (
    parseCommonDeviceRequest(
      effect,
      "x07.web_ui.effect.device.clipboard.copy_text",
      "clipboard",
      "clipboard.write_text",
      "clipboard.write_text",
    ) ||
    parseCommonDeviceRequest(
      effect,
      "x07.web_ui.effect.device.clipboard.read_text",
      "clipboard",
      "clipboard.read_text",
      "clipboard.read_text",
    )
  );
}

function parseDeviceFilesEffect(effect) {
  const pick = parseCommonDeviceRequest(
    effect,
    "x07.web_ui.effect.device.files.pick",
    "files",
    "files.pick",
    "files.pick",
  );
  if (pick) {
    pick.capability = pick.payload?.multiple === true ? "files.pick_multiple" : "files.pick";
    return pick;
  }
  return (
    parseCommonDeviceRequest(
      effect,
      "x07.web_ui.effect.device.files.save_text",
      "files",
      "files.save",
      "files.save",
    ) ||
    parseCommonDeviceRequest(
      effect,
      "x07.web_ui.effect.device.files.save_json",
      "files",
      "files.save",
      "files.save",
    )
  );
}

function parseDeviceShareEffect(effect) {
  return (
    parseCommonDeviceRequest(
      effect,
      "x07.web_ui.effect.device.share.share_text",
      "share",
      "share.present",
      "share.present",
    ) ||
    parseCommonDeviceRequest(
      effect,
      "x07.web_ui.effect.device.share.share_files",
      "share",
      "share.present",
      "share.present",
    )
  );
}

function parseDeviceBlobsStatEffect(effect) {
  return parseCommonDeviceRequest(
    effect,
    "x07.web_ui.effect.device.blobs.stat",
    "blobs",
    "blobs.stat",
    "blob_store",
  );
}

function parseDeviceBlobsDeleteEffect(effect) {
  return parseCommonDeviceRequest(
    effect,
    "x07.web_ui.effect.device.blobs.delete",
    "blobs",
    "blobs.delete",
    "blob_store",
  );
}

function parseDeviceLocationEffect(effect) {
  return parseCommonDeviceRequest(
    effect,
    "x07.web_ui.effect.device.location.get_current",
    "location",
    "location.get_current",
    "location.foreground",
  );
}

function parseDeviceNotificationsScheduleEffect(effect) {
  return parseCommonDeviceRequest(
    effect,
    "x07.web_ui.effect.device.notifications.schedule",
    "notifications",
    "notifications.schedule",
    "notifications.local",
  );
}

function parseDeviceNotificationsCancelEffect(effect) {
  return parseCommonDeviceRequest(
    effect,
    "x07.web_ui.effect.device.notifications.cancel",
    "notifications",
    "notifications.cancel",
    "notifications.local",
  );
}

function parseAnyDeviceEffect(effect) {
  return (
    parseDevicePermissionsEffect(effect) ||
    parseDeviceCameraEffect(effect) ||
    parseDeviceAudioEffect(effect) ||
    parseDeviceHapticsEffect(effect) ||
    parseDeviceClipboardEffect(effect) ||
    parseDeviceFilesEffect(effect) ||
    parseDeviceBlobsStatEffect(effect) ||
    parseDeviceBlobsDeleteEffect(effect) ||
    parseDeviceLocationEffect(effect) ||
    parseDeviceNotificationsScheduleEffect(effect) ||
    parseDeviceNotificationsCancelEffect(effect) ||
    parseDeviceShareEffect(effect)
  );
}

function mergeShallowObject(base, patch) {
  if (base && typeof base === "object" && !Array.isArray(base)) {
    return { ...base, ...patch };
  }
  return { ...patch };
}

function createInMemoryBlobStore(capabilities) {
  const items = new Map();
  const quotas = blobQuotaConfig(capabilities);
  let totalBytes = 0;

  return {
    async put(bytes, { mime = "application/octet-stream", source = "files", image = null } = {}) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      if (u8.length > quotas.maxItemBytes) {
        const err = new Error("blob item exceeds max_item_bytes");
        err.code = "blob_item_too_large";
        throw err;
      }
      const sha256 = await sha256Hex(u8);
      const handle = `blob:sha256:${sha256}`;
      if (items.has(handle)) {
        return items.get(handle).manifest;
      }
      if (totalBytes + u8.length > quotas.maxTotalBytes) {
        const err = new Error("blob store exceeds max_total_bytes");
        err.code = "blob_total_too_large";
        throw err;
      }
      const manifest = {
        handle,
        sha256,
        mime: String(mime || "application/octet-stream"),
        byte_size: u8.length,
        created_at_ms: Date.now(),
        source: String(source || "files"),
        local_state: "present",
      };
      items.set(handle, { manifest, bytes: u8, image });
      totalBytes += u8.length;
      return manifest;
    },
    get(handle) {
      return items.get(String(handle || "")) || null;
    },
    stat(handle) {
      const item = items.get(String(handle || ""));
      return item ? item.manifest : buildMissingBlobManifest(handle);
    },
    delete(handle) {
      const key = String(handle || "");
      const item = items.get(key);
      if (!item) {
        return { ...buildMissingBlobManifest(handle), local_state: "missing" };
      }
      items.delete(key);
      totalBytes -= item.bytes.length;
      return { ...item.manifest, local_state: "deleted" };
    },
  };
}

const AUDIO_CUES = {
  select: { type: "triangle", notes: [880], durationMs: 70, stepMs: 0, gain: 0.035 },
  move: { type: "triangle", notes: [660, 880], durationMs: 70, stepMs: 65, gain: 0.032 },
  confirm: { type: "triangle", notes: [740, 988], durationMs: 90, stepMs: 80, gain: 0.034 },
  attack: { type: "square", notes: [220, 196, 174], durationMs: 95, stepMs: 45, gain: 0.038 },
  victory: { type: "triangle", notes: [523.25, 659.25, 783.99], durationMs: 180, stepMs: 120, gain: 0.03 },
  defeat: { type: "sawtooth", notes: [330, 262, 196], durationMs: 200, stepMs: 140, gain: 0.026 },
  music_loop: { type: "sine", notes: [196], durationMs: 0, stepMs: 0, gain: 0.018 },
};

const HAPTIC_PATTERNS = {
  selection: [10],
  impact: [25],
  victory: [18, 36, 18],
  defeat: [45, 24, 55],
};

function audioCueSpec(cue) {
  return AUDIO_CUES[String(cue || "")] || null;
}

function hapticPatternSpec(pattern) {
  return HAPTIC_PATTERNS[String(pattern || "")] || null;
}

function makeAudioCleanup(entry) {
  return () => {
    for (const timeoutHandle of entry.timeouts) clearTimeout(timeoutHandle);
    entry.timeouts.length = 0;
    for (const oscillator of entry.oscillators) {
      try {
        oscillator.stop?.();
      } catch (_) {
        // ignore stop races when the voice already ended
      }
      try {
        oscillator.disconnect?.();
      } catch (_) {
        // ignore disconnect failures from test doubles or ended nodes
      }
    }
    entry.oscillators.length = 0;
    for (const gainNode of entry.gains) {
      try {
        gainNode.disconnect?.();
      } catch (_) {
        // ignore disconnect failures from test doubles or ended nodes
      }
    }
    entry.gains.length = 0;
  };
}

function createBrowserAudioRuntime() {
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioContextCtor !== "function") {
    return {
      async play() {
        return { status: "unsupported", payload: {} };
      },
      async stop(channel) {
        return { status: "unsupported", payload: { channel: String(channel || "") } };
      },
    };
  }
  let ctx = null;
  const channels = new Map();

  function ensureCtx() {
    if (!ctx) ctx = new AudioContextCtor();
    return ctx;
  }

  function clearChannel(channel) {
    const key = String(channel || "");
    const entry = channels.get(key);
    if (!entry) return;
    entry.cleanup();
    channels.delete(key);
  }

  function scheduleOneShot(channel, spec) {
    const audioCtx = ensureCtx();
    const startedAt = Number(audioCtx.currentTime || 0) + 0.01;
    const entry = {
      oscillators: [],
      gains: [],
      timeouts: [],
      cleanup() {},
    };
    entry.cleanup = makeAudioCleanup(entry);
    clearChannel(channel);
    channels.set(String(channel || ""), entry);
    const notes = Array.isArray(spec.notes) ? spec.notes : [];
    const durationSeconds = Math.max(0.04, Number(spec.durationMs || 0) / 1000);
    const stepSeconds = Math.max(0, Number(spec.stepMs || 0) / 1000);
    for (let i = 0; i < notes.length; i += 1) {
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      osc.type = String(spec.type || "sine");
      if (osc.frequency?.setValueAtTime) {
        osc.frequency.setValueAtTime(Number(notes[i] || 440), startedAt + stepSeconds * i);
      } else {
        osc.frequency.value = Number(notes[i] || 440);
      }
      const peakGain = Number(spec.gain || 0.02);
      gainNode.gain?.setValueAtTime?.(0.0001, startedAt + stepSeconds * i);
      gainNode.gain?.linearRampToValueAtTime?.(peakGain, startedAt + stepSeconds * i + 0.01);
      gainNode.gain?.exponentialRampToValueAtTime?.(
        0.0001,
        startedAt + stepSeconds * i + durationSeconds,
      );
      osc.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      osc.start(startedAt + stepSeconds * i);
      osc.stop(startedAt + stepSeconds * i + durationSeconds);
      entry.oscillators.push(osc);
      entry.gains.push(gainNode);
    }
    const totalMs =
      Math.max(1, notes.length) * Number(spec.stepMs || 0) + Number(spec.durationMs || 0) + 60;
    entry.timeouts.push(
      setTimeout(() => {
        clearChannel(channel);
      }, Math.max(120, totalMs)),
    );
  }

  function scheduleLoop(channel, spec) {
    const audioCtx = ensureCtx();
    const startedAt = Number(audioCtx.currentTime || 0) + 0.01;
    const entry = {
      oscillators: [],
      gains: [],
      timeouts: [],
      cleanup() {},
    };
    entry.cleanup = makeAudioCleanup(entry);
    clearChannel(channel);
    channels.set(String(channel || ""), entry);
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.type = String(spec.type || "sine");
    if (osc.frequency?.setValueAtTime) {
      osc.frequency.setValueAtTime(Number(spec.notes?.[0] || 196), startedAt);
    } else {
      osc.frequency.value = Number(spec.notes?.[0] || 196);
    }
    gainNode.gain?.setValueAtTime?.(0.0001, startedAt);
    gainNode.gain?.linearRampToValueAtTime?.(Number(spec.gain || 0.018), startedAt + 0.15);
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.start(startedAt);
    entry.oscillators.push(osc);
    entry.gains.push(gainNode);
  }

  return {
    async play(cue, channel, loop = false) {
      const spec = audioCueSpec(cue);
      if (!spec) {
        return {
          status: "error",
          payload: { reason: "invalid_cue", cue: String(cue || "") },
        };
      }
      try {
        const audioCtx = ensureCtx();
        if (typeof audioCtx.resume === "function") await audioCtx.resume();
        if (loop === true || String(cue) === "music_loop") {
          scheduleLoop(channel, spec);
        } else {
          scheduleOneShot(channel, spec);
        }
        return {
          status: "ok",
          payload: {
            cue: String(cue || ""),
            channel: String(channel || ""),
            loop: loop === true || String(cue) === "music_loop",
          },
        };
      } catch (err) {
        return {
          status: browserErrorStatus(err),
          payload: { message: String(err?.message ?? err), cue: String(cue || "") },
        };
      }
    },
    async stop(channel) {
      clearChannel(channel);
      return {
        status: "ok",
        payload: { channel: String(channel || "") },
      };
    },
  };
}

function createBrowserHapticsRuntime() {
  return {
    async trigger(pattern) {
      const pulse = hapticPatternSpec(pattern);
      if (!pulse) {
        return {
          status: "error",
          payload: { reason: "invalid_pattern", pattern: String(pattern || "") },
        };
      }
      const vibrate = globalThis.navigator?.vibrate;
      if (typeof vibrate !== "function") {
        return { status: "unsupported", payload: {} };
      }
      try {
        const ok = vibrate.call(globalThis.navigator, pulse);
        return {
          status: ok === false ? "error" : "ok",
          payload: { pattern: String(pattern || "") },
        };
      } catch (err) {
        return {
          status: browserErrorStatus(err),
          payload: { message: String(err?.message ?? err), pattern: String(pattern || "") },
        };
      }
    },
  };
}

async function readFileBytes(file) {
  if (!file || typeof file.arrayBuffer !== "function") throw new Error("file.arrayBuffer unavailable");
  return new Uint8Array(await file.arrayBuffer());
}

function promptBrowserFiles({ accept = "", capture = "", multiple = false } = {}) {
  if (!globalThis.document?.createElement) return Promise.resolve({ status: "unsupported", files: [] });
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.setAttribute("accept", accept);
    if (capture) input.setAttribute("capture", capture);
    input.multiple = multiple === true;
    input.style.display = "none";
    document.body?.appendChild?.(input);
    let settled = false;
    const cleanup = () => {
      input.remove?.();
      globalThis.removeEventListener?.("focus", onFocus, true);
    };
    const finish = (status, files = []) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ status, files });
    };
    const onFocus = () => {
      globalThis.setTimeout?.(() => finish("cancelled", []), 0);
    };
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []).filter(Boolean);
      finish(files.length > 0 ? "ok" : "cancelled", files);
    });
    globalThis.addEventListener?.("focus", onFocus, true);
    input.click();
  });
}

async function promptBrowserFile(options = {}) {
  const pick = await promptBrowserFiles({ ...options, multiple: false });
  return {
    status: pick.status,
    file: pick.files?.[0] ?? null,
  };
}

function browserErrorStatus(err) {
  const name = String(err?.name ?? "");
  if (name === "AbortError") return "cancelled";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  return "error";
}

function buildStoredDeviceFileItem(file, manifest) {
  const item = {
    name: typeof file?.name === "string" ? file.name : "",
    mime: String(file?.type || manifest?.mime || "application/octet-stream"),
    byte_size:
      Number.isFinite(Number(file?.size)) && Number(file?.size) >= 0
        ? Math.floor(Number(file.size))
        : Number(manifest?.byte_size ?? 0),
    blob: normalizeBlobManifest(manifest, String(manifest?.source || "files")),
  };
  if (Number.isFinite(Number(file?.lastModified))) {
    item.last_modified_ms = Math.max(0, Math.floor(Number(file.lastModified)));
  }
  return item;
}

async function createDeviceFileItemsFromFiles(files, blobStore, source = "files") {
  const items = [];
  for (const file of Array.isArray(files) ? files : []) {
    const bytes = await readFileBytes(file);
    const manifest = await blobStore.put(bytes, {
      mime: file?.type || "application/octet-stream",
      source,
    });
    items.push(buildStoredDeviceFileItem(file, manifest));
  }
  return items;
}

function buildFilesPayload(items, extra = {}) {
  return {
    ...extra,
    items,
    blobs: items.map((item) => item.blob).filter(Boolean),
  };
}

function buildSaveFileRequest(request) {
  const payload = request?.payload && typeof request.payload === "object" ? request.payload : {};
  if (request?.kind === "x07.web_ui.effect.device.files.save_json") {
    const value = "value" in payload ? payload.value : "json" in payload ? payload.json : null;
    return {
      name: String(payload.name || payload.filename || "export.json"),
      mime: String(payload.mime || "application/json"),
      bytes: textEncoder.encode(`${JSON.stringify(value ?? null, null, 2)}\n`),
    };
  }
  return {
    name: String(payload.name || payload.filename || "export.txt"),
    mime: String(payload.mime || "text/plain;charset=utf-8"),
    bytes: textEncoder.encode(String(payload.text ?? "")),
  };
}

async function saveBrowserFile({ name, mime, bytes }) {
  if (globalThis.document?.createElement && globalThis.URL?.createObjectURL) {
    try {
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.style.display = "none";
      document.body?.appendChild?.(a);
      a.click();
      a.remove?.();
      globalThis.setTimeout?.(() => URL.revokeObjectURL(url), 1000);
      return { status: "ok" };
    } catch (err) {
      return { status: "error", error: err };
    }
  }
  if (typeof globalThis.showSaveFilePicker === "function") {
    try {
      const handle = await globalThis.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return { status: "ok" };
    } catch (err) {
      return { status: browserErrorStatus(err), error: err };
    }
  }
  return { status: "unsupported" };
}

function buildSavedFileItem({ name, mime, bytes }) {
  return {
    name: String(name || ""),
    mime: String(mime || "application/octet-stream"),
    byte_size: bytes instanceof Uint8Array ? bytes.length : new Uint8Array(bytes || []).length,
  };
}

function shareFilesPayloadItems(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.blobs)) return payload.blobs;
  return [];
}

function resolveShareFiles(payload, blobStore) {
  if (typeof globalThis.File !== "function") {
    const err = new Error("File constructor is unavailable");
    err.code = "unsupported";
    throw err;
  }
  const items = normalizeDeviceFileItems(shareFilesPayloadItems(payload), "share.present");
  const files = [];
  const normalizedItems = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const handle = String(item?.blob?.handle || "");
    if (!handle) {
      throw new Error("share file item missing blob.handle");
    }
    const stored = blobStore.get(handle);
    if (!stored) {
      throw new Error(`share file blob handle is not present: ${handle}`);
    }
    const name = item.name || `file-${i + 1}`;
    const mime = String(item.mime || stored.manifest.mime || "application/octet-stream");
    files.push(
      new globalThis.File([stored.bytes], name, {
        type: mime,
        lastModified: Number(item.last_modified_ms ?? stored.manifest.created_at_ms ?? Date.now()),
      }),
    );
    normalizedItems.push({
      ...item,
      name,
      mime,
      byte_size: Number(item.byte_size || stored.manifest.byte_size),
      blob: normalizeBlobManifest(stored.manifest, "share.present"),
    });
  }
  return { files, items: normalizedItems };
}

async function buildFilesDropEvent(target, rawFiles, blobStore) {
  return {
    type: "files.drop",
    target: String(target || ""),
    items: await createDeviceFileItemsFromFiles(Array.from(rawFiles || []).filter(Boolean), blobStore, "files.drop"),
  };
}

async function queryBrowserPermissionState(permission) {
  const name = String(permission || "");
  if (name === "notifications") {
    if (!globalThis.Notification) return "unsupported";
    return normalizePermissionState(globalThis.Notification.permission);
  }
  const permissionsApi = globalThis.navigator?.permissions;
  if (!permissionsApi || typeof permissionsApi.query !== "function") return "unsupported";
  const descriptorName = name === "location_foreground" ? "geolocation" : name;
  try {
    const result = await permissionsApi.query({ name: descriptorName });
    return normalizePermissionState(result?.state);
  } catch (_) {
    return "unsupported";
  }
}

async function requestBrowserPermission(permission) {
  const name = String(permission || "");
  if (name === "notifications") {
    if (!globalThis.Notification?.requestPermission) return { status: "unsupported", state: "unsupported" };
    const state = normalizePermissionState(await globalThis.Notification.requestPermission());
    return { status: "ok", state };
  }
  if (name === "camera") {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
      return { status: "unsupported", state: "unsupported" };
    }
    try {
      const stream = await globalThis.navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks?.().forEach((track) => track.stop?.());
      return { status: "ok", state: "granted" };
    } catch (err) {
      const errName = String(err?.name ?? "");
      if (errName === "NotAllowedError" || errName === "SecurityError") {
        return { status: "denied", state: "denied" };
      }
      return { status: "error", state: "unsupported" };
    }
  }
  if (name === "location_foreground") {
    if (!globalThis.navigator?.geolocation?.getCurrentPosition) {
      return { status: "unsupported", state: "unsupported" };
    }
    return new Promise((resolve) => {
      globalThis.navigator.geolocation.getCurrentPosition(
        () => resolve({ status: "ok", state: "granted" }),
        (err) => {
          const code = Number(err?.code ?? 0);
          if (code === 1) resolve({ status: "denied", state: "denied" });
          else if (code === 3) resolve({ status: "timeout", state: "prompt" });
          else resolve({ status: "error", state: "unsupported" });
        },
        { maximumAge: 0, timeout: 10000, enableHighAccuracy: false },
      );
    });
  }
  return { status: "unsupported", state: "unsupported" };
}

function getCurrentBrowserLocation(timeoutMs) {
  if (!globalThis.navigator?.geolocation?.getCurrentPosition) {
    return Promise.resolve({ status: "unsupported", payload: {} });
  }
  return new Promise((resolve) => {
    globalThis.navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          status: "ok",
          payload: {
            latitude: Number(pos?.coords?.latitude ?? 0),
            longitude: Number(pos?.coords?.longitude ?? 0),
            accuracy_m: Number(pos?.coords?.accuracy ?? 0),
            altitude_m:
              Number.isFinite(Number(pos?.coords?.altitude))
                ? Number(pos.coords.altitude)
                : null,
            captured_at_ms: Date.now(),
          },
        }),
      (err) => {
        const code = Number(err?.code ?? 0);
        if (code === 1) resolve({ status: "denied", payload: {} });
        else if (code === 3) resolve({ status: "timeout", payload: {} });
        else resolve({ status: "error", payload: {} });
      },
      {
        maximumAge: 0,
        timeout: Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : 10000,
        enableHighAccuracy: false,
      },
    );
  });
}

function createBrowserNativeHost({ capabilities, dispatchHostEvent, platform = "web" }) {
  const blobStore = createInMemoryBlobStore(capabilities);
  const audioRuntime = createBrowserAudioRuntime();
  const hapticsRuntime = createBrowserHapticsRuntime();
  const notifications = new Map();

  function clearNotification(id) {
    const entry = notifications.get(String(id || ""));
    if (!entry) return null;
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    entry.notification?.close?.();
    notifications.delete(String(id || ""));
    return entry;
  }

  return {
    mode: "browser",
    async dispatchFilesDrop(target, rawFiles) {
      return dispatchHostEvent(await buildFilesDropEvent(target, rawFiles, blobStore));
    },
    async invoke(request) {
      const hostMeta = deviceHostMeta(platform);
      switch (request.family) {
        case "permissions": {
          const permission = String(request.payload.permission || "");
          if (request.op === "permissions.query") {
            const state = await queryBrowserPermissionState(permission);
            return { family: request.family, result: mkDeviceResult(request, "ok", { permission, state }, hostMeta) };
          }
          const outcome = await requestBrowserPermission(permission);
          return {
            family: request.family,
            result: mkDeviceResult(request, outcome.status, { permission, state: outcome.state }, hostMeta),
          };
        }
        case "camera": {
          const lens = String(request.payload.lens || "rear");
          const pick = await promptBrowserFile({
            accept: "image/*",
            capture: lens === "front" ? "user" : "environment",
          });
          if (pick.status !== "ok" || !pick.file) {
            return { family: request.family, result: mkDeviceResult(request, pick.status, {}, hostMeta) };
          }
          const bytes = await readFileBytes(pick.file);
          const manifest = await blobStore.put(bytes, {
            mime: pick.file.type || "image/jpeg",
            source: "camera",
            image: null,
          });
          return {
            family: request.family,
            result: mkDeviceResult(
              request,
              "ok",
              {
                blob: manifest,
                image: { width: 0, height: 0 },
              },
              hostMeta,
            ),
          };
        }
        case "audio": {
          if (request.op === "audio.stop") {
            const outcome = await audioRuntime.stop(request.payload.channel);
            return {
              family: request.family,
              result: mkDeviceResult(request, outcome.status, outcome.payload, hostMeta),
            };
          }
          const outcome = await audioRuntime.play(
            request.payload.cue,
            request.payload.channel,
            request.payload.loop === true,
          );
          return {
            family: request.family,
            result: mkDeviceResult(request, outcome.status, outcome.payload, hostMeta),
          };
        }
        case "haptics": {
          const outcome = await hapticsRuntime.trigger(request.payload.pattern);
          return {
            family: request.family,
            result: mkDeviceResult(request, outcome.status, outcome.payload, hostMeta),
          };
        }
        case "clipboard": {
          const clipboard = globalThis.navigator?.clipboard;
          if (request.op === "clipboard.read_text") {
            if (!clipboard || typeof clipboard.readText !== "function") {
              return { family: request.family, result: mkDeviceResult(request, "unsupported", {}, hostMeta) };
            }
            try {
              const text = await clipboard.readText();
              return {
                family: request.family,
                result: mkDeviceResult(request, "ok", { text: String(text ?? "") }, hostMeta),
              };
            } catch (err) {
              return {
                family: request.family,
                result: mkDeviceResult(request, browserErrorStatus(err), {}, hostMeta),
              };
            }
          }
          if (!clipboard || typeof clipboard.writeText !== "function") {
            return { family: request.family, result: mkDeviceResult(request, "unsupported", {}, hostMeta) };
          }
          try {
            const text = String(request.payload.text ?? "");
            await clipboard.writeText(text);
            return {
              family: request.family,
              result: mkDeviceResult(request, "ok", { text_len: text.length }, hostMeta),
            };
          } catch (err) {
            return {
              family: request.family,
              result: mkDeviceResult(request, browserErrorStatus(err), {}, hostMeta),
            };
          }
        }
        case "files": {
          if (request.op === "files.save") {
            const saveRequest = buildSaveFileRequest(request);
            const outcome = await saveBrowserFile(saveRequest);
            return {
              family: request.family,
              result: mkDeviceResult(
                request,
                outcome.status,
                outcome.status === "ok"
                  ? buildFilesPayload([buildSavedFileItem(saveRequest)])
                  : {},
                hostMeta,
              ),
            };
          }
          const accept = Array.isArray(request.payload.accept)
            ? request.payload.accept.map((item) => String(item || "")).filter(Boolean).join(",")
            : "";
          const multiple = request.payload?.multiple === true;
          const pick = await promptBrowserFiles({ accept, multiple });
          if (pick.status !== "ok" || !Array.isArray(pick.files) || pick.files.length === 0) {
            return { family: request.family, result: mkDeviceResult(request, pick.status, {}, hostMeta) };
          }
          const items = await createDeviceFileItemsFromFiles(pick.files, blobStore, "files.pick");
          return {
            family: request.family,
            result: mkDeviceResult(request, "ok", buildFilesPayload(items, { multiple }), hostMeta),
          };
        }
        case "share": {
          const share = globalThis.navigator?.share;
          if (typeof share !== "function") {
            if (request.kind === "x07.web_ui.effect.device.share.share_files") {
              return { family: request.family, result: mkDeviceResult(request, "unsupported", {}, hostMeta) };
            }
            return fallbackShareToClipboard(request, request.payload, hostMeta);
          }
          const payload = request.payload && typeof request.payload === "object" ? request.payload : {};
          const title = typeof payload.title === "string" ? payload.title : undefined;
          const text = typeof payload.text === "string" ? payload.text : undefined;
          const url = typeof payload.url === "string" ? payload.url : undefined;
          try {
            if (request.kind === "x07.web_ui.effect.device.share.share_files") {
              const { files, items } = resolveShareFiles(payload, blobStore);
              if (files.length === 0) {
                return {
                  family: request.family,
                  result: mkDeviceResult(
                    request,
                    "error",
                    { message: "share_files requires at least one item" },
                    hostMeta,
                  ),
                };
              }
              if (
                typeof globalThis.navigator?.canShare === "function" &&
                !globalThis.navigator.canShare({ files })
              ) {
                return { family: request.family, result: mkDeviceResult(request, "unsupported", {}, hostMeta) };
              }
              await share.call(globalThis.navigator, { title, text, url, files });
              return {
                family: request.family,
                result: mkDeviceResult(request, "ok", { items }, hostMeta),
              };
            }
            await share.call(globalThis.navigator, { title, text, url });
            return {
              family: request.family,
              result: mkDeviceResult(request, "ok", {}, hostMeta),
            };
          } catch (err) {
            if (err?.code === "unsupported") {
              if (request.kind === "x07.web_ui.effect.device.share.share_files") {
                return { family: request.family, result: mkDeviceResult(request, "unsupported", {}, hostMeta) };
              }
              return fallbackShareToClipboard(request, payload, hostMeta);
            }
            return {
              family: request.family,
              result: mkDeviceResult(request, browserErrorStatus(err), {}, hostMeta),
            };
          }
        }
        case "blobs": {
          const handle = String(request.payload.handle || "");
          if (request.op === "blobs.delete") {
            return {
              family: request.family,
              result: mkDeviceResult(request, "ok", { blob: blobStore.delete(handle) }, hostMeta),
            };
          }
          return {
            family: request.family,
            result: mkDeviceResult(request, "ok", { blob: blobStore.stat(handle) }, hostMeta),
          };
        }
        case "location": {
          const outcome = await getCurrentBrowserLocation(request.payload.timeout_ms);
          return {
            family: request.family,
            result: mkDeviceResult(request, outcome.status, outcome.payload, hostMeta),
          };
        }
        case "notifications": {
          if (!globalThis.Notification) {
            return { family: request.family, result: mkDeviceResult(request, "unsupported", {}, hostMeta) };
          }
          if (request.op === "notifications.cancel") {
            const notificationId = String(request.payload.notification_id || request.payload.id || "");
            clearNotification(notificationId);
            return {
              family: request.family,
              result: mkDeviceResult(request, "ok", { notification_id: notificationId }, hostMeta),
            };
          }
          const permission = normalizePermissionState(globalThis.Notification.permission);
          if (permission !== "granted") {
            return {
              family: request.family,
              result: mkDeviceResult(request, permission === "denied" ? "denied" : "unsupported", {}, hostMeta),
            };
          }
          const notificationId = String(request.payload.notification_id || request.payload.id || request.request_id || "");
          const title = String(request.payload.title || "");
          const body = String(request.payload.body || "");
          const delayMs = Number.isFinite(Number(request.payload.delay_ms))
            ? Math.max(0, Math.floor(Number(request.payload.delay_ms)))
            : 0;
          const timeoutHandle = globalThis.setTimeout?.(() => {
            const notification = new globalThis.Notification(title, { body, tag: notificationId });
            notification.onclick = () => {
              void dispatchHostEvent({ type: "notification.opened", notification_id: notificationId });
            };
            notifications.set(notificationId, { notification, timeoutHandle: null });
          }, delayMs);
          notifications.set(notificationId, { timeoutHandle, notification: null });
          return {
            family: request.family,
            result: mkDeviceResult(request, "ok", { notification_id: notificationId }, hostMeta),
          };
        }
        default:
          return { family: request.family, result: mkDeviceResult(request, "unsupported", {}, hostMeta) };
      }
    },
  };
}

function createIpcNativeHost({ dispatchHostEvent }) {
  if (!globalThis.ipc || typeof globalThis.ipc.postMessage !== "function") return null;
  if (globalThis.__x07DeviceNativeBridge !== "m0") return null;
  let seq = 0;
  const pending = new Map();
  globalThis.__x07ReceiveDeviceReply = (raw) => {
    const doc = parseJsonMaybe(raw);
    const bridgeRequestId = String(doc?.bridge_request_id ?? "");
    if (!bridgeRequestId || !pending.has(bridgeRequestId)) return;
    const pendingEntry = pending.get(bridgeRequestId);
    pending.delete(bridgeRequestId);
    pendingEntry.resolve(doc?.result ?? {});
  };
  globalThis.__x07DispatchDeviceEvent = (raw) => {
    const event = normalizeDeviceHostEvent(parseJsonMaybe(raw));
    void dispatchHostEvent(event);
  };
  return {
    mode: "ipc",
    invoke(request) {
      return new Promise((resolve, reject) => {
        const bridgeRequestId = `native_${seq++}`;
        pending.set(bridgeRequestId, { resolve, reject });
        try {
          globalThis.ipc.postMessage(
            JSON.stringify({
              v: 1,
              kind: "x07.device.native.request",
              bridge_request_id: bridgeRequestId,
              request,
            }),
          );
        } catch (err) {
          pending.delete(bridgeRequestId);
          reject(err);
        }
      });
    },
  };
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
  telemetry = null,
} = {}) {
  if (!wasmUrl && !componentEsmUrl) throw new Error("missing wasmUrl/componentEsmUrl");
  if (!root) throw new Error("missing root");

  function emitTelemetry(eventClass, name, attributes = {}, options = {}) {
    if (!telemetry || typeof telemetry.emit !== "function") return;
    telemetry.emit(eventClass, name, attributes, options);
  }

  function reportDispatchError(stage, err, attributes = {}) {
    const msg = String(err?.message ?? err);
    emitTelemetry(
      "runtime.error",
      "runtime.error",
      { stage, message: msg, ...attributes },
      { body: String(err?.stack ?? msg), severity: "error" },
    );
    console.error(err);
  }

  async function dispatchHostEvent(rawEvent) {
    const event = normalizeDeviceHostEvent(rawEvent);
    return dispatch(event);
  }

  function currentNavInjection(op = "replace") {
    const href = String(globalThis.location?.href ?? "");
    const path = sanitizeSameOriginUrlPath(href);
    if (!href || path == null) return null;
    const currentRoute =
      state && typeof state === "object" && !Array.isArray(state) && typeof state.route === "string"
        ? state.route
        : null;
    if (currentRoute === path) return null;
    return { op, path, href };
  }

  async function dispatchInjectedState(event, injectedDelta) {
    const baseState =
      state && typeof state === "object" && !Array.isArray(state) ? state : null;
    const nextState =
      injectedDelta && typeof injectedDelta === "object" && !Array.isArray(injectedDelta)
        ? { ...(baseState ?? {}), ...injectedDelta }
        : baseState;
    const env0 = { v: 1, kind: "x07.web_ui.dispatch", state: nextState, event };
    const out = await callReducer(env0, false);
    commitFrame(out.frame);
    return runEffectsLoop(event, env0, out.frame, out.wallMs);
  }

  async function dispatchCurrentNavSync(op = "replace") {
    const nav = currentNavInjection(op);
    if (!nav) return null;
    return dispatchInjectedState({ type: "nav.sync" }, { __x07_nav: nav });
  }

  const ipcNativeHost = createIpcNativeHost({ dispatchHostEvent });
  const browserNativeHost = createBrowserNativeHost({
    capabilities,
    dispatchHostEvent,
    platform: ipcNativeHost ? "device" : "web",
  });

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
  let deviceEventSourcesInstalled = false;

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
    let outBytes;
    try {
      outBytes = initCall ? await app.init() : await app.step(inputBytes);
    } catch (err) {
      const response = env?.state?.__x07_http?.response ?? null;
      const errName =
        err && typeof err === "object" && typeof err.name === "string" ? err.name : null;
      const errMessage =
        err && typeof err === "object" && typeof err.message === "string"
          ? err.message
          : null;
      const context = {
        init_call: Boolean(initCall),
        event_type: String(env?.event?.type ?? "unknown"),
        error_name: errName,
        error_message: errMessage,
        error_string: String(err ?? "unknown error"),
        input_bytes_len: inputBytes.length,
        state_keys:
          env?.state && typeof env.state === "object" && !Array.isArray(env.state)
            ? Object.keys(env.state).sort()
            : [],
        http_response:
          response && typeof response === "object"
            ? {
                request_id:
                  typeof response.request_id === "string" ? response.request_id : null,
                status: Number.isFinite(Number(response.status)) ? Number(response.status) : null,
                headers_len: Array.isArray(response.headers) ? response.headers.length : 0,
                body_bytes_len: Number(response?.body?.bytes_len ?? 0),
                body_text_prefix:
                  typeof response?.body?.text === "string"
                    ? response.body.text.slice(0, 256)
                    : null,
              }
            : null,
        storage_get:
          env?.state?.__x07_storage?.get && typeof env.state.__x07_storage.get === "object"
            ? {
                key: String(env.state.__x07_storage.get.key ?? ""),
                value_prefix:
                  env.state.__x07_storage.get.value == null
                    ? null
                    : String(env.state.__x07_storage.get.value).slice(0, 256),
              }
            : null,
      };
      const wrapped = new Error(`reducer dispatch failed: ${stableJson(context)}`);
      wrapped.cause = err;
      wrapped.stack = `${wrapped.message}\n${String(err?.stack ?? err)}`;
      wrapped.x07Context = context;
      throw wrapped;
    }
    const wallMs = performance.now() - started;

    const frameText = textDecoder.decode(outBytes);
    const frame = JSON.parse(frameText);
    trace.steps.push({ env, frame, wallMs });
    emitTelemetry("reducer.timing", initCall ? "reducer.init" : "reducer.dispatch", {
      reducer_kind: app?.kind ?? "unknown",
      wall_ms: Math.round(wallMs),
      input_bytes_len: inputBytes.length,
    });
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
    let nativeMs = 0;
    let loopCount = 0;
    let effectCount = 0;
    const exchanges = [];

    for (let i = 0; i < MAX_EFFECT_LOOPS; i++) {
      const effects = Array.isArray(frame?.effects) ? frame.effects : [];
      if (effects.length === 0) break;
      if (effects.length > MAX_EFFECTS_PER_STEP) {
        throw new Error(`too many effects: n=${effects.length} max=${MAX_EFFECTS_PER_STEP}`);
      }
      loopCount += 1;
      effectCount += effects.length;

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

          try {
            enforceFetchAllowed(capabilities, url);
          } catch (err) {
            const msg = String(err?.message ?? err);
            emitTelemetry(
              "policy.violation",
              "policy.fetch.denied",
              {
                url,
                method: reqEnv.method,
                path: reqEnv.path,
                request_id: reqEnv.id,
                message: msg,
              },
              { body: String(err?.stack ?? msg), severity: "warn" },
            );
            throw err;
          }
          const startedHttp = performance.now();
          const resp = await fetch(url, {
            method: reqEnv.method,
            headers: reqHeaders,
            body: reqBodyBytes.length ? reqBodyBytes : undefined,
          });
          const respBuf = new Uint8Array(await resp.arrayBuffer());
          const httpElapsedMs = performance.now() - startedHttp;
          httpMs += httpElapsedMs;

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
          emitTelemetry("app.http", "app.http", {
            request_id: reqEnv.id,
            method: reqEnv.method,
            path: reqEnv.path,
            status: resp.status,
            duration_ms: Math.round(httpElapsedMs),
            response_bytes_len: respBuf.length,
          });

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
          const inj = { set: { ok: true } };
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

        const deviceRequest = parseAnyDeviceEffect(eff);
        if (deviceRequest) {
          let normalized = null;
          const platform = ipcNativeHost ? "device" : "web";
          const bypassCapabilityCheck = !ipcNativeHost && capabilities == null;
          if (!bypassCapabilityCheck && !capabilityAllowed(capabilities, deviceRequest.capability)) {
            emitTelemetry(
              "policy.violation",
              "policy.device.denied",
              {
                family: deviceRequest.family,
                op: deviceRequest.op,
                capability: deviceRequest.capability,
                request_id: deviceRequest.request_id,
              },
              { severity: "warn" },
            );
            normalized = {
              family: deviceRequest.family,
              result: mkDeviceResult(deviceRequest, "unsupported", {}, deviceHostMeta(platform)),
            };
          } else {
            const startedNative = performance.now();
            try {
              const primaryHost = ipcNativeHost || browserNativeHost;
              if (!primaryHost) throw new Error("missing native host");
              const rawResult = await primaryHost.invoke(deviceRequest);
              normalized = normalizeDeviceResult(deviceRequest, rawResult?.result ?? rawResult, rawResult?.family ?? deviceRequest.family, platform);
              if (
                ipcNativeHost &&
                browserNativeHost &&
                normalized.result.status === "unsupported"
              ) {
                const fallbackRawResult = await browserNativeHost.invoke(deviceRequest);
                normalized = normalizeDeviceResult(
                  deviceRequest,
                  fallbackRawResult?.result ?? fallbackRawResult,
                  fallbackRawResult?.family ?? deviceRequest.family,
                  platform,
                );
              }
            } catch (err) {
              normalized = {
                family: deviceRequest.family,
                result: mkDeviceResult(
                  deviceRequest,
                  "error",
                  { message: String(err?.message ?? err) },
                  deviceHostMeta(platform),
                ),
              };
            }
            nativeMs += performance.now() - startedNative;
          }
          const inj = { [normalized.family]: { result: normalized.result } };
          const prev = injectedState.__x07_device;
          injectedState.__x07_device =
            prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev, ...inj } : inj;
          addInjectionDelta(delta, "__x07_device", inj);
          recordEffectExchange(eff, { __x07_device: inj });
          emitTelemetry("bridge.timing", "bridge.device_effect", {
            family: deviceRequest.family,
            op: deviceRequest.op,
            request_id: deviceRequest.request_id,
            status: normalized.result.status,
            native_ms: Math.round(nativeMs),
          });
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

    emitTelemetry("bridge.timing", "bridge.dispatch", {
      event_type: String(event?.type ?? "unknown"),
      effect_loops: loopCount,
      effect_count: effectCount,
      http_exchange_count: exchanges.length,
      ui_ms: Math.round(uiMs),
      http_ms: Math.round(httpMs),
      native_ms: Math.round(nativeMs),
      total_ms: Math.round(uiMs + httpMs + nativeMs),
    });

    return frame;
  }

  async function dispatch(event) {
    return dispatchInjectedState(event, null);
  }

  function installDeviceEventSources() {
    if (deviceEventSourcesInstalled) return;
    deviceEventSourcesInstalled = true;
    let lastVisibility = String(globalThis.document?.visibilityState ?? "visible");
    globalThis.addEventListener?.("visibilitychange", () => {
      const nextVisibility = String(globalThis.document?.visibilityState ?? "visible");
      if (nextVisibility === "hidden") {
        void dispatchHostEvent({ type: "lifecycle.background" }).catch((err) =>
          reportDispatchError("lifecycle.background", err),
        );
      } else {
        void dispatchHostEvent({ type: "lifecycle.foreground" }).catch((err) =>
          reportDispatchError("lifecycle.foreground", err),
        );
        if (lastVisibility === "hidden") {
          void dispatchHostEvent({ type: "lifecycle.resume" }).catch((err) =>
            reportDispatchError("lifecycle.resume", err),
          );
        }
      }
      lastVisibility = nextVisibility;
    });
    globalThis.addEventListener?.("online", () => {
      void dispatchHostEvent({ type: "connectivity.online" }).catch((err) =>
        reportDispatchError("connectivity.online", err),
      );
    });
    globalThis.addEventListener?.("offline", () => {
      void dispatchHostEvent({ type: "connectivity.offline" }).catch((err) =>
        reportDispatchError("connectivity.offline", err),
      );
    });
    globalThis.addEventListener?.("popstate", () => {
      void dispatchCurrentNavSync("replace").catch((err) =>
        reportDispatchError("nav.popstate", err),
      );
    });
  }

  try {
    const event = { type: "init" };
    const env0 = { v: 1, kind: "x07.web_ui.dispatch", state: null, event };
    const out = await callReducer(env0, true);
    commitFrame(out.frame);
    await runEffectsLoop(event, env0, out.frame, out.wallMs);
    await dispatchCurrentNavSync("replace");
    installDeviceEventSources();
  } catch (err) {
    emitTelemetry(
      "runtime.error",
      "runtime.error",
      { stage: "mount", message: String(err?.message ?? err) },
      { body: String(err?.stack ?? err), severity: "error" },
    );
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
      void dispatch({ type: "click", target }).catch((err) =>
        reportDispatchError("click", err, { target }),
      );
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
        reportDispatchError("input", err, { target }),
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
        reportDispatchError("change", err, { target }),
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
      void dispatch({ type: "submit", target }).catch((err) =>
        reportDispatchError("submit", err, { target }),
      );
    },
    true,
  );
  root.addEventListener(
    "dragover",
    (ev) => {
      const el = ev?.target?.closest?.("[data-x07-key]");
      const target = el?.dataset?.x07Key || "";
      if (!target) return;
      const allowed = allowedEvents.get(target);
      if (!(allowed?.has("files.drop") ?? false) && !(allowed?.has("drop") ?? false)) return;
      if (!capabilityAllowed(capabilities, "files.drop")) return;
      ev.preventDefault();
    },
    true,
  );
  root.addEventListener(
    "drop",
    (ev) => {
      const el = ev?.target?.closest?.("[data-x07-key]");
      const target = el?.dataset?.x07Key || "";
      if (!target) return;
      const allowed = allowedEvents.get(target);
      if (!(allowed?.has("files.drop") ?? false) && !(allowed?.has("drop") ?? false)) return;
      if (!capabilityAllowed(capabilities, "files.drop")) return;
      ev.preventDefault();
      void browserNativeHost
        .dispatchFilesDrop(target, ev?.dataTransfer?.files || [])
        .catch((err) => reportDispatchError("files.drop", err, { target }));
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
