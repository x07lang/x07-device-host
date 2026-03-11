import AVFoundation
import CoreLocation
import CryptoKit
import Foundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import UserNotifications
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

private struct NativeCapabilities {
  let raw: [String: Any]

  static func loadFromBundle() -> NativeCapabilities {
    guard
      let url = Bundle.main.url(forResource: "device.capabilities", withExtension: "json", subdirectory: "x07/profile"),
      let data = try? Data(contentsOf: url),
      let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return NativeCapabilities(raw: [:])
    }
    return NativeCapabilities(raw: raw)
  }

  func allows(_ capability: String) -> Bool {
    guard let device = raw["device"] as? [String: Any] else {
      return false
    }
    switch capability {
    case "audio.playback":
      return ((device["audio"] as? [String: Any])?["playback"] as? Bool) == true
    case "camera.photo":
      return ((device["camera"] as? [String: Any])?["photo"] as? Bool) == true
    case "clipboard.read_text":
      return ((device["clipboard"] as? [String: Any])?["read_text"] as? Bool) == true
    case "clipboard.write_text":
      return ((device["clipboard"] as? [String: Any])?["write_text"] as? Bool) == true
    case "files.pick":
      return ((device["files"] as? [String: Any])?["pick"] as? Bool) == true
    case "files.pick_multiple":
      return ((device["files"] as? [String: Any])?["pick_multiple"] as? Bool) == true
    case "files.save":
      return ((device["files"] as? [String: Any])?["save"] as? Bool) == true
    case "files.drop":
      return ((device["files"] as? [String: Any])?["drop"] as? Bool) == true
    case "blob_store":
      return ((device["blob_store"] as? [String: Any])?["enabled"] as? Bool) == true
    case "haptics.present":
      return ((device["haptics"] as? [String: Any])?["present"] as? Bool) == true
    case "location.foreground":
      return ((device["location"] as? [String: Any])?["foreground"] as? Bool) == true
    case "notifications.local":
      return ((device["notifications"] as? [String: Any])?["local"] as? Bool) == true
    case "share.present":
      return ((device["share"] as? [String: Any])?["present"] as? Bool) == true
    default:
      return false
    }
  }

  func fileAcceptDefaults() -> [String] {
    (((raw["device"] as? [String: Any])?["files"] as? [String: Any])?["accept_defaults"] as? [String]) ?? []
  }
}

private struct BlobManifestDoc: Codable {
  var handle: String
  var sha256: String
  var mime: String
  var byte_size: Int64
  var created_at_ms: Int64
  var source: String
  var local_state: String

  func payload() -> [String: Any] {
    [
      "handle": handle,
      "sha256": sha256,
      "mime": mime,
      "byte_size": byte_size,
      "created_at_ms": created_at_ms,
      "source": source,
      "local_state": local_state,
    ]
  }
}

private struct ExportPayload {
  let filename: String
  let mime: String
  let bytes: Data
  let text: String
  let url: String
}

private struct PendingNativeRequest {
  let bridgeRequestId: String
  let request: [String: Any]
  let startedAt: Date
}

private struct PendingPermissionRequest {
  let permission: String
  let request: PendingNativeRequest
}

private enum NativeBlobStoreError: Error {
  case blobItemTooLarge
  case blobTotalTooLarge
  case io(String)

  var code: String {
    switch self {
    case .blobItemTooLarge:
      return "blob_item_too_large"
    case .blobTotalTooLarge:
      return "blob_total_too_large"
    case .io:
      return "blob_io_error"
    }
  }

  var message: String {
    switch self {
    case .blobItemTooLarge:
      return "blob item exceeds max_item_bytes"
    case .blobTotalTooLarge:
      return "blob store exceeds max_total_bytes"
    case let .io(message):
      return message
    }
  }
}

private final class NativeBlobStore {
  private let fileManager = FileManager.default
  private let dataDir: URL
  private let metaDir: URL
  private let maxTotalBytes: Int64
  private let maxItemBytes: Int64

  init(capabilities: NativeCapabilities) throws {
    let root = try fileManager
      .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("x07/blob_store", isDirectory: true)
    dataDir = root.appendingPathComponent("data", isDirectory: true)
    metaDir = root.appendingPathComponent("meta", isDirectory: true)
    try fileManager.createDirectory(at: dataDir, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: metaDir, withIntermediateDirectories: true)
    let blobStore = ((capabilities.raw["device"] as? [String: Any])?["blob_store"] as? [String: Any]) ?? [:]
    maxTotalBytes = (blobStore["max_total_bytes"] as? NSNumber)?.int64Value ?? 64 * 1024 * 1024
    maxItemBytes = (blobStore["max_item_bytes"] as? NSNumber)?.int64Value ?? 16 * 1024 * 1024
  }

  func put(data: Data, mime: String, source: String) throws -> BlobManifestDoc {
    if Int64(data.count) > maxItemBytes {
      throw NativeBlobStoreError.blobItemTooLarge
    }
    let sha256 = sha256Hex(data)
    if let existing = try readManifest(sha256), existing.local_state == "present", fileManager.fileExists(atPath: blobURL(sha256).path) {
      return existing
    }
    if try totalPresentBytes() + Int64(data.count) > maxTotalBytes {
      throw NativeBlobStoreError.blobTotalTooLarge
    }
    let manifest = BlobManifestDoc(
      handle: "blob:sha256:\(sha256)",
      sha256: sha256,
      mime: mime,
      byte_size: Int64(data.count),
      created_at_ms: unixTimeMs(),
      source: source,
      local_state: "present"
    )
    do {
      try data.write(to: blobURL(sha256), options: .atomic)
      try writeManifest(manifest)
      return manifest
    } catch {
      throw NativeBlobStoreError.io(error.localizedDescription)
    }
  }

  func stat(handle: String) -> BlobManifestDoc {
    guard let sha256 = blobSha(handle) else {
      return missingBlobManifest(handle: handle)
    }
    guard var manifest = try? readManifest(sha256) else {
      return missingBlobManifest(handle: handle)
    }
    if manifest.local_state != "deleted", !fileManager.fileExists(atPath: blobURL(sha256).path) {
      manifest.local_state = "missing"
    }
    return manifest
  }

  func read(handle: String) throws -> (BlobManifestDoc, Data) {
    guard let sha256 = blobSha(handle) else {
      throw NativeBlobStoreError.io("invalid blob handle")
    }
    guard let manifest = try readManifest(sha256) else {
      throw NativeBlobStoreError.io("missing blob manifest")
    }
    return (manifest, try Data(contentsOf: blobURL(sha256)))
  }

