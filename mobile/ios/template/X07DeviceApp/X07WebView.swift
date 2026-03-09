import Foundation
import SwiftUI
import WebKit

private let telemetryScopeName = "x07.device.host"
private let telemetryScopeVersion = "__X07_VERSION__"

private struct TelemetryTransport {
  let protocolName: String
  let endpoint: String
}

private enum TelemetryValue {
  case string(String)
  case bool(Bool)
  case int(Int64)
  case double(Double)

  func jsonObject() -> [String: Any] {
    switch self {
    case let .string(value):
      return ["stringValue": value]
    case let .bool(value):
      return ["boolValue": value]
    case let .int(value):
      return ["intValue": String(value)]
    case let .double(value):
      return ["doubleValue": value]
    }
  }
}

private struct TelemetryEvent {
  let eventClass: String
  let name: String
  let timeUnixMs: Int64
  let severity: String
  let body: String?
  let attributes: [String: TelemetryValue]
}

private struct TelemetryEnvelope {
  let transport: TelemetryTransport
  let resource: [String: TelemetryValue]
  let event: TelemetryEvent
}

private struct TelemetryRuntimeConfig {
  let transport: TelemetryTransport
  let resource: [String: TelemetryValue]
  let eventClasses: Set<String>
}

private final class ProtoWriter {
  private(set) var data = Data()

  func writeMessage(fieldNumber: Int, payload: Data) {
    writeTag(fieldNumber: fieldNumber, wireType: 2)
    writeVarint(UInt64(payload.count))
    data.append(payload)
  }

  func writeString(fieldNumber: Int, value: String) {
    writeMessage(fieldNumber: fieldNumber, payload: Data(value.utf8))
  }

  func writeBool(fieldNumber: Int, value: Bool) {
    writeTag(fieldNumber: fieldNumber, wireType: 0)
    writeVarint(value ? 1 : 0)
  }

  func writeInt64(fieldNumber: Int, value: Int64) {
    writeTag(fieldNumber: fieldNumber, wireType: 0)
    writeVarint(UInt64(bitPattern: value))
  }

  func writeEnum(fieldNumber: Int, value: Int) {
    writeTag(fieldNumber: fieldNumber, wireType: 0)
    writeVarint(UInt64(value))
  }

  func writeFixed64(fieldNumber: Int, value: UInt64) {
    writeTag(fieldNumber: fieldNumber, wireType: 1)
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
  }

  func writeDouble(fieldNumber: Int, value: Double) {
    writeTag(fieldNumber: fieldNumber, wireType: 1)
    var littleEndian = value.bitPattern.littleEndian
    withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
  }

  private func writeTag(fieldNumber: Int, wireType: UInt64) {
    writeVarint(UInt64(fieldNumber << 3) | wireType)
  }

  private func writeVarint(_ value: UInt64) {
    var next = value
    while true {
      if next < 0x80 {
        data.append(UInt8(next))
        return
      }
      data.append(UInt8((next & 0x7f) | 0x80))
      next >>= 7
    }
  }
}

private final class TelemetryCoordinator {
  private let queue = DispatchQueue(label: "org.x07.deviceapp.telemetry")
  private let session: URLSession
  private var runtime: TelemetryRuntimeConfig?

  init() {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 5
    config.timeoutIntervalForResource = 5
    config.waitsForConnectivity = false
    session = URLSession(configuration: config)
  }

  func handleIpc(_ message: String) -> Bool {
    guard let data = message.data(using: .utf8) else {
      return false
    }
    guard
      let raw = try? JSONSerialization.jsonObject(with: data),
      let doc = raw as? [String: Any],
      let kind = doc["kind"] as? String
    else {
      return false
    }
    switch kind {
    case "x07.device.telemetry.configure":
      configure(doc)
      return true
    case "x07.device.telemetry.event":
      if let envelope = parseEnvelope(doc) {
        export(envelope)
      }
      return true
    default:
      return false
    }
  }