  func delete(handle: String) throws -> BlobManifestDoc {
    guard let sha256 = blobSha(handle) else {
      return missingBlobManifest(handle: handle)
    }
    guard var manifest = try readManifest(sha256) else {
      return missingBlobManifest(handle: handle)
    }
    let blobPath = blobURL(sha256).path
    if fileManager.fileExists(atPath: blobPath) {
      do {
        try fileManager.removeItem(at: blobURL(sha256))
      } catch {
        throw NativeBlobStoreError.io(error.localizedDescription)
      }
    }
    manifest.local_state = "deleted"
    try writeManifest(manifest)
    return manifest
  }

  private func totalPresentBytes() throws -> Int64 {
    var total: Int64 = 0
    let items = try fileManager.contentsOfDirectory(at: metaDir, includingPropertiesForKeys: nil)
    for url in items where url.pathExtension == "json" {
      guard let manifest = try readManifest(url.deletingPathExtension().lastPathComponent), manifest.local_state == "present" else {
        continue
      }
      total += manifest.byte_size
    }
    return total
  }

  private func readManifest(_ sha256: String) throws -> BlobManifestDoc? {
    let url = metaURL(sha256)
    guard fileManager.fileExists(atPath: url.path) else {
      return nil
    }
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(BlobManifestDoc.self, from: data)
  }

  private func writeManifest(_ manifest: BlobManifestDoc) throws {
    let data = try JSONEncoder().encode(manifest)
    try data.write(to: metaURL(manifest.sha256), options: .atomic)
  }

  private func blobURL(_ sha256: String) -> URL {
    dataDir.appendingPathComponent("\(sha256).bin")
  }

  private func metaURL(_ sha256: String) -> URL {
    metaDir.appendingPathComponent("\(sha256).json")
  }
}

private func unixTimeMs() -> Int64 {
  Int64(Date().timeIntervalSince1970 * 1000)
}

private func blobSha(_ handle: String) -> String? {
  let prefix = "blob:sha256:"
  guard handle.hasPrefix(prefix) else {
    return nil
  }
  let value = String(handle.dropFirst(prefix.count))
  return value.isEmpty ? nil : value
}

private func missingBlobManifest(handle: String, source: String = "blob_store") -> BlobManifestDoc {
  BlobManifestDoc(
    handle: handle,
    sha256: blobSha(handle) ?? "",
    mime: "application/octet-stream",
    byte_size: 0,
    created_at_ms: 0,
    source: source,
    local_state: "missing"
  )
}

private func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func topViewController(from root: UIViewController?) -> UIViewController? {
  if let nav = root as? UINavigationController {
    return topViewController(from: nav.visibleViewController)
  }
  if let tab = root as? UITabBarController {
    return topViewController(from: tab.selectedViewController)
  }
  if let presented = root?.presentedViewController {
    return topViewController(from: presented)
  }
  return root
}

private func hostViewController(for webView: WKWebView) -> UIViewController? {
  if let root = webView.window?.rootViewController {
    return topViewController(from: root)
  }
  let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
  for scene in scenes {
    if let root = scene.windows.first(where: \.isKeyWindow)?.rootViewController {
      return topViewController(from: root)
    }
  }
  return nil
}

private func utTypes(for accepts: [String]) -> [UTType] {
  let values = accepts.isEmpty ? ["public.data"] : accepts
  var out: [UTType] = []
  for accept in values {
    switch accept {
    case "image/*":
      out.append(.image)
    case "application/pdf":
      out.append(.pdf)
    default:
      if let type = UTType(mimeType: accept) {
        out.append(type)
      } else if let type = UTType(filenameExtension: accept.trimmingCharacters(in: CharacterSet(charactersIn: "."))) {
        out.append(type)
      }
    }
  }
  return out.isEmpty ? [.data] : out
}

private func mimeType(for url: URL) -> String {
  if let values = try? url.resourceValues(forKeys: [.contentTypeKey]), let type = values.contentType {
    return type.preferredMIMEType ?? "application/octet-stream"
  }
  if let type = UTType(filenameExtension: url.pathExtension) {
    return type.preferredMIMEType ?? "application/octet-stream"
  }
  return "application/octet-stream"
}

private func fileEntryPayload(manifest: BlobManifestDoc, url: URL, source: String) -> [String: Any] {
  [
    "name": url.lastPathComponent,
    "path": url.absoluteString,
    "mime": manifest.mime,
    "byte_size": manifest.byte_size,
    "last_modified_ms": 0,
    "source": source,
    "blob": manifest.payload(),
  ]
}

private func jsonValueString(_ value: Any) -> String {
  switch value {
  case is NSNull:
    return "null"
  case let string as String:
    let data = try? JSONEncoder().encode(string)
    return data.map { String(decoding: $0, as: UTF8.self) } ?? "\"\""
  case let bool as Bool:
    return bool ? "true" : "false"
  case let number as NSNumber:
    return number.stringValue
  default:
    if JSONSerialization.isValidJSONObject(value),
       let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    {
      return String(decoding: data, as: UTF8.self)
    }
    return "null"
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
    webView.addInteraction(UIDropInteraction(delegate: context.coordinator))
    context.coordinator.attach(webView: webView)
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

  final class Coordinator: NSObject, CLLocationManagerDelegate, UIDocumentPickerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIDropInteractionDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private let telemetry = TelemetryCoordinator()
    private let capabilities = NativeCapabilities.loadFromBundle()
    private let locationManager = CLLocationManager()
    private let blobStore: NativeBlobStore?
    private var notificationTasks: [String: DispatchWorkItem] = [:]
    private weak var webView: WKWebView?
    private var pendingCameraRequest: PendingNativeRequest?
    private var pendingFileRequest: PendingNativeRequest?
    private var pendingFileSaveRequest: PendingNativeRequest?
    private var pendingExportURL: URL?
    private var pendingExportMime: String = "text/plain;charset=utf-8"
    private var pendingExportBytesLen: Int = 0
    private var pendingLocationRequest: PendingNativeRequest?
    private var pendingLocationTimeout: DispatchWorkItem?
    private var pendingPermissionRequest: PendingPermissionRequest?
    private var pendingCameraCompressionQuality: CGFloat = 0.8

    override init() {
      blobStore = try? NativeBlobStore(capabilities: capabilities)
      super.init()
      locationManager.delegate = self
      locationManager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    func attach(webView: WKWebView) {
      self.webView = webView
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      _ = userContentController
      guard let payload = message.body as? String else {
        return
      }
      if telemetry.handleIpc(payload) {
        return
      }
      guard let webView = message.webView else {
        return
      }
      guard let data = payload.data(using: .utf8) else {
        NSLog("x07 ipc: %@", payload)
        return
      }
      guard
        let raw = try? JSONSerialization.jsonObject(with: data),
        let doc = raw as? [String: Any],
        let kind = doc["kind"] as? String
      else {
        NSLog("x07 ipc: %@", payload)
        return
      }

      switch kind {
      case "x07.device.native.request":
        handleNativeRequest(doc, webView: webView)
      case "x07.device.ui.ready":
        return
      case "x07.device.ui.error":
        telemetry.emitNativeEvent(
          eventClass: "runtime.error",
          name: "bootstrap.error",
          severity: "error",
          attributes: [
            "stage": "ios.ipc",
            "message": String(describing: doc["message"] ?? "ui error"),
          ]
        )
      default:
        NSLog("x07 ipc: %@", payload)
      }
    }

    private func handleNativeRequest(_ doc: [String: Any], webView: WKWebView) {
      self.webView = webView
      let bridgeRequestId = String(describing: doc["bridge_request_id"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !bridgeRequestId.isEmpty else {
        return
      }
      let request = doc["request"] as? [String: Any] ?? [:]
      let family = String(describing: request["family"] ?? "")
      let pending = PendingNativeRequest(bridgeRequestId: bridgeRequestId, request: request, startedAt: Date())
      let capability = String(describing: request["capability"] ?? "")
      if !capability.isEmpty, !capabilities.allows(capability) {
        completeRequest(pending, webView: webView, status: "unsupported", payload: [:], eventClass: "policy.violation", eventName: "device.capability.denied", severity: "warn")
        return
      }

      switch family {
      case "audio":
        let result = handleAudioRequest(request)
        sendBridgeReply(bridgeRequestId, result: result, webView: webView)
        emitRequestTelemetry(request: request, status: resultStatus(result), durationMs: Int64(Date().timeIntervalSince(pending.startedAt) * 1000))
      case "haptics":
        let result = handleHapticsRequest(request)
        sendBridgeReply(bridgeRequestId, result: result, webView: webView)
        emitRequestTelemetry(request: request, status: resultStatus(result), durationMs: Int64(Date().timeIntervalSince(pending.startedAt) * 1000))
      case "permissions":
        handlePermissionsRequest(pending, webView: webView)
      case "camera":
        handleCameraRequest(pending, webView: webView)
      case "clipboard":
        handleClipboardRequest(pending, webView: webView)
      case "files":
        handleFilesRequest(pending, webView: webView)
      case "blobs":
        handleBlobsRequest(pending, webView: webView)
      case "location":
        handleLocationRequest(pending, webView: webView)
      case "notifications":
        let result = handleNotificationsRequest(request, webView: webView)
        sendBridgeReply(bridgeRequestId, result: result, webView: webView)
        emitRequestTelemetry(request: request, status: resultStatus(result), durationMs: Int64(Date().timeIntervalSince(pending.startedAt) * 1000))
      case "share":
        let result = handleShareRequest(request, webView: webView)
        sendBridgeReply(bridgeRequestId, result: result, webView: webView)
        emitRequestTelemetry(request: request, status: resultStatus(result), durationMs: Int64(Date().timeIntervalSince(pending.startedAt) * 1000))
      default:
        let result = nativeBridgeResult(
          family: family,
          request: request,
          status: "unsupported",
          payload: [:]
        )
        sendBridgeReply(bridgeRequestId, result: result, webView: webView)
        emitRequestTelemetry(request: request, status: "unsupported", durationMs: Int64(Date().timeIntervalSince(pending.startedAt) * 1000))
      }
    }

    private func handleAudioRequest(_ request: [String: Any]) -> [String: Any] {
      nativeBridgeResult(
        family: "audio",
        request: request,
        status: "unsupported",
        payload: ["reason": "shared_host_audio"]
      )
    }

    private func handlePermissionsRequest(_ pending: PendingNativeRequest, webView: WKWebView) {
      let payload = pending.request["payload"] as? [String: Any] ?? [:]
      let permission = String(describing: payload["permission"] ?? "")
      let op = String(describing: pending.request["op"] ?? "")
      if op == "permissions.query" {
        queryPermission(permission) { [weak self, weak webView] status, state in
          guard let self, let webView else { return }
          self.completeRequest(
            pending,
            webView: webView,
            status: status,
            payload: [
              "permission": permission,
              "state": state,
            ]
          )
        }
        return
      }

      switch permission {
      case "camera":
        let auth = AVCaptureDevice.authorizationStatus(for: .video)
        switch auth {
        case .authorized:
          completeRequest(pending, webView: webView, status: "ok", payload: ["permission": permission, "state": "granted"])
        case .denied:
          completeRequest(pending, webView: webView, status: "denied", payload: ["permission": permission, "state": "denied"])
        case .restricted:
          completeRequest(pending, webView: webView, status: "denied", payload: ["permission": permission, "state": "restricted"])
        case .notDetermined:
          AVCaptureDevice.requestAccess(for: .video) { [weak self, weak webView] granted in
            DispatchQueue.main.async {
              guard let self, let webView else { return }
              self.completeRequest(
                pending,
                webView: webView,
                status: granted ? "ok" : "denied",
                payload: [
                  "permission": permission,
                  "state": granted ? "granted" : "denied",
                ]
              )
            }
          }
        @unknown default:
          completeRequest(pending, webView: webView, status: "unsupported", payload: ["permission": permission, "state": "unsupported"])
        }
      case "location_foreground":
        let current = Self.locationState()
        switch current {
        case "prompt":
          if pendingPermissionRequest != nil {
            completeRequest(pending, webView: webView, status: "error", payload: ["message": "location permission request already in flight"])
            return
          }
          pendingPermissionRequest = PendingPermissionRequest(permission: permission, request: pending)
          locationManager.requestWhenInUseAuthorization()
        case "granted":
          completeRequest(pending, webView: webView, status: "ok", payload: ["permission": permission, "state": "granted"])
        case "denied":
          completeRequest(pending, webView: webView, status: "denied", payload: ["permission": permission, "state": "denied"])
        case "restricted":
          completeRequest(pending, webView: webView, status: "denied", payload: ["permission": permission, "state": "restricted"])
        default:
          completeRequest(pending, webView: webView, status: "unsupported", payload: ["permission": permission, "state": "unsupported"])
        }
      case "notifications":
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { [weak self, weak webView] granted, _ in
          UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
              guard let self, let webView else { return }
              let state = Self.notificationState(settings.authorizationStatus)
              self.completeRequest(
                pending,
                webView: webView,
                status: granted || state == "granted" ? "ok" : (state == "denied" ? "denied" : "unsupported"),
                payload: [
                  "permission": permission,
                  "state": state,
                ]
              )
            }
          }
        }
      default:
        completeRequest(pending, webView: webView, status: "unsupported", payload: ["permission": permission, "state": "unsupported"])
      }
    }

    private func queryPermission(_ permission: String, completion: @escaping (String, String) -> Void) {
      switch permission {
      case "camera":
        completion("ok", Self.cameraState())
      case "location_foreground":
        completion("ok", Self.locationState())
      case "notifications":
        UNUserNotificationCenter.current().getNotificationSettings { settings in
          completion("ok", Self.notificationState(settings.authorizationStatus))
        }
      default:
        completion("unsupported", "unsupported")
      }
    }

    private func handleClipboardRequest(_ pending: PendingNativeRequest, webView: WKWebView) {
      let op = String(describing: pending.request["op"] ?? "")
      if op == "clipboard.read_text" {
        completeRequest(
          pending,
          webView: webView,
          status: "ok",
          payload: ["text": UIPasteboard.general.string ?? ""]
        )
        return
      }
      let payload = pending.request["payload"] as? [String: Any] ?? [:]
      let text =
        (payload["text"] as? String)
          ?? (payload["value"] as? String)
          ?? ((payload["body"] as? [String: Any])?["text"] as? String)
          ?? ""
      UIPasteboard.general.string = text
      completeRequest(
        pending,
        webView: webView,
        status: "ok",
        payload: ["text_bytes_len": Data(text.utf8).count]
      )
    }

    private func handleCameraRequest(_ pending: PendingNativeRequest, webView: WKWebView) {
      guard capabilities.allows("blob_store"), blobStore != nil else {
        completeRequest(pending, webView: webView, status: "unsupported", payload: ["reason": "blob_store_disabled"])
        return
      }
      guard pendingCameraRequest == nil else {
        completeRequest(pending, webView: webView, status: "error", payload: ["message": "camera request already in flight"])
        return
      }
      guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
        completeRequest(pending, webView: webView, status: "unsupported", payload: [:])
        return
      }
      guard let presenter = hostViewController(for: webView) else {
        completeRequest(pending, webView: webView, status: "error", payload: ["message": "missing host view controller"])
        return
      }
      let payload = pending.request["payload"] as? [String: Any] ?? [:]
      let lens = String(describing: payload["lens"] ?? "rear")
      let quality = String(describing: payload["quality"] ?? "medium")
      pendingCameraCompressionQuality = Self.jpegCompressionQuality(quality)
      pendingCameraRequest = pending
      let picker = UIImagePickerController()
      picker.delegate = self
      picker.sourceType = .camera
      picker.mediaTypes = ["public.image"]
      if lens == "front", UIImagePickerController.isCameraDeviceAvailable(.front) {
        picker.cameraDevice = .front
      } else {
        picker.cameraDevice = .rear
      }
      presenter.present(picker, animated: true)
    }

    private func handleFilesRequest(_ pending: PendingNativeRequest, webView: WKWebView) {
      let payload = pending.request["payload"] as? [String: Any] ?? [:]
      switch String(describing: pending.request["op"] ?? "files.pick") {
      case "files.save":
        handleFileSaveRequest(pending, webView: webView)
      case "files.pick_multiple":
        handleFilePickRequest(pending, webView: webView, multiple: true)
      default:
        handleFilePickRequest(
          pending,
          webView: webView,
          multiple: (payload["multiple"] as? Bool) == true || ((payload["multiple"] as? NSNumber)?.boolValue == true)
        )
      }
    }

    private func handleFilePickRequest(_ pending: PendingNativeRequest, webView: WKWebView, multiple: Bool) {
      guard capabilities.allows("blob_store"), blobStore != nil else {
        completeRequest(pending, webView: webView, status: "unsupported", payload: ["reason": "blob_store_disabled"])
        return
      }
      guard pendingFileRequest == nil else {
        completeRequest(pending, webView: webView, status: "error", payload: ["message": "file picker already in flight"])
        return
      }
      guard let presenter = hostViewController(for: webView) else {
        completeRequest(pending, webView: webView, status: "error", payload: ["message": "missing host view controller"])
        return
      }
      let payload = pending.request["payload"] as? [String: Any] ?? [:]
      let accepts = (payload["accept"] as? [String]) ?? capabilities.fileAcceptDefaults()
      pendingFileRequest = pending
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: utTypes(for: accepts), asCopy: true)
      picker.allowsMultipleSelection = multiple
      picker.delegate = self
      presenter.present(picker, animated: true)
    }

    private func handleFileSaveRequest(_ pending: PendingNativeRequest, webView: WKWebView) {
      guard pendingFileSaveRequest == nil else {
        completeRequest(pending, webView: webView, status: "error", payload: ["message": "file save already in flight"])
        return
      }
      let payload = pending.request["payload"] as? [String: Any] ?? [:]
      let export: ExportPayload
      do {
        export = try resolveExportPayload(kind: String(describing: pending.request["kind"] ?? ""), payload: payload)
      } catch let error as NativeBlobStoreError {
        completeRequest(pending, webView: webView, status: "error", payload: ["reason": error.code, "message": error.message])
        return
      } catch {
        completeRequest(pending, webView: webView, status: "error", payload: ["reason": "invalid_request", "message": error.localizedDescription])
        return
      }
      let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(export.filename)
      do {
        try export.bytes.write(to: tempURL, options: .atomic)
      } catch {
        completeRequest(pending, webView: webView, status: "error", payload: ["message": error.localizedDescription])
        return
      }
      guard let presenter = hostViewController(for: webView) else {
        completeRequest(pending, webView: webView, status: "error", payload: ["message": "missing host view controller"])
        return
      }
      pendingFileSaveRequest = pending
      pendingExportURL = tempURL
      pendingExportMime = export.mime
      pendingExportBytesLen = export.bytes.count
      let picker = UIDocumentPickerViewController(forExporting: [tempURL], asCopy: true)
      picker.delegate = self
      presenter.present(picker, animated: true)
    }

    private func importPickedURLs(_ urls: [URL], source: String) -> (String, [String: Any]) {
      guard let blobStore else {
        return ("unsupported", ["reason": "blob_store_disabled"])
      }
      var blobs: [[String: Any]] = []
      var files: [[String: Any]] = []
      var errors: [[String: Any]] = []
      for url in urls {
        let accessed = url.startAccessingSecurityScopedResource()
        defer {
          if accessed {
            url.stopAccessingSecurityScopedResource()
          }
        }
        do {
          let data = try Data(contentsOf: url)
          let manifest = try blobStore.put(data: data, mime: mimeType(for: url), source: source)
          blobs.append(manifest.payload())
          files.append(fileEntryPayload(manifest: manifest, url: url, source: source))
        } catch let error as NativeBlobStoreError {
          errors.append([
            "code": error.code,
            "message": error.message,
            "path": url.absoluteString,
          ])
        } catch {
          errors.append([
            "code": "file_import_failed",
            "message": error.localizedDescription,
            "path": url.absoluteString,
          ])
        }
      }
      var payload: [String: Any] = [
        "blobs": blobs,
        "files": files,
        "accepted_count": files.count,
        "rejected_count": errors.count,
      ]
      if urls.count == 1, let first = urls.first {
        payload["path"] = first.absoluteString
      }
      if !errors.isEmpty {
        payload["errors"] = errors
        if !files.isEmpty {
          payload["partial"] = true
        }
      }
      return files.isEmpty ? ("error", payload) : ("ok", payload)
    }

    private func resolveExportPayload(kind: String, payload: [String: Any]) throws -> ExportPayload {
      let defaultFilename = kind == "x07.web_ui.effect.device.files.save_json" ? "export.json" : "export.txt"
      let defaultMime = kind == "x07.web_ui.effect.device.files.save_json" ? "application/json" : "text/plain;charset=utf-8"
      let filename =
        (payload["filename"] as? String)
          ?? (payload["name"] as? String)
          ?? (payload["suggested_name"] as? String)
          ?? defaultFilename
      let requestMime =
        ((payload["mime"] as? String) ?? (payload["content_type"] as? String) ?? defaultMime)
          .isEmpty ? defaultMime : ((payload["mime"] as? String) ?? (payload["content_type"] as? String) ?? defaultMime)
      let blobHandle =
        ((payload["blob_handle"] as? String) ?? (payload["handle"] as? String) ?? "")
          .trimmingCharacters(in: .whitespacesAndNewlines)
      if !blobHandle.isEmpty {
        guard let blobStore else {
          throw NativeBlobStoreError.io("blob store unavailable")
        }
        let (manifest, data) = try blobStore.read(handle: blobHandle)
        return ExportPayload(filename: filename, mime: manifest.mime.isEmpty ? requestMime : manifest.mime, bytes: data, text: "", url: "")
      }
      if kind == "x07.web_ui.effect.device.files.save_json" {
        let jsonValue = payload["value"] ?? payload["json"] ?? NSNull()
        let text = "\(jsonValueString(jsonValue))\n"
        return ExportPayload(
          filename: filename,
          mime: requestMime,
          bytes: Data(text.utf8),
          text: text,
          url: ""
        )
      }
      let text =
        (payload["text"] as? String)
          ?? (payload["value"] as? String)
          ?? ((payload["body"] as? [String: Any])?["text"] as? String)
          ?? ""
      let url = (payload["url"] as? String) ?? (payload["href"] as? String) ?? ""
      let body = text.isEmpty ? url : text
      guard !body.isEmpty else {
        throw NSError(domain: "x07.device.host", code: 1, userInfo: [NSLocalizedDescriptionKey: "request payload missing text/url/blob_handle"])
      }
      return ExportPayload(
        filename: filename,
        mime: requestMime,
        bytes: Data(body.utf8),
        text: text,
        url: url
      )
    }

    private func handleBlobsRequest(_ pending: PendingNativeRequest, webView: WKWebView) {
      guard let blobStore else {
        completeRequest(pending, webView: webView, status: "unsupported", payload: ["reason": "blob_store_disabled"])
        return
      }
      let payload = pending.request["payload"] as? [String: Any] ?? [:]
      let handle = String(describing: payload["handle"] ?? "")
      let op = String(describing: pending.request["op"] ?? "")
      if op == "blobs.delete" {
        do {
          let blob = try blobStore.delete(handle: handle)
          completeRequest(pending, webView: webView, status: "ok", payload: ["blob": blob.payload()])
        } catch let error as NativeBlobStoreError {
          completeRequest(pending, webView: webView, status: "error", payload: ["reason": error.code, "message": error.message])
        } catch {
          completeRequest(pending, webView: webView, status: "error", payload: ["message": error.localizedDescription])
        }
      } else {
        let blob = blobStore.stat(handle: handle)
        completeRequest(pending, webView: webView, status: "ok", payload: ["blob": blob.payload()])
      }
    }

    private func handleLocationRequest(_ pending: PendingNativeRequest, webView: WKWebView) {
      guard CLLocationManager.locationServicesEnabled() else {
        completeRequest(pending, webView: webView, status: "unsupported", payload: [:])
        return
      }
      let state = Self.locationState()
      guard state == "granted" else {
        completeRequest(
          pending,
          webView: webView,
          status: state == "prompt" ? "denied" : (state == "denied" ? "denied" : "unsupported"),
          payload: [:]
        )
        return
      }
      guard pendingLocationRequest == nil else {
        completeRequest(pending, webView: webView, status: "error", payload: ["message": "location request already in flight"])
        return
      }
      pendingLocationRequest = pending
      let payload = pending.request["payload"] as? [String: Any] ?? [:]
      let timeoutMs = (payload["timeout_ms"] as? NSNumber)?.intValue ?? 10_000
      let timeoutWork = DispatchWorkItem { [weak self, weak webView] in
        guard let self, let webView, let pending = self.pendingLocationRequest else { return }
        self.pendingLocationRequest = nil
        self.pendingLocationTimeout = nil
        self.completeRequest(pending, webView: webView, status: "timeout", payload: [:])
      }
      pendingLocationTimeout = timeoutWork
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(max(timeoutMs, 0)), execute: timeoutWork)
      locationManager.requestLocation()
    }

    private func handleNotificationsRequest(_ request: [String: Any], webView: WKWebView) -> [String: Any] {
      let payload = request["payload"] as? [String: Any] ?? [:]
      let notificationId = String(
        describing: payload["notification_id"] ?? payload["id"] ?? request["request_id"] ?? ""
      ).trimmingCharacters(in: .whitespacesAndNewlines)

      if String(describing: request["op"] ?? "") == "notifications.cancel" {
        notificationTasks[notificationId]?.cancel()
        notificationTasks.removeValue(forKey: notificationId)
        return nativeBridgeResult(
          family: "notifications",
          request: request,
          status: "ok",
          payload: ["notification_id": notificationId]
        )
      }

      let delayMs = (payload["delay_ms"] as? NSNumber)?.intValue ?? 0
      notificationTasks[notificationId]?.cancel()
      let workItem = DispatchWorkItem { [weak self, weak webView] in
        guard let self, let webView else {
          return
        }
        self.telemetry.emitNativeEvent(
          eventClass: "app.lifecycle",
          name: "notification.opened",
          severity: "info",
          attributes: [
            "notification_id": notificationId,
          ]
        )
        self.evaluateBridgeHook(
          "__x07DispatchDeviceEvent",
          payload: [
            "type": "notification.opened",
            "notification_id": notificationId,
          ],
          webView: webView
        )
      }
      notificationTasks[notificationId] = workItem
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(max(delayMs, 0)), execute: workItem)
      return nativeBridgeResult(
        family: "notifications",
        request: request,
        status: "ok",
        payload: ["notification_id": notificationId]
      )
    }

    private func handleHapticsRequest(_ request: [String: Any]) -> [String: Any] {
      let payload = request["payload"] as? [String: Any] ?? [:]
      let pattern = String(describing: payload["pattern"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      switch pattern {
      case "selection":
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
      case "impact":
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.prepare()
        generator.impactOccurred()
      case "victory":
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.success)
      case "defeat":
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.error)
      default:
        return nativeBridgeResult(
          family: "haptics",
          request: request,
          status: "error",
          payload: [
            "reason": "invalid_pattern",
            "pattern": pattern,
          ]
        )
      }
      return nativeBridgeResult(
        family: "haptics",
        request: request,
        status: "ok",
        payload: ["pattern": pattern]
      )
    }

    private func handleShareRequest(_ request: [String: Any], webView: WKWebView) -> [String: Any] {
      guard let presenter = hostViewController(for: webView) else {
        return nativeBridgeResult(
          family: "share",
          request: request,
          status: "error",
          payload: ["message": "missing host view controller"]
        )
      }
      let payload = request["payload"] as? [String: Any] ?? [:]
      let kind = String(describing: request["kind"] ?? "")
      if kind == "x07.web_ui.effect.device.share.share_files" {
        guard let blobStore else {
          return nativeBridgeResult(
            family: "share",
            request: request,
            status: "unsupported",
            payload: ["reason": "blob_store_unavailable"]
          )
        }
        let rawItems = (payload["items"] as? [[String: Any]]) ?? (payload["blobs"] as? [[String: Any]]) ?? []
        guard !rawItems.isEmpty else {
          return nativeBridgeResult(
            family: "share",
            request: request,
            status: "error",
            payload: ["reason": "invalid_request", "message": "share_files requires at least one item"]
          )
        }
        var activityItems: [Any] = []
        var normalizedItems: [[String: Any]] = []
        for (index, rawItem) in rawItems.enumerated() {
          let blobDoc = (rawItem["blob"] as? [String: Any]) ?? rawItem
          let handle =
            ((blobDoc["handle"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
          guard !handle.isEmpty else {
            return nativeBridgeResult(
              family: "share",
              request: request,
              status: "error",
              payload: ["reason": "invalid_request", "message": "share file item missing blob.handle"]
            )
          }
          let manifest: BlobManifestDoc
          let data: Data
          do {
            (manifest, data) = try blobStore.read(handle: handle)
          } catch let error as NativeBlobStoreError {
            return nativeBridgeResult(
              family: "share",
              request: request,
              status: "error",
              payload: ["reason": error.code, "message": error.message]
            )
          } catch {
            return nativeBridgeResult(
              family: "share",
              request: request,
              status: "error",
              payload: ["message": error.localizedDescription]
            )
          }
          let name = ((rawItem["name"] as? String) ?? "").isEmpty ? "file-\(index + 1)" : String(describing: rawItem["name"] ?? "")
          let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(name)
          do {
            try data.write(to: tempURL, options: .atomic)
            activityItems.append(tempURL)
            normalizedItems.append([
              "name": name,
              "mime": manifest.mime,
              "byte_size": manifest.byte_size,
              "blob": manifest.payload(),
            ])
          } catch {
            return nativeBridgeResult(
              family: "share",
              request: request,
              status: "error",
              payload: ["message": error.localizedDescription]
            )
          }
        }
        let activity = UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
        if let title = (payload["title"] as? String) ?? (payload["subject"] as? String), !title.isEmpty {
          activity.setValue(title, forKey: "subject")
        }
        presenter.present(activity, animated: true)
        return nativeBridgeResult(
          family: "share",
          request: request,
          status: "ok",
          payload: ["items": normalizedItems]
        )
      }
      let export: ExportPayload
      do {
        export = try resolveExportPayload(kind: kind, payload: payload)
      } catch let error as NativeBlobStoreError {
        return nativeBridgeResult(
          family: "share",
          request: request,
          status: "error",
          payload: ["reason": error.code, "message": error.message]
        )
      } catch {
        return nativeBridgeResult(
          family: "share",
          request: request,
          status: "error",
          payload: ["reason": "invalid_request", "message": error.localizedDescription]
        )
      }

      var items: [Any] = []
      if !export.text.isEmpty {
        items.append(export.text)
      }
      if !export.url.isEmpty, let url = URL(string: export.url) {
        items.append(url)
      }
      if items.isEmpty {
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(export.filename)
        do {
          try export.bytes.write(to: tempURL, options: .atomic)
          items.append(tempURL)
        } catch {
          return nativeBridgeResult(
            family: "share",
            request: request,
            status: "error",
            payload: ["message": error.localizedDescription]
          )
        }
      }

      let activity = UIActivityViewController(activityItems: items, applicationActivities: nil)
      if let title = (payload["title"] as? String) ?? (payload["subject"] as? String), !title.isEmpty {
        activity.setValue(title, forKey: "subject")
      }
      presenter.present(activity, animated: true)
      return nativeBridgeResult(
        family: "share",
        request: request,
        status: "ok",
        payload: [
          "shared": true,
          "bytes_len": export.bytes.count,
          "mime": export.mime,
        ]
      )
    }

    private func nativeBridgeResult(
      family: String,
      request: [String: Any],
      status: String,
      payload: [String: Any]
    ) -> [String: Any] {
      [
        "family": family,
        "result": [
          "request_id": String(describing: request["request_id"] ?? ""),
          "op": String(describing: request["op"] ?? ""),
          "capability": String(describing: request["capability"] ?? ""),
          "status": status,
          "payload": payload,
          "host_meta": [
            "platform": "ios",
            "provider": "ios_native",
          ],
        ],
      ]
    }

    private func resultStatus(_ result: [String: Any]) -> String {
      ((result["result"] as? [String: Any])?["status"] as? String) ?? "error"
    }

    private func sendBridgeReply(_ bridgeRequestId: String, result: [String: Any], webView: WKWebView) {
      evaluateBridgeHook(
        "__x07ReceiveDeviceReply",
        payload: [
          "bridge_request_id": bridgeRequestId,
          "result": result,
        ],
        webView: webView
      )
    }

    private func completeRequest(
      _ pending: PendingNativeRequest,
      webView: WKWebView,
      status: String,
      payload: [String: Any],
      eventClass: String? = nil,
      eventName: String? = nil,
      severity: String? = nil
    ) {
      let family = String(describing: pending.request["family"] ?? "")
      let result = nativeBridgeResult(family: family, request: pending.request, status: status, payload: payload)
      sendBridgeReply(pending.bridgeRequestId, result: result, webView: webView)
      emitRequestTelemetry(
        request: pending.request,
        status: status,
        durationMs: Int64(Date().timeIntervalSince(pending.startedAt) * 1000),
        eventClass: eventClass,
        eventName: eventName,
        severity: severity
      )
    }

    private func emitRequestTelemetry(
      request: [String: Any],
      status: String,
      durationMs: Int64,
      eventClass: String? = nil,
      eventName: String? = nil,
      severity: String? = nil
    ) {
      telemetry.emitNativeEvent(
        eventClass: eventClass ?? (status == "error" ? "runtime.error" : "bridge.timing"),
        name: eventName ?? requestTelemetryName(request: request, status: status),
        severity: severity ?? (status == "error" ? "error" : "info"),
        attributes: [
          "x07.device.op": String(describing: request["op"] ?? ""),
          "x07.device.request_id": String(describing: request["request_id"] ?? ""),
          "x07.device.status": status,
          "x07.device.capability": String(describing: request["capability"] ?? ""),
          "x07.device.platform": "ios",
          "x07.device.duration_ms": durationMs,
        ]
      )
    }

    private func requestTelemetryName(request: [String: Any], status: String) -> String {
      switch String(describing: request["op"] ?? "") {
      case "audio.play":
        return "device.audio.play"
      case "audio.stop":
        return "device.audio.stop"
      case "haptics.trigger":
        return "device.haptics.trigger"
      default:
        return status == "error" ? "device.op.error" : "device.op.result"
      }
    }

    private func emitDropEvent(urls: [URL], preloadErrors: [[String: Any]] = []) {
      guard let webView else {
        return
      }
      let startedAt = Date()
      DispatchQueue.global(qos: .userInitiated).async { [weak self, weak webView] in
        guard let self, let webView else { return }
        var (status, payload) = self.importPickedURLs(urls, source: "files.drop")
        var errors = preloadErrors
        if let payloadErrors = payload["errors"] as? [[String: Any]] {
          errors.append(contentsOf: payloadErrors)
        }
        if !errors.isEmpty {
          payload["errors"] = errors
          if (payload["accepted_count"] as? Int ?? 0) > 0 {
            payload["partial"] = true
          } else {
            status = "error"
          }
        }
        self.telemetry.emitNativeEvent(
          eventClass: status == "error" ? "runtime.error" : "bridge.timing",
          name: "device.files.drop",
          severity: status == "error" ? "error" : "info",
          attributes: [
            "x07.device.op": "files.drop",
            "x07.device.request_id": "",
            "x07.device.status": status,
            "x07.device.capability": "files.drop",
            "x07.device.platform": "ios",
            "x07.device.duration_ms": Int64(Date().timeIntervalSince(startedAt) * 1000),
            "x07.device.accepted_count": payload["accepted_count"] as? Int ?? 0,
            "x07.device.rejected_count": payload["rejected_count"] as? Int ?? 0,
          ]
        )
        DispatchQueue.main.async {
          self.evaluateBridgeHook(
            "__x07DispatchDeviceEvent",
            payload: [
              "type": "files.drop",
              "status": status,
              "source": "ios",
              "files": payload["files"] ?? [],
              "blobs": payload["blobs"] ?? [],
              "accepted_count": payload["accepted_count"] ?? 0,
              "rejected_count": payload["rejected_count"] ?? 0,
              "errors": payload["errors"] ?? [],
              "partial": payload["partial"] ?? false,
            ],
            webView: webView
          )
        }
      }
    }

    private func evaluateBridgeHook(_ hookName: String, payload: [String: Any], webView: WKWebView) {
      guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
        return
      }
      let json = String(decoding: data, as: UTF8.self)
      webView.evaluateJavaScript("globalThis.\(hookName)?.(\(json));")
    }

    func dropInteraction(_ interaction: UIDropInteraction, canHandle session: UIDropSession) -> Bool {
      _ = interaction
      guard capabilities.allows("files.drop"), capabilities.allows("blob_store") else {
        return false
      }
      return session.items.contains { item in
        item.itemProvider.canLoadObject(ofClass: NSURL.self)
      }
    }

    func dropInteraction(_ interaction: UIDropInteraction, sessionDidUpdate session: UIDropSession) -> UIDropProposal {
      _ = interaction
      _ = session
      UIDropProposal(operation: .copy)
    }

    func dropInteraction(_ interaction: UIDropInteraction, performDrop session: UIDropSession) {
      _ = interaction
      let providers = session.items.map(\.itemProvider).filter { $0.canLoadObject(ofClass: NSURL.self) }
      guard !providers.isEmpty else {
        return
      }
      let group = DispatchGroup()
      let lock = NSLock()
      var urls: [URL] = []
      var errors: [[String: Any]] = []
      for provider in providers {
        group.enter()
        provider.loadObject(ofClass: NSURL.self) { object, error in
          lock.lock()
          defer {
            lock.unlock()
            group.leave()
          }
          if let url = object as? URL {
            urls.append(url)
          } else if let error {
            errors.append([
              "code": "file_drop_failed",
              "message": error.localizedDescription,
            ])
          }
        }
      }
      group.notify(queue: .main) { [weak self] in
        self?.emitDropEvent(urls: urls, preloadErrors: errors)
      }
    }

    private static func cameraState() -> String {
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized:
        return "granted"
      case .denied:
        return "denied"
      case .restricted:
        return "restricted"
      case .notDetermined:
        return "prompt"
      @unknown default:
        return "unsupported"
      }
    }

    private static func locationState() -> String {
      switch CLLocationManager().authorizationStatus {
      case .authorizedAlways, .authorizedWhenInUse:
        return "granted"
      case .denied:
        return "denied"
      case .restricted:
        return "restricted"
      case .notDetermined:
        return "prompt"
      @unknown default:
        return "unsupported"
      }
    }

    private static func notificationState(_ status: UNAuthorizationStatus) -> String {
      switch status {
      case .authorized, .provisional, .ephemeral:
        return "granted"
      case .denied:
        return "denied"
      case .notDetermined:
        return "prompt"
      @unknown default:
        return "unsupported"
      }
    }

    private static func jpegCompressionQuality(_ quality: String) -> CGFloat {
      switch quality {
      case "low":
        return 0.5
      case "high":
        return 0.92
      default:
        return 0.75
      }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
      _ = manager
      guard let pendingPermissionRequest, pendingPermissionRequest.permission == "location_foreground", let webView else {
        return
      }
      let state = Self.locationState()
      guard state != "prompt" else {
        return
      }
      self.pendingPermissionRequest = nil
      let status = state == "granted" ? "ok" : (state == "denied" || state == "restricted" ? "denied" : "unsupported")
      completeRequest(
        pendingPermissionRequest.request,
        webView: webView,
        status: status,
        payload: [
          "permission": pendingPermissionRequest.permission,
          "state": state,
        ]
      )
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
      _ = manager
      guard let pending = pendingLocationRequest, let webView, let location = locations.last else {
        return
      }
      pendingLocationTimeout?.cancel()
      pendingLocationTimeout = nil
      pendingLocationRequest = nil
      var payload: [String: Any] = [
        "latitude": location.coordinate.latitude,
        "longitude": location.coordinate.longitude,
        "accuracy_m": location.horizontalAccuracy,
        "captured_at_ms": unixTimeMs(),
      ]
      if location.verticalAccuracy >= 0 {
        payload["altitude_m"] = location.altitude
      }
      completeRequest(pending, webView: webView, status: "ok", payload: payload)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
      _ = manager
      guard let pending = pendingLocationRequest, let webView else {
        return
      }
      pendingLocationTimeout?.cancel()
      pendingLocationTimeout = nil
      pendingLocationRequest = nil
      let status = (error as? CLError)?.code == .denied ? "denied" : "error"
      completeRequest(
        pending,
        webView: webView,
        status: status,
        payload: status == "error" ? ["message": error.localizedDescription] : [:]
      )
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
      controller.dismiss(animated: true)
      if let pending = pendingFileSaveRequest, let webView {
        pendingFileSaveRequest = nil
        if let pendingExportURL {
          try? FileManager.default.removeItem(at: pendingExportURL)
        }
        pendingExportURL = nil
        pendingExportMime = "text/plain;charset=utf-8"
        pendingExportBytesLen = 0
        completeRequest(pending, webView: webView, status: "cancelled", payload: [:])
        return
      }
      guard let pending = pendingFileRequest, let webView else {
        return
      }
      pendingFileRequest = nil
      completeRequest(pending, webView: webView, status: "cancelled", payload: [:])
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
      controller.dismiss(animated: true)
      if let pending = pendingFileSaveRequest, let webView {
        pendingFileSaveRequest = nil
        let pendingURL = pendingExportURL
        defer {
          if let pendingURL {
            try? FileManager.default.removeItem(at: pendingURL)
          }
          pendingExportURL = nil
          pendingExportMime = "text/plain;charset=utf-8"
          pendingExportBytesLen = 0
        }
        let exportedURL = urls.first ?? pendingURL
        completeRequest(
          pending,
          webView: webView,
          status: exportedURL == nil ? "cancelled" : "ok",
          payload: exportedURL == nil
            ? [:]
            : [
                "filename": pendingURL?.lastPathComponent ?? "export.txt",
                "mime": pendingExportMime,
                "bytes_len": pendingExportBytesLen,
                "path": exportedURL?.absoluteString ?? "",
              ]
        )
        return
      }
      guard let pending = pendingFileRequest, let webView else {
        return
      }
      pendingFileRequest = nil
      guard !urls.isEmpty else {
        completeRequest(pending, webView: webView, status: "cancelled", payload: [:])
        return
      }
      let (status, payload) = importPickedURLs(urls, source: "files.pick")
      completeRequest(pending, webView: webView, status: status, payload: payload)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
      picker.dismiss(animated: true)
      guard let pending = pendingCameraRequest, let webView else {
        return
      }
      pendingCameraRequest = nil
      completeRequest(pending, webView: webView, status: "cancelled", payload: [:])
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      picker.dismiss(animated: true)
      guard let pending = pendingCameraRequest, let webView else {
        return
      }
      pendingCameraRequest = nil
      guard
        let blobStore,
        let image = info[.originalImage] as? UIImage,
        let data = image.jpegData(compressionQuality: pendingCameraCompressionQuality)
      else {
        completeRequest(pending, webView: webView, status: "error", payload: ["message": "camera capture failed"])
        return
      }
      do {
        let manifest = try blobStore.put(data: data, mime: "image/jpeg", source: "camera")
        completeRequest(
          pending,
          webView: webView,
          status: "ok",
          payload: [
            "blob": manifest.payload(),
            "image": [
              "width": Int(image.size.width.rounded()),
              "height": Int(image.size.height.rounded()),
            ],
          ]
        )
      } catch let error as NativeBlobStoreError {
        completeRequest(pending, webView: webView, status: "error", payload: ["reason": error.code, "message": error.message])
      } catch {
        completeRequest(pending, webView: webView, status: "error", payload: ["message": error.localizedDescription])
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