  func emitNativeEvent(
    eventClass: String,
    name: String,
    severity: String,
    attributes: [String: Any],
    body: String? = nil
  ) {
    let active = queue.sync { runtime }
    guard let active else {
      return
    }
    guard active.eventClasses.contains(eventClass) else {
      return
    }
    export(
      TelemetryEnvelope(
        transport: active.transport,
        resource: active.resource,
        event: TelemetryEvent(
          eventClass: eventClass,
          name: name,
          timeUnixMs: Int64(Date().timeIntervalSince1970 * 1000),
          severity: severity,
          body: body,
          attributes: sanitizeAttributes(attributes)
        )
      )
    )
  }

  private func configure(_ doc: [String: Any]) {
    guard let transport = parseTransport(doc["transport"]) else {
      return
    }
    guard transportSupported(transport) else {
      return
    }
    let eventClasses = Set((doc["event_classes"] as? [Any] ?? []).compactMap { value in
      let text = String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
      return text.isEmpty ? nil : text
    })
    let resource = sanitizeAttributes(doc["resource"] as? [String: Any] ?? [:])
    queue.async {
      self.runtime = TelemetryRuntimeConfig(
        transport: transport,
        resource: resource,
        eventClasses: eventClasses
      )
    }
  }

  private func parseEnvelope(_ doc: [String: Any]) -> TelemetryEnvelope? {
    guard let transport = parseTransport(doc["transport"]) else {
      return nil
    }
    guard transportSupported(transport) else {
      return nil
    }
    guard let eventDoc = doc["event"] as? [String: Any] else {
      return nil
    }
    let eventClass = String(describing: eventDoc["class"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let name = String(describing: eventDoc["name"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !eventClass.isEmpty, !name.isEmpty else {
      return nil
    }
    return TelemetryEnvelope(
      transport: transport,
      resource: sanitizeAttributes(doc["resource"] as? [String: Any] ?? [:]),
      event: TelemetryEvent(
        eventClass: eventClass,
        name: name,
        timeUnixMs: parseTimeUnixMs(eventDoc["time_unix_ms"]),
        severity: String(describing: eventDoc["severity"] ?? "info"),
        body: parseOptionalString(eventDoc["body"]),
        attributes: sanitizeAttributes(eventDoc["attributes"] as? [String: Any] ?? [:])
      )
    )
  }

  private func export(_ envelope: TelemetryEnvelope) {
    guard transportSupported(envelope.transport) else {
      return
    }
    guard let url = URL(string: normalizeLogsEndpoint(envelope.transport.endpoint)) else {
      return
    }
    queue.async {
      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      switch envelope.transport.protocolName {
      case "http/protobuf":
        request.setValue("application/x-protobuf", forHTTPHeaderField: "Content-Type")
        request.httpBody = self.buildProtobufRequest(envelope)
      case "http/json":
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = self.buildJsonRequest(envelope)
      default:
        return
      }
      self.session.dataTask(with: request) { _, _, error in
        if let error {
          NSLog("x07 telemetry export failed: %@", error.localizedDescription)
        }
      }.resume()
    }
  }

  private func buildJsonRequest(_ envelope: TelemetryEnvelope) -> Data? {
    var eventAttributes = envelope.event.attributes
    eventAttributes["x07.event.class"] = .string(envelope.event.eventClass)
    let logRecord: [String: Any] = [
      "timeUnixNano": String(max(envelope.event.timeUnixMs, 0) * 1_000_000),
      "observedTimeUnixNano": String(Int64(Date().timeIntervalSince1970 * 1000) * 1_000_000),
      "severityNumber": severityNumberName(envelope.event.severity),
      "severityText": envelope.event.severity.uppercased(),
      "body": TelemetryValue.string(envelope.event.body ?? envelope.event.name).jsonObject(),
      "attributes": keyValuesJson(eventAttributes),
      "eventName": envelope.event.name,
    ]
    let scope: [String: Any] = [
      "name": telemetryScopeName,
      "version": telemetryScopeVersion,
    ]
    let scopeLogs: [String: Any] = [
      "scope": scope,
      "logRecords": [logRecord],
    ]
    let resource: [String: Any] = [
      "attributes": keyValuesJson(envelope.resource),
    ]
    let resourceLogs: [String: Any] = [
      "resource": resource,
      "scopeLogs": [scopeLogs],
    ]
    let request: [String: Any] = [
      "resourceLogs": [resourceLogs],
    ]
    return try? JSONSerialization.data(withJSONObject: request)
  }

  private func buildProtobufRequest(_ envelope: TelemetryEnvelope) -> Data {
    let resource = ProtoWriter()
    for (key, value) in envelope.resource {
      resource.writeMessage(fieldNumber: 1, payload: keyValueMessage(key: key, value: value))
    }

    var eventAttributes = envelope.event.attributes
    eventAttributes["x07.event.class"] = .string(envelope.event.eventClass)

    let logRecord = ProtoWriter()
    logRecord.writeFixed64(fieldNumber: 1, value: UInt64(max(envelope.event.timeUnixMs, 0) * 1_000_000))
    logRecord.writeEnum(fieldNumber: 2, value: severityNumberValue(envelope.event.severity))
    logRecord.writeString(fieldNumber: 3, value: envelope.event.severity.uppercased())
    logRecord.writeMessage(fieldNumber: 5, payload: anyValueMessage(.string(envelope.event.body ?? envelope.event.name)))
    for (key, value) in eventAttributes {
      logRecord.writeMessage(fieldNumber: 6, payload: keyValueMessage(key: key, value: value))
    }
    logRecord.writeFixed64(
      fieldNumber: 11,
      value: UInt64(Int64(Date().timeIntervalSince1970 * 1000) * 1_000_000)
    )
    logRecord.writeString(fieldNumber: 12, value: envelope.event.name)

    let scope = ProtoWriter()
    scope.writeString(fieldNumber: 1, value: telemetryScopeName)
    scope.writeString(fieldNumber: 2, value: telemetryScopeVersion)

    let scopeLogs = ProtoWriter()
    scopeLogs.writeMessage(fieldNumber: 1, payload: scope.data)
    scopeLogs.writeMessage(fieldNumber: 2, payload: logRecord.data)

    let resourceLogs = ProtoWriter()
    resourceLogs.writeMessage(fieldNumber: 1, payload: resource.data)
    resourceLogs.writeMessage(fieldNumber: 2, payload: scopeLogs.data)

    let request = ProtoWriter()
    request.writeMessage(fieldNumber: 1, payload: resourceLogs.data)
    return request.data
  }

  private func keyValueMessage(key: String, value: TelemetryValue) -> Data {
    let writer = ProtoWriter()
    writer.writeString(fieldNumber: 1, value: key)
    writer.writeMessage(fieldNumber: 2, payload: anyValueMessage(value))
    return writer.data
  }

  private func anyValueMessage(_ value: TelemetryValue) -> Data {
    let writer = ProtoWriter()
    switch value {
    case let .string(text):
      writer.writeString(fieldNumber: 1, value: text)
    case let .bool(flag):
      writer.writeBool(fieldNumber: 2, value: flag)
    case let .int(number):
      writer.writeInt64(fieldNumber: 3, value: number)
    case let .double(number):
      writer.writeDouble(fieldNumber: 4, value: number)
    }
    return writer.data
  }

  private func keyValuesJson(_ values: [String: TelemetryValue]) -> [[String: Any]] {
    values.map { key, value in
      [
        "key": key,
        "value": value.jsonObject(),
      ]
    }
  }

  private func parseTransport(_ raw: Any?) -> TelemetryTransport? {
    guard let doc = raw as? [String: Any] else {
      return nil
    }
    let protocolName = String(describing: doc["protocol"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let endpoint = String(describing: doc["endpoint"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !protocolName.isEmpty, !endpoint.isEmpty else {
      return nil
    }
    return TelemetryTransport(protocolName: protocolName, endpoint: endpoint)
  }

  private func sanitizeAttributes(_ raw: [String: Any]) -> [String: TelemetryValue] {
    var out: [String: TelemetryValue] = [:]
    for (key, value) in raw {
      guard !key.isEmpty else {
        continue
      }
      guard let clean = sanitizeTelemetryValue(value) else {
        continue
      }
      out[key] = clean
    }
    return out
  }

  private func sanitizeTelemetryValue(_ raw: Any?) -> TelemetryValue? {
    switch raw {
    case nil, is NSNull:
      return nil
    case let value as String:
      return .string(value)
    case let value as Bool:
      return .bool(value)
    case let value as NSNumber:
      let type = String(cString: value.objCType)
      if type == "f" || type == "d" {
        let number = value.doubleValue
        return number.isFinite ? .double(number) : nil
      }
      return .int(value.int64Value)
    case let value as [Any]:
      return stableJsonValue(value)
    case let value as [String: Any]:
      return stableJsonValue(value)
    default:
      return .string(String(describing: raw))
    }
  }

  private func stableJsonValue(_ value: Any) -> TelemetryValue? {
    guard JSONSerialization.isValidJSONObject(value) else {
      return .string(String(describing: value))
    }
    guard let data = try? JSONSerialization.data(withJSONObject: value) else {
      return nil
    }
    return .string(String(decoding: data, as: UTF8.self))
  }

  private func parseOptionalString(_ raw: Any?) -> String? {
    switch raw {
    case nil, is NSNull:
      return nil
    case let value as String:
      return value
    default:
      return String(describing: raw)
    }
  }

  private func parseTimeUnixMs(_ raw: Any?) -> Int64 {
    switch raw {
    case let value as NSNumber:
      return value.int64Value
    case let value as String:
      return Int64(value) ?? Int64(Date().timeIntervalSince1970 * 1000)
    default:
      return Int64(Date().timeIntervalSince1970 * 1000)
    }
  }

  private func normalizeLogsEndpoint(_ endpoint: String) -> String {
    let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasSuffix("/v1/logs") {
      return trimmed
    }
    if trimmed.hasSuffix("/") {
      return "\(trimmed)v1/logs"
    }
    return "\(trimmed)/v1/logs"
  }

  private func transportSupported(_ transport: TelemetryTransport) -> Bool {
    let supportedProtocol = transport.protocolName == "http/json" || transport.protocolName == "http/protobuf"
    let supportedEndpoint = transport.endpoint.hasPrefix("http://") || transport.endpoint.hasPrefix("https://")
    return supportedProtocol && supportedEndpoint
  }

  private func severityNumberValue(_ severity: String) -> Int {
    switch severity.lowercased() {
    case "trace":
      return 1
    case "debug":
      return 5
    case "warn", "warning":
      return 13
    case "error":
      return 17
    case "fatal":
      return 21
    default:
      return 9
    }
  }

  private func severityNumberName(_ severity: String) -> String {
    switch severity.lowercased() {
    case "trace":
      return "SEVERITY_NUMBER_TRACE"
    case "debug":
      return "SEVERITY_NUMBER_DEBUG"
    case "warn", "warning":
      return "SEVERITY_NUMBER_WARN"
    case "error":
      return "SEVERITY_NUMBER_ERROR"
    case "fatal":
      return "SEVERITY_NUMBER_FATAL"
    default:
      return "SEVERITY_NUMBER_INFO"
    }
  }
}

struct X07WebView: UIViewRepresentable {
  func makeUIView(context: Context) -> WKWebView {
    let cfg = WKWebViewConfiguration()
    cfg.setURLSchemeHandler(X07SchemeHandler(), forURLScheme: "x07")

    let uc = cfg.userContentController
    uc.add(context.coordinator, name: "ipc")
    uc.addUserScript(
      WKUserScript(
        source: X07WebView.ipcUserScript,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
      )
    )

    let webView = WKWebView(frame: .zero, configuration: cfg)
    webView.navigationDelegate = context.coordinator
    webView.load(URLRequest(url: URL(string: "x07://localhost/index.html")!))
    return webView
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {
    _ = uiView
    _ = context
  }

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  private static let ipcUserScript = """
  globalThis.ipc = {
    postMessage: function (msg) {
      try {
        window.webkit.messageHandlers.ipc.postMessage(String(msg));
      } catch (_) {}
    }
  };
  """

  final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private let telemetry = TelemetryCoordinator()

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      _ = userContentController
      guard let payload = message.body as? String else {
        return
      }
      if !telemetry.handleIpc(payload) {
        NSLog("x07 ipc: %@", payload)
      }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
      if let url = navigationAction.request.url {
        if url.scheme == "x07" || url.absoluteString == "about:blank" {
          decisionHandler(.allow)
          return
        }
      }
      decisionHandler(.cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      _ = webView
      telemetry.emitNativeEvent(
        eventClass: "host.webview_crash",
        name: "host.webview_crash",
        severity: "error",
        attributes: [
          "hook": "ios.webViewWebContentProcessDidTerminate",
        ]
      )
    }
  }
}
