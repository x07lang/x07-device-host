package org.x07.deviceapp

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.OpenableColumns
import android.util.Log
import android.view.DragEvent
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import androidx.core.os.CancellationSignal
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.Executors

private const val TELEMETRY_SCOPE_NAME = "x07.device.host"
private const val TELEMETRY_SCOPE_VERSION = "__X07_VERSION__"

private data class TelemetryTransport(
  val protocol: String,
  val endpoint: String,
)

private data class TelemetryEvent(
  val eventClass: String,
  val name: String,
  val timeUnixMs: Long,
  val severity: String,
  val body: String?,
  val attributes: Map<String, Any>,
)

private data class TelemetryEnvelope(
  val transport: TelemetryTransport,
  val resource: Map<String, Any>,
  val event: TelemetryEvent,
)

private data class TelemetryRuntimeConfig(
  val transport: TelemetryTransport,
  val resource: Map<String, Any>,
  val eventClasses: Set<String>,
)

private class ProtoWriter {
  private val out = ByteArrayOutputStream()

  fun writeMessage(fieldNumber: Int, payload: ByteArray) {
    writeTag(fieldNumber, 2)
    writeVarint(payload.size.toULong())
    out.write(payload)
  }

  fun writeString(fieldNumber: Int, value: String) {
    writeMessage(fieldNumber, value.toByteArray(Charsets.UTF_8))
  }

  fun writeBool(fieldNumber: Int, value: Boolean) {
    writeTag(fieldNumber, 0)
    writeVarint(if (value) 1UL else 0UL)
  }

  fun writeInt64(fieldNumber: Int, value: Long) {
    writeTag(fieldNumber, 0)
    writeVarint(value.toULong())
  }

  fun writeEnum(fieldNumber: Int, value: Int) {
    writeTag(fieldNumber, 0)
    writeVarint(value.toULong())
  }

  fun writeFixed64(fieldNumber: Int, value: Long) {
    writeTag(fieldNumber, 1)
    out.write(
      ByteBuffer
        .allocate(8)
        .order(ByteOrder.LITTLE_ENDIAN)
        .putLong(value)
        .array(),
    )
  }

  fun writeFixed32(fieldNumber: Int, value: Int) {
    writeTag(fieldNumber, 5)
    out.write(
      ByteBuffer
        .allocate(4)
        .order(ByteOrder.LITTLE_ENDIAN)
        .putInt(value)
        .array(),
    )
  }

  fun writeDouble(fieldNumber: Int, value: Double) {
    writeTag(fieldNumber, 1)
    out.write(
      ByteBuffer
        .allocate(8)
        .order(ByteOrder.LITTLE_ENDIAN)
        .putLong(java.lang.Double.doubleToRawLongBits(value))
        .array(),
    )
  }

  fun toByteArray(): ByteArray = out.toByteArray()

  private fun writeTag(fieldNumber: Int, wireType: Int) {
    writeVarint(((fieldNumber shl 3) or wireType).toULong())
  }

  private fun writeVarint(value: ULong) {
    var next = value
    while (true) {
      if (next and 0x7FUL == next) {
        out.write(next.toInt())
        return
      }
      out.write(((next and 0x7FUL) or 0x80UL).toInt())
      next = next shr 7
    }
  }
}

private class X07TelemetryCoordinator {
  private val executor = Executors.newSingleThreadExecutor()

  @Volatile
  private var runtime: TelemetryRuntimeConfig? = null

  fun handleIpc(msg: String): Boolean {
    val doc = try {
      JSONObject(msg)
    } catch (_: Exception) {
      return false
    }
    return when (doc.optString("kind")) {
      "x07.device.telemetry.configure" -> {
        configure(doc)
        true
      }
      "x07.device.telemetry.event" -> {
        parseEnvelope(doc)?.let(::exportEnvelope)
        true
      }
      else -> false
    }
  }

  fun emitNativeEvent(
    eventClass: String,
    name: String,
    severity: String,
    attributes: Map<String, Any>,
    body: String? = null,
  ) {
    val active = runtime ?: return
    if (!active.eventClasses.contains(eventClass)) return
    exportEnvelope(
      TelemetryEnvelope(
        transport = active.transport,
        resource = active.resource,
        event =
          TelemetryEvent(
            eventClass = eventClass,
            name = name,
            timeUnixMs = System.currentTimeMillis(),
            severity = severity,
            body = body,
            attributes = attributes,
          ),
      ),
    )
  }

  private fun configure(doc: JSONObject) {
    val transport = parseTransport(doc.optJSONObject("transport")) ?: return
    if (!transportSupported(transport)) return
    val eventClasses = jsonArrayToStrings(doc.optJSONArray("event_classes"))
    runtime =
      TelemetryRuntimeConfig(
        transport = transport,
        resource = sanitizeAttributes(doc.optJSONObject("resource")),
        eventClasses = eventClasses,
      )
  }

  private fun parseEnvelope(doc: JSONObject): TelemetryEnvelope? {
    val transport = parseTransport(doc.optJSONObject("transport")) ?: return null
    if (!transportSupported(transport)) return null
    val eventDoc = doc.optJSONObject("event") ?: return null
    val eventClass = eventDoc.optString("class", "").trim()
    val name = eventDoc.optString("name", "").trim()
    if (eventClass.isEmpty() || name.isEmpty()) return null
    return TelemetryEnvelope(
      transport = transport,
      resource = sanitizeAttributes(doc.optJSONObject("resource")),
      event =
        TelemetryEvent(
          eventClass = eventClass,
          name = name,
          timeUnixMs = parseTimeUnixMs(eventDoc.opt("time_unix_ms")),
          severity = eventDoc.optString("severity", "info"),
          body = parseOptionalString(eventDoc.opt("body")),
          attributes = sanitizeAttributes(eventDoc.optJSONObject("attributes")),
        ),
    )
  }

  private fun exportEnvelope(envelope: TelemetryEnvelope) {
    if (!transportSupported(envelope.transport)) return
    val endpoint = normalizeLogsEndpoint(envelope.transport.endpoint)
    executor.execute {
      try {
        val payload =
          when (envelope.transport.protocol) {
            "http/json" -> buildJsonRequest(envelope).toString().toByteArray(Charsets.UTF_8)
            "http/protobuf" -> buildProtobufRequest(envelope)
            else -> return@execute
          }
        val conn = (URL(endpoint).openConnection() as HttpURLConnection)
        conn.requestMethod = "POST"
        conn.connectTimeout = 5000
        conn.readTimeout = 5000
        conn.doOutput = true
        conn.setRequestProperty(
          "Content-Type",
          if (envelope.transport.protocol == "http/protobuf") {
            "application/x-protobuf"
          } else {
            "application/json"
          },
        )
        conn.outputStream.use { it.write(payload) }
        conn.inputStream.use { it.copyTo(ByteArrayOutputStream()) }
        conn.disconnect()
      } catch (err: Exception) {
        Log.e("x07", "telemetry export failed", err)
      }
    }
  }

  private fun buildJsonRequest(envelope: TelemetryEnvelope): JSONObject {
    val eventAttributes = LinkedHashMap(envelope.event.attributes)
    eventAttributes["x07.event.class"] = envelope.event.eventClass
    val logRecord = JSONObject()
    logRecord.put("timeUnixNano", envelope.event.timeUnixMs.coerceAtLeast(0L).times(1_000_000L).toString())
    logRecord.put("observedTimeUnixNano", System.currentTimeMillis().times(1_000_000L).toString())
    logRecord.put("severityNumber", severityNumberName(envelope.event.severity))
    logRecord.put("severityText", envelope.event.severity.uppercase(Locale.ROOT))
    logRecord.put("body", anyValueJson(envelope.event.body ?: envelope.event.name))
    logRecord.put("attributes", keyValuesJson(eventAttributes))
    logRecord.put("eventName", envelope.event.name)

    val scope = JSONObject()
    scope.put("name", TELEMETRY_SCOPE_NAME)
    scope.put("version", TELEMETRY_SCOPE_VERSION)

    val scopeLogs = JSONObject()
    scopeLogs.put("scope", scope)
    scopeLogs.put("logRecords", JSONArray().put(logRecord))

    val resource = JSONObject()
    resource.put("attributes", keyValuesJson(envelope.resource))

    val resourceLogs = JSONObject()
    resourceLogs.put("resource", resource)
    resourceLogs.put("scopeLogs", JSONArray().put(scopeLogs))

    return JSONObject().put("resourceLogs", JSONArray().put(resourceLogs))
  }

  private fun buildProtobufRequest(envelope: TelemetryEnvelope): ByteArray {
    val resource = ProtoWriter().apply {
      for ((key, value) in envelope.resource) {
        writeMessage(1, keyValueMessage(key, value))
      }
    }
    val eventAttributes = LinkedHashMap(envelope.event.attributes)
    eventAttributes["x07.event.class"] = envelope.event.eventClass
    val logRecord = ProtoWriter().apply {
      writeFixed64(1, envelope.event.timeUnixMs.coerceAtLeast(0L).times(1_000_000L))
      writeEnum(2, severityNumberValue(envelope.event.severity))
      writeString(3, envelope.event.severity.uppercase(Locale.ROOT))
      writeMessage(5, anyValueMessage(envelope.event.body ?: envelope.event.name))
      for ((key, value) in eventAttributes) {
        writeMessage(6, keyValueMessage(key, value))
      }
      writeFixed64(11, System.currentTimeMillis().times(1_000_000L))
      writeString(12, envelope.event.name)
    }
    val scope = ProtoWriter().apply {
      writeString(1, TELEMETRY_SCOPE_NAME)
      writeString(2, TELEMETRY_SCOPE_VERSION)
    }
    val scopeLogs = ProtoWriter().apply {
      writeMessage(1, scope.toByteArray())
      writeMessage(2, logRecord.toByteArray())
    }
    val resourceLogs = ProtoWriter().apply {
      writeMessage(1, resource.toByteArray())
      writeMessage(2, scopeLogs.toByteArray())
    }
    return ProtoWriter().apply { writeMessage(1, resourceLogs.toByteArray()) }.toByteArray()
  }

  private fun keyValueMessage(key: String, value: Any): ByteArray {
    val writer = ProtoWriter()
    writer.writeString(1, key)
    writer.writeMessage(2, anyValueMessage(value))
    return writer.toByteArray()
  }

  private fun anyValueMessage(value: Any): ByteArray {
    val writer = ProtoWriter()
    when (value) {
      is String -> writer.writeString(1, value)
      is Boolean -> writer.writeBool(2, value)
      is Double -> writer.writeDouble(4, value)
      is Float -> writer.writeDouble(4, value.toDouble())
      is Number -> writer.writeInt64(3, value.toLong())
      else -> writer.writeString(1, value.toString())
    }
    return writer.toByteArray()
  }

  private fun keyValuesJson(values: Map<String, Any>): JSONArray {
    val out = JSONArray()
    for ((key, value) in values) {
      val item = JSONObject()
      item.put("key", key)
      item.put("value", anyValueJson(value))
      out.put(item)
    }
    return out
  }

  private fun anyValueJson(value: Any): JSONObject {
    val out = JSONObject()
    when (value) {
      is String -> out.put("stringValue", value)
      is Boolean -> out.put("boolValue", value)
      is Double -> out.put("doubleValue", value)
      is Float -> out.put("doubleValue", value.toDouble())
      is Number -> out.put("intValue", value.toLong().toString())
      else -> out.put("stringValue", value.toString())
    }
    return out
  }

  private fun parseTransport(doc: JSONObject?): TelemetryTransport? {
    if (doc == null) return null
    val protocol = doc.optString("protocol", "").trim()
    val endpoint = doc.optString("endpoint", "").trim()
    if (protocol.isEmpty() || endpoint.isEmpty()) return null
    return TelemetryTransport(protocol = protocol, endpoint = endpoint)
  }

  private fun sanitizeAttributes(doc: JSONObject?): Map<String, Any> {
    val out = LinkedHashMap<String, Any>()
    if (doc == null) return out
    val keys = doc.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      if (key.isBlank()) continue
      val value = sanitizeTelemetryValue(doc.opt(key)) ?: continue
      out[key] = value
    }
    return out
  }

  private fun sanitizeTelemetryValue(raw: Any?): Any? {
    return when (raw) {
      null, JSONObject.NULL -> null
      is String -> raw
      is Boolean -> raw
      is Double -> if (raw.isFinite()) raw else null
      is Float -> if (raw.isFinite()) raw.toDouble() else null
      is Number -> raw.toLong()
      is JSONObject, is JSONArray -> raw.toString()
      else -> raw.toString()
    }
  }

  private fun transportSupported(transport: TelemetryTransport): Boolean {
    return (transport.protocol == "http/json" || transport.protocol == "http/protobuf") &&
      (transport.endpoint.startsWith("http://") || transport.endpoint.startsWith("https://"))
  }

  private fun normalizeLogsEndpoint(endpoint: String): String {
    val trimmed = endpoint.trim()
    return when {
      trimmed.endsWith("/v1/logs") -> trimmed
      trimmed.endsWith("/") -> "${trimmed}v1/logs"
      else -> "${trimmed}/v1/logs"
    }
  }

  private fun jsonArrayToStrings(values: JSONArray?): Set<String> {
    if (values == null) return emptySet()
    val out = linkedSetOf<String>()
    for (i in 0 until values.length()) {
      val value = values.optString(i, "").trim()
      if (value.isNotEmpty()) out.add(value)
    }
    return out
  }

  private fun parseOptionalString(raw: Any?): String? {
    return when (raw) {
      null, JSONObject.NULL -> null
      is String -> raw
      else -> raw.toString()
    }
  }

  private fun parseTimeUnixMs(raw: Any?): Long {
    return when (raw) {
      is Number -> raw.toLong()
      is String -> raw.toLongOrNull() ?: System.currentTimeMillis()
      else -> System.currentTimeMillis()
    }
  }

  private fun severityNumberValue(severity: String): Int {
    return when (severity.lowercase(Locale.ROOT)) {
      "trace" -> 1
      "debug" -> 5
      "warn", "warning" -> 13
      "error" -> 17
      "fatal" -> 21
      else -> 9
    }
  }

  private fun severityNumberName(severity: String): String {
    return when (severity.lowercase(Locale.ROOT)) {
      "trace" -> "SEVERITY_NUMBER_TRACE"
      "debug" -> "SEVERITY_NUMBER_DEBUG"
      "warn", "warning" -> "SEVERITY_NUMBER_WARN"
      "error" -> "SEVERITY_NUMBER_ERROR"
      "fatal" -> "SEVERITY_NUMBER_FATAL"
      else -> "SEVERITY_NUMBER_INFO"
    }
  }
}

private class X07IpcBridge(
  private val activity: MainActivity,
  private val telemetry: X07TelemetryCoordinator,
) {
  @JavascriptInterface
  fun postMessage(msg: String) {
    if (telemetry.handleIpc(msg)) {
      return
    }
    val doc =
      try {
        JSONObject(msg)
      } catch (_: Exception) {
        Log.i("x07", "ipc: $msg")
        return
      }
    when (doc.optString("kind")) {
      "x07.device.native.request" -> activity.handleNativeRequest(doc)
      "x07.device.ui.ready" -> return
      "x07.device.ui.error" -> {
        telemetry.emitNativeEvent(
          eventClass = "runtime.error",
          name = "bootstrap.error",
          severity = "error",
          attributes =
            mapOf(
              "stage" to "android.ipc",
              "message" to doc.optString("message", "ui error"),
            ),
        )
      }
      else -> {
        Log.i("x07", "ipc: $msg")
      }
    }
  }
}

private class X07AssetsPathHandler(private val activity: AppCompatActivity) :
  WebViewAssetLoader.PathHandler {
  override fun handle(path: String): WebResourceResponse? {
    val clean = sanitizePath(path) ?: return null
    val stream: InputStream = try {
      activity.assets.open(clean)
    } catch (_: Exception) {
      return null
    }
    val mime = mimeTypeFor(clean)
    return WebResourceResponse(mime, "utf-8", stream)
  }

  private fun sanitizePath(path: String): String? {
    val s = path.trim().removePrefix("/")
    if (s.isEmpty()) return null
    if (s.contains("..")) return null
    if (s.contains("\\")) return null
    return s
  }

  private fun mimeTypeFor(path: String): String {
    val lower = path.lowercase(Locale.ROOT)
    return when {
      lower.endsWith(".html") -> "text/html"
      lower.endsWith(".js") -> "text/javascript"
      lower.endsWith(".mjs") -> "text/javascript"
      lower.endsWith(".wasm") -> "application/wasm"
      lower.endsWith(".json") -> "application/json"
      lower.endsWith(".css") -> "text/css"
      lower.endsWith(".png") -> "image/png"
      lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
      lower.endsWith(".svg") -> "image/svg+xml"
      else -> "application/octet-stream"
    }
  }
}

private data class PendingNativeRequest(
  val bridgeRequestId: String,
  val request: JSONObject,
  val startedAtMs: Long,
)

private data class PendingPermissionRequest(
  val permission: String,
  val request: PendingNativeRequest,
)

private data class ExportPayload(
  val filename: String,
  val mime: String,
  val bytes: ByteArray,
  val text: String,
  val url: String,
)

private data class BlobManifestDoc(
  val handle: String,
  val sha256: String,
  val mime: String,
  val byteSize: Long,
  val createdAtMs: Long,
  val source: String,
  val localState: String,
) {
  fun toJson(): JSONObject {
    return JSONObject()
      .put("handle", handle)
      .put("sha256", sha256)
      .put("mime", mime)
      .put("byte_size", byteSize)
      .put("created_at_ms", createdAtMs)
      .put("source", source)
      .put("local_state", localState)
  }

  companion object {
    fun fromJson(doc: JSONObject): BlobManifestDoc {
      return BlobManifestDoc(
        handle = doc.optString("handle", ""),
        sha256 = doc.optString("sha256", ""),
        mime = doc.optString("mime", "application/octet-stream"),
        byteSize = doc.optLong("byte_size", 0L),
        createdAtMs = doc.optLong("created_at_ms", 0L),
        source = doc.optString("source", "blob_store"),
        localState = doc.optString("local_state", "missing"),
      )
    }
  }
}

private class NativeBlobStoreError(
  val codeName: String,
  override val message: String,
) : Exception(message)

private class NativeCapabilities private constructor(private val raw: JSONObject) {
  companion object {
    fun loadFromAssets(context: Context): NativeCapabilities {
      val raw =
        try {
          context.assets.open("x07/profile/device.capabilities.json").use { input ->
            JSONObject(String(input.readBytes(), Charsets.UTF_8))
          }
        } catch (_: Exception) {
          JSONObject()
        }
      return NativeCapabilities(raw)
    }
  }

  fun allows(capability: String): Boolean {
    val device = raw.optJSONObject("device") ?: return false
    return when (capability) {
      "audio.playback" -> device.optJSONObject("audio")?.optBoolean("playback", false) == true
      "camera.photo" -> device.optJSONObject("camera")?.optBoolean("photo", false) == true
      "clipboard.read_text" -> device.optJSONObject("clipboard")?.optBoolean("read_text", false) == true
      "clipboard.write_text" -> device.optJSONObject("clipboard")?.optBoolean("write_text", false) == true
      "files.pick" ->
        device.optJSONObject("files")?.optBoolean("pick", false) == true ||
          device.optJSONObject("files")?.optBoolean("pick_multiple", false) == true
      "files.pick_multiple" ->
        device.optJSONObject("files")?.optBoolean("pick_multiple", false) == true ||
          device.optJSONObject("files")?.optBoolean("pick", false) == true
      "files.save" -> device.optJSONObject("files")?.optBoolean("save", false) == true
      "files.drop" -> device.optJSONObject("files")?.optBoolean("drop", false) == true
      "blob_store" -> device.optJSONObject("blob_store")?.optBoolean("enabled", false) == true
      "haptics.present" -> device.optJSONObject("haptics")?.optBoolean("present", false) == true
      "location.foreground" -> device.optJSONObject("location")?.optBoolean("foreground", false) == true
      "notifications.local" -> device.optJSONObject("notifications")?.optBoolean("local", false) == true
      "share.present" -> device.optJSONObject("share")?.optBoolean("present", false) == true
      else -> false
    }
  }

  fun fileAcceptDefaults(): List<String> {
    val values = raw.optJSONObject("device")?.optJSONObject("files")?.optJSONArray("accept_defaults")
      ?: return emptyList()
    val out = mutableListOf<String>()
    for (i in 0 until values.length()) {
      val value = values.optString(i, "").trim()
      if (value.isNotEmpty()) {
        out += value
      }
    }
    return out
  }

  fun maxTotalBytes(): Long {
    return raw.optJSONObject("device")
      ?.optJSONObject("blob_store")
      ?.optLong("max_total_bytes", 64L * 1024L * 1024L)
      ?.coerceAtLeast(0L)
      ?: 64L * 1024L * 1024L
  }

  fun maxItemBytes(): Long {
    return raw.optJSONObject("device")
      ?.optJSONObject("blob_store")
      ?.optLong("max_item_bytes", 16L * 1024L * 1024L)
      ?.coerceAtLeast(0L)
      ?: 16L * 1024L * 1024L
  }
}

private class NativeBlobStore(
  context: Context,
  capabilities: NativeCapabilities,
) {
  private val dataDir = File(context.filesDir, "x07/blob_store/data")
  private val metaDir = File(context.filesDir, "x07/blob_store/meta")
  private val maxTotalBytes = capabilities.maxTotalBytes()
  private val maxItemBytes = capabilities.maxItemBytes()

  init {
    ensureDir(dataDir)
    ensureDir(metaDir)
  }

  fun put(
    data: ByteArray,
    mime: String,
    source: String,
  ): BlobManifestDoc {
    val byteSize = data.size.toLong()
    if (byteSize > maxItemBytes) {
      throw NativeBlobStoreError("blob_item_too_large", "blob item exceeds max_item_bytes")
    }
    val sha256 = sha256Hex(data)
    val existing = readManifest(sha256)
    if (existing != null && existing.localState == "present" && blobPath(sha256).isFile) {
      return existing
    }
    if (totalPresentBytes() + byteSize > maxTotalBytes) {
      throw NativeBlobStoreError("blob_total_too_large", "blob store exceeds max_total_bytes")
    }
    val manifest =
      BlobManifestDoc(
        handle = "blob:sha256:$sha256",
        sha256 = sha256,
        mime = mime,
        byteSize = byteSize,
        createdAtMs = unixTimeMs(),
        source = source,
        localState = "present",
      )
    try {
      blobPath(sha256).writeBytes(data)
      writeManifest(manifest)
      return manifest
    } catch (err: Exception) {
      throw NativeBlobStoreError("blob_io_error", err.message ?: "blob store write failed")
    }
  }

  fun stat(handle: String): BlobManifestDoc {
    val sha256 = blobSha(handle) ?: return missingBlobManifest(handle)
    val manifest = readManifest(sha256) ?: return missingBlobManifest(handle)
    return if (manifest.localState != "deleted" && !blobPath(sha256).isFile) {
      manifest.copy(localState = "missing")
    } else {
      manifest
    }
  }

  fun delete(handle: String): BlobManifestDoc {
    val sha256 = blobSha(handle) ?: return missingBlobManifest(handle)
    val manifest = readManifest(sha256) ?: return missingBlobManifest(handle)
    try {
      val blobPath = blobPath(sha256)
      if (blobPath.isFile) {
        if (!blobPath.delete()) {
          throw NativeBlobStoreError("blob_io_error", "failed to delete blob payload")
        }
      }
      val deleted = manifest.copy(localState = "deleted")
      writeManifest(deleted)
      return deleted
    } catch (err: NativeBlobStoreError) {
      throw err
    } catch (err: Exception) {
      throw NativeBlobStoreError("blob_io_error", err.message ?: "blob delete failed")
    }
  }

  fun read(handle: String): Pair<BlobManifestDoc, ByteArray> {
    val sha256 = blobSha(handle) ?: throw NativeBlobStoreError("blob_io_error", "invalid blob handle")
    val manifest = readManifest(sha256) ?: throw NativeBlobStoreError("blob_io_error", "missing blob manifest")
    val path = blobPath(sha256)
    if (!path.isFile) {
      throw NativeBlobStoreError("blob_io_error", "missing blob payload")
    }
    return try {
      manifest to path.readBytes()
    } catch (err: Exception) {
      throw NativeBlobStoreError("blob_io_error", err.message ?: "blob read failed")
    }
  }

  private fun totalPresentBytes(): Long {
    val files = metaDir.listFiles() ?: return 0L
    var total = 0L
    for (file in files) {
      if (!file.isFile || file.extension != "json") continue
      val manifest =
        try {
          BlobManifestDoc.fromJson(JSONObject(file.readText(Charsets.UTF_8)))
        } catch (err: Exception) {
          throw NativeBlobStoreError("blob_io_error", err.message ?: "blob manifest read failed")
        }
      if (manifest.localState == "present") {
        total += manifest.byteSize
      }
    }
    return total
  }

  private fun readManifest(sha256: String): BlobManifestDoc? {
    val path = metaPath(sha256)
    if (!path.isFile) return null
    return try {
      BlobManifestDoc.fromJson(JSONObject(path.readText(Charsets.UTF_8)))
    } catch (err: Exception) {
      throw NativeBlobStoreError("blob_io_error", err.message ?: "blob manifest read failed")
    }
  }

  private fun writeManifest(manifest: BlobManifestDoc) {
    try {
      metaPath(manifest.sha256).writeText(manifest.toJson().toString(), Charsets.UTF_8)
    } catch (err: Exception) {
      throw NativeBlobStoreError("blob_io_error", err.message ?: "blob manifest write failed")
    }
  }

  private fun blobPath(sha256: String): File = File(dataDir, "$sha256.bin")

  private fun metaPath(sha256: String): File = File(metaDir, "$sha256.json")

  private fun ensureDir(dir: File) {
    if (dir.isDirectory) return
    if (!dir.mkdirs() && !dir.isDirectory) {
      throw NativeBlobStoreError("blob_io_error", "failed to create ${dir.absolutePath}")
    }
  }
}

private fun unixTimeMs(): Long = System.currentTimeMillis()

private fun sha256Hex(data: ByteArray): String {
  return MessageDigest
    .getInstance("SHA-256")
    .digest(data)
    .joinToString(separator = "") { byte -> "%02x".format(byte) }
}

private fun blobSha(handle: String): String? {
  val prefix = "blob:sha256:"
  return handle.removePrefix(prefix).takeIf { handle.startsWith(prefix) && it.isNotEmpty() }
}

private fun missingBlobManifest(
  handle: String,
  source: String = "blob_store",
): BlobManifestDoc {
  return BlobManifestDoc(
    handle = handle,
    sha256 = blobSha(handle) ?: "",
    mime = "application/octet-stream",
    byteSize = 0L,
    createdAtMs = 0L,
    source = source,
    localState = "missing",
  )
}

private fun fileEntryJson(
  manifest: BlobManifestDoc,
  name: String,
  path: String = "",
  source: String,
): JSONObject {
  return JSONObject()
    .put("name", name)
    .put("path", path)
    .put("mime", manifest.mime)
    .put("byte_size", manifest.byteSize)
    .put("last_modified_ms", 0L)
    .put("source", source)
    .put("blob", manifest.toJson())
}

private fun stringsFromJsonArray(values: JSONArray?): List<String> {
  if (values == null) return emptyList()
  val out = mutableListOf<String>()
  for (i in 0 until values.length()) {
    val value = values.optString(i, "").trim()
    if (value.isNotEmpty()) {
      out += value
    }
  }
  return out
}

private fun mimeTypeForExtension(extension: String): String? {
  val clean = extension.removePrefix(".").lowercase(Locale.ROOT)
  if (clean.isEmpty()) return null
  return when (clean) {
    "heic" -> "image/heic"
    "heif" -> "image/heif"
    else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(clean)
  }
}

private fun mimeTypeForUri(
  context: Context,
  uri: Uri,
): String {
  val resolved = context.contentResolver.getType(uri)
  if (!resolved.isNullOrBlank()) return resolved
  val lastSegment = uri.lastPathSegment ?: ""
  val extension = lastSegment.substringAfterLast('.', "")
  return mimeTypeForExtension(extension) ?: "application/octet-stream"
}

private fun acceptMimeTypes(accepts: List<String>): Array<String> {
  if (accepts.isEmpty()) return arrayOf("*/*")
  val out = linkedSetOf<String>()
  for (accept in accepts) {
    val clean = accept.trim()
    if (clean.isEmpty()) continue
    when {
      clean.contains('/') -> out += clean
      clean.startsWith('.') -> mimeTypeForExtension(clean)?.let(out::add)
    }
  }
  if (out.isEmpty()) {
    out += "*/*"
  }
  return out.toTypedArray()
}

private fun jpegCompressionQuality(quality: String): Int {
  return when (quality) {
    "low" -> 50
    "high" -> 92
    else -> 75
  }
}

private fun pickLocationProvider(locationManager: LocationManager): String? {
  return when {
    locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
    locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
    locationManager.isProviderEnabled(LocationManager.PASSIVE_PROVIDER) -> LocationManager.PASSIVE_PROVIDER
    else -> null
  }
}

class MainActivity : AppCompatActivity() {
  private lateinit var webView: WebView
  private val telemetry = X07TelemetryCoordinator()
  private val capabilities by lazy { NativeCapabilities.loadFromAssets(this) }
  private val nativePrefs by lazy { getSharedPreferences("x07.device.host", MODE_PRIVATE) }
  private val mainHandler = Handler(Looper.getMainLooper())
  private val ioExecutor = Executors.newSingleThreadExecutor()
  private val scheduledNotifications = linkedMapOf<String, Runnable>()
  private var blobStore: NativeBlobStore? = null
  private var pendingPermissionRequest: PendingPermissionRequest? = null
  private var pendingCameraRequest: PendingNativeRequest? = null
  private var pendingCameraCompressionQuality = jpegCompressionQuality("medium")
  private var pendingFileRequest: PendingNativeRequest? = null
  private var pendingFileSaveRequest: PendingNativeRequest? = null
  private var pendingFileSaveBytes: ByteArray? = null
  private var pendingFileSaveMime = "application/octet-stream"
  private var pendingFileSaveFilename = "export.txt"
  private var pendingLocationRequest: PendingNativeRequest? = null
  private var pendingLocationTimeout: Runnable? = null
  private var pendingLocationCancellation: CancellationSignal? = null
  private val permissionLauncher =
    registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
      finishPendingPermissionRequest()
    }
  private val cameraLauncher =
    registerForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap ->
      finishCameraCapture(bitmap)
    }
  private val filePickerLauncher =
    registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
      finishFilePick(uri)
    }
  private val filePickerMultipleLauncher =
    registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
      finishFilePickMultiple(uris)
    }
  private val createDocumentLauncher =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      finishFileSave(result.resultCode, result.data?.data)
    }

  internal fun handleNativeRequest(doc: JSONObject) {
    val bridgeRequestId = doc.optString("bridge_request_id", "").trim()
    if (bridgeRequestId.isEmpty()) return
    val request = doc.optJSONObject("request") ?: JSONObject()
    val family = request.optString("family", "")
    val pending = PendingNativeRequest(bridgeRequestId = bridgeRequestId, request = request, startedAtMs = unixTimeMs())
    val capability = request.optString("capability", "").trim()
    if (capability.isNotEmpty() && !capabilities.allows(capability)) {
      completeRequest(
        pending = pending,
        status = "unsupported",
        payload = JSONObject(),
        eventClass = "policy.violation",
        eventName = "device.capability.denied",
        severity = "warn",
      )
      return
    }

    when (family) {
      "audio" -> {
        val result = handleAudioRequest(request)
        sendBridgeReply(bridgeRequestId, result)
        emitRequestTelemetry(request, resultStatus(result), unixTimeMs() - pending.startedAtMs)
      }
      "haptics" -> {
        val result = handleHapticsRequest(request)
        sendBridgeReply(bridgeRequestId, result)
        emitRequestTelemetry(request, resultStatus(result), unixTimeMs() - pending.startedAtMs)
      }
      "permissions" -> handlePermissionsRequest(pending)
      "camera" -> handleCameraRequest(pending)
      "clipboard" -> handleClipboardRequest(pending)
      "files" -> handleFilesRequest(pending)
      "blobs" -> handleBlobsRequest(pending)
      "location" -> handleLocationRequest(pending)
      "notifications" -> {
        val result = handleNotificationsRequest(request)
        sendBridgeReply(bridgeRequestId, result)
        emitRequestTelemetry(request, resultStatus(result), unixTimeMs() - pending.startedAtMs)
      }
      "share" -> {
        val result = handleShareRequest(request)
        sendBridgeReply(bridgeRequestId, result)
        emitRequestTelemetry(request, resultStatus(result), unixTimeMs() - pending.startedAtMs)
      }
      else -> {
        val result = nativeBridgeResult(family, request, "unsupported", JSONObject())
        sendBridgeReply(bridgeRequestId, result)
        emitRequestTelemetry(request, "unsupported", unixTimeMs() - pending.startedAtMs)
      }
    }
  }

  private fun handleAudioRequest(request: JSONObject): JSONObject {
    return nativeBridgeResult(
      family = "audio",
      request = request,
      status = "unsupported",
      payload = JSONObject().put("reason", "shared_host_audio"),
    )
  }

  private fun handlePermissionsRequest(pending: PendingNativeRequest) {
    val payload = pending.request.optJSONObject("payload") ?: JSONObject()
    val permission = payload.optString("permission", "").trim()
    if (pending.request.optString("op", "") == "permissions.query") {
      val state = permissionState(permission)
      val status = if (state == "unsupported") "unsupported" else "ok"
      completeRequest(
        pending = pending,
        status = status,
        payload =
          JSONObject()
            .put("permission", permission)
            .put("state", state),
      )
      return
    }

    if (pendingPermissionRequest != null) {
      completeRequest(
        pending = pending,
        status = "error",
        payload = JSONObject().put("message", "permission request already in flight"),
      )
      return
    }

    when (permission) {
      "camera" -> {
        val state = permissionState(permission)
        if (state == "granted" || state == "unsupported") {
          completeRequest(
            pending = pending,
            status = if (state == "granted") "ok" else "unsupported",
            payload =
              JSONObject()
                .put("permission", permission)
                .put("state", state),
          )
          return
        }
        rememberPermissionRequest(permission)
        pendingPermissionRequest = PendingPermissionRequest(permission = permission, request = pending)
        permissionLauncher.launch(arrayOf(Manifest.permission.CAMERA))
      }
      "location_foreground" -> {
        val state = permissionState(permission)
        if (state == "granted" || state == "unsupported") {
          completeRequest(
            pending = pending,
            status = if (state == "granted") "ok" else "unsupported",
            payload =
              JSONObject()
                .put("permission", permission)
                .put("state", state),
          )
          return
        }
        rememberPermissionRequest(permission)
        pendingPermissionRequest = PendingPermissionRequest(permission = permission, request = pending)
        permissionLauncher.launch(
          arrayOf(
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION,
          ),
        )
      }
      "notifications" -> {
        val state = permissionState(permission)
        if (Build.VERSION.SDK_INT < 33 || state == "granted" || state == "unsupported") {
          completeRequest(
            pending = pending,
            status =
              when (state) {
                "granted" -> "ok"
                "unsupported" -> "unsupported"
                else -> "denied"
              },
            payload =
              JSONObject()
                .put("permission", permission)
                .put("state", state),
          )
          return
        }
        rememberPermissionRequest(permission)
        pendingPermissionRequest = PendingPermissionRequest(permission = permission, request = pending)
        permissionLauncher.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
      }
      else -> {
        completeRequest(
          pending = pending,
          status = "unsupported",
          payload =
            JSONObject()
              .put("permission", permission)
              .put("state", "unsupported"),
        )
      }
    }
  }

  private fun finishPendingPermissionRequest() {
    val pendingPermission = pendingPermissionRequest ?: return
    pendingPermissionRequest = null
    val state = permissionState(pendingPermission.permission)
    val status =
      when (state) {
        "granted" -> "ok"
        "unsupported" -> "unsupported"
        else -> "denied"
      }
    completeRequest(
      pending = pendingPermission.request,
      status = status,
      payload =
        JSONObject()
          .put("permission", pendingPermission.permission)
          .put("state", state),
    )
  }

  private fun handleClipboardRequest(pending: PendingNativeRequest) {
    val clipboard = getSystemService(ClipboardManager::class.java)
    if (clipboard == null) {
      completeRequest(
        pending = pending,
        status = "unsupported",
        payload = JSONObject().put("reason", "clipboard_unavailable"),
      )
      return
    }
    val op = pending.request.optString("op", "")
    if (op == "clipboard.read_text") {
      val text =
        clipboard.primaryClip
          ?.takeIf { it.itemCount > 0 }
          ?.getItemAt(0)
          ?.coerceToText(this)
          ?.toString()
          ?: ""
      completeRequest(
        pending = pending,
        status = "ok",
        payload = JSONObject().put("text", text),
      )
      return
    }

    val payload = pending.request.optJSONObject("payload") ?: JSONObject()
    val text =
      when {
        payload.has("text") -> payload.optString("text", "")
        payload.has("value") -> payload.optString("value", "")
        payload.optJSONObject("body")?.has("text") == true ->
          payload.optJSONObject("body")?.optString("text", "").orEmpty()
        else -> ""
      }
    try {
      clipboard.setPrimaryClip(ClipData.newPlainText("x07", text))
      completeRequest(
        pending = pending,
        status = "ok",
        payload = JSONObject().put("text_bytes_len", text.toByteArray(Charsets.UTF_8).size),
      )
    } catch (err: Exception) {
      completeRequest(
        pending = pending,
        status = "error",
        payload = JSONObject().put("message", err.message ?: "clipboard write failed"),
      )
    }
  }

  private fun handleCameraRequest(pending: PendingNativeRequest) {
    val activeBlobStore = blobStore
    if (activeBlobStore == null) {
      completeRequest(
        pending = pending,
        status = "unsupported",
        payload = JSONObject().put("reason", "blob_store_disabled"),
      )
      return
    }
    if (pendingCameraRequest != null) {
      completeRequest(
        pending = pending,
        status = "error",
        payload = JSONObject().put("message", "camera request already in flight"),
      )
      return
    }
    if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
      completeRequest(pending = pending, status = "unsupported", payload = JSONObject())
      return
    }
    val permissionState = permissionState("camera")
    if (permissionState != "granted") {
      completeRequest(
        pending = pending,
        status = if (permissionState == "unsupported") "unsupported" else "denied",
        payload = JSONObject(),
      )
      return
    }
    pendingCameraCompressionQuality =
      jpegCompressionQuality((pending.request.optJSONObject("payload") ?: JSONObject()).optString("quality", "medium"))
    pendingCameraRequest = pending
    cameraLauncher.launch(null)
  }

  private fun finishCameraCapture(bitmap: Bitmap?) {
    val pending = pendingCameraRequest ?: return
    pendingCameraRequest = null
    val activeBlobStore = blobStore
    if (bitmap == null) {
      completeRequest(pending = pending, status = "cancelled", payload = JSONObject())
      return
    }
    if (activeBlobStore == null) {
      completeRequest(
        pending = pending,
        status = "unsupported",
        payload = JSONObject().put("reason", "blob_store_disabled"),
      )
      return
    }
    val out = ByteArrayOutputStream()
    if (!bitmap.compress(Bitmap.CompressFormat.JPEG, pendingCameraCompressionQuality, out)) {
      completeRequest(
        pending = pending,
        status = "error",
        payload = JSONObject().put("message", "camera capture failed"),
      )
      return
    }
    try {
      val manifest = activeBlobStore.put(out.toByteArray(), "image/jpeg", "camera")
      completeRequest(
        pending = pending,
        status = "ok",
        payload =
          JSONObject()
            .put("blob", manifest.toJson())
            .put(
              "image",
              JSONObject()
                .put("width", bitmap.width)
                .put("height", bitmap.height),
            ),
      )
    } catch (err: NativeBlobStoreError) {
      completeRequest(
        pending = pending,
        status = "error",
        payload =
          JSONObject()
            .put("reason", err.codeName)
            .put("message", err.message),
      )
    }
  }

  private fun handleFilesRequest(pending: PendingNativeRequest) {
    val payload = pending.request.optJSONObject("payload") ?: JSONObject()
    when (pending.request.optString("op", "files.pick")) {
      "files.save" -> handleFileSaveRequest(pending)
      "files.pick_multiple" -> handleFilePickRequest(pending, multiple = true)
      else -> handleFilePickRequest(pending, multiple = payload.optBoolean("multiple", false))
    }
  }

  private fun handleFilePickRequest(
    pending: PendingNativeRequest,
    multiple: Boolean,
  ) {
    if (blobStore == null) {
      completeRequest(
        pending = pending,
        status = "unsupported",
        payload = JSONObject().put("reason", "blob_store_disabled"),
      )
      return
    }
    if (pendingFileRequest != null) {
      completeRequest(
        pending = pending,
        status = "error",
        payload = JSONObject().put("message", "file picker already in flight"),
      )
      return
    }
    val payload = pending.request.optJSONObject("payload") ?: JSONObject()
    val accepts = stringsFromJsonArray(payload.optJSONArray("accept")).ifEmpty { capabilities.fileAcceptDefaults() }
    pendingFileRequest = pending
    if (multiple) {
      filePickerMultipleLauncher.launch(acceptMimeTypes(accepts))
    } else {
      filePickerLauncher.launch(acceptMimeTypes(accepts))
    }
  }

  private fun finishFilePick(uri: Uri?) {
    val pending = pendingFileRequest ?: return
    pendingFileRequest = null
    if (uri == null) {
      completeRequest(pending = pending, status = "cancelled", payload = JSONObject())
      return
    }
    val (status, payload) = importUris(listOf(uri), "files.pick")
    completeRequest(pending = pending, status = status, payload = payload)
  }

  private fun finishFilePickMultiple(uris: List<Uri>) {
    val pending = pendingFileRequest ?: return
    pendingFileRequest = null
    if (uris.isEmpty()) {
      completeRequest(pending = pending, status = "cancelled", payload = JSONObject())
      return
    }
    val (status, payload) = importUris(uris, "files.pick")
    completeRequest(pending = pending, status = status, payload = payload)
  }

  private fun handleFileSaveRequest(pending: PendingNativeRequest) {
    if (pendingFileSaveRequest != null) {
      completeRequest(
        pending = pending,
        status = "error",
        payload = JSONObject().put("message", "file save already in flight"),
      )
      return
    }
    val payload = pending.request.optJSONObject("payload") ?: JSONObject()
    val export =
      try {
        resolveExportPayload(pending.request.optString("kind", ""), payload)
      } catch (err: NativeBlobStoreError) {
        completeRequest(
          pending = pending,
          status = "error",
          payload = JSONObject().put("reason", err.codeName).put("message", err.message),
        )
        return
      } catch (err: Exception) {
        completeRequest(
          pending = pending,
          status = "error",
          payload = JSONObject().put("reason", "invalid_request").put("message", err.message ?: "invalid export payload"),
        )
        return
      }
    pendingFileSaveRequest = pending
    pendingFileSaveBytes = export.bytes
    pendingFileSaveMime = export.mime
    pendingFileSaveFilename = export.filename
    val intent =
      Intent(Intent.ACTION_CREATE_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .setType(export.mime)
        .putExtra(Intent.EXTRA_TITLE, export.filename)
    createDocumentLauncher.launch(intent)
  }

  private fun finishFileSave(
    resultCode: Int,
    uri: Uri?,
  ) {
    val pending = pendingFileSaveRequest ?: return
    val bytes = pendingFileSaveBytes
    val mime = pendingFileSaveMime
    val filename = pendingFileSaveFilename
    pendingFileSaveRequest = null
    pendingFileSaveBytes = null
    pendingFileSaveMime = "application/octet-stream"
    pendingFileSaveFilename = "export.txt"
    if (resultCode != Activity.RESULT_OK || uri == null) {
      completeRequest(pending = pending, status = "cancelled", payload = JSONObject())
      return
    }
    if (bytes == null) {
      completeRequest(
        pending = pending,
        status = "error",
        payload = JSONObject().put("message", "file save payload missing"),
      )
      return
    }
    try {
      contentResolver.openOutputStream(uri)?.use { output ->
        output.write(bytes)
      } ?: throw FileNotFoundException("unable to open export destination")
      completeRequest(
        pending = pending,
        status = "ok",
        payload =
          JSONObject()
            .put("filename", filename)
            .put("mime", mime)
            .put("bytes_len", bytes.size)
            .put("path", uri.toString()),
      )
    } catch (err: Exception) {
      completeRequest(
        pending = pending,
        status = "error",
        payload = JSONObject().put("message", err.message ?: "file export failed"),
      )
    }
  }

  private fun importUris(
    uris: List<Uri>,
    source: String,
  ): Pair<String, JSONObject> {
    val activeBlobStore = blobStore ?: return "unsupported" to JSONObject().put("reason", "blob_store_disabled")
    val blobs = JSONArray()
    val files = JSONArray()
    val errors = JSONArray()
    for (uri in uris) {
      try {
        val bytes =
          contentResolver.openInputStream(uri)?.use { input -> input.readBytes() }
            ?: throw FileNotFoundException("unable to open selected file")
        val manifest = activeBlobStore.put(bytes, mimeTypeForUri(this, uri), source)
        blobs.put(manifest.toJson())
        files.put(
          fileEntryJson(
            manifest = manifest,
            name = displayNameForUri(uri),
            path = uri.toString(),
            source = source,
          ),
        )
      } catch (err: NativeBlobStoreError) {
        errors.put(
          JSONObject()
            .put("code", err.codeName)
            .put("message", err.message)
            .put("path", uri.toString()),
        )
      } catch (err: Exception) {
        errors.put(
          JSONObject()
            .put("code", "file_import_failed")
            .put("message", err.message ?: "file import failed")
            .put("path", uri.toString()),
        )
      }
    }
    val payload =
      JSONObject()
        .put("blobs", blobs)
        .put("files", files)
        .put("accepted_count", files.length())
        .put("rejected_count", errors.length())
    if (uris.size == 1) {
      payload.put("path", uris.first().toString())
    }
    if (errors.length() > 0) {
      payload.put("errors", errors)
      if (files.length() > 0) {
        payload.put("partial", true)
      }
    }
    return if (files.length() > 0) "ok" to payload else "error" to payload
  }

  private fun displayNameForUri(uri: Uri): String {
    val cursor =
      try {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
      } catch (_: Exception) {
        null
      }
    cursor?.use {
      if (it.moveToFirst()) {
        val idx = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (idx >= 0) {
          val name = it.getString(idx)
          if (!name.isNullOrBlank()) {
            return name
          }
        }
      }
    }
    return uri.lastPathSegment?.substringAfterLast('/') ?: "file"
  }

  private fun jsonValueToPrettyString(value: Any?): String =
    when (value) {
      null, JSONObject.NULL -> "null"
      is JSONObject -> value.toString(2)
      is JSONArray -> value.toString(2)
      is String -> JSONObject.quote(value)
      is Number, is Boolean -> value.toString()
      else -> jsonValueToPrettyString(JSONObject.wrap(value))
    }

  private fun resolveExportPayload(
    kind: String,
    payload: JSONObject,
  ): ExportPayload {
    val defaultFilename = if (kind == "x07.web_ui.effect.device.files.save_json") "export.json" else "export.txt"
    val defaultMime = if (kind == "x07.web_ui.effect.device.files.save_json") "application/json" else "text/plain;charset=utf-8"
    val filename =
      payload.optString(
        "filename",
        payload.optString("name", payload.optString("suggested_name", defaultFilename)),
      ).ifBlank { defaultFilename }
    val requestMime =
      payload.optString("mime", payload.optString("content_type", defaultMime))
        .ifBlank { defaultMime }
    val blobHandle = payload.optString("blob_handle", payload.optString("handle", "")).trim()
    if (blobHandle.isNotEmpty()) {
      val activeBlobStore = blobStore ?: throw NativeBlobStoreError("blob_io_error", "blob store unavailable")
      val (manifest, bytes) = activeBlobStore.read(blobHandle)
      return ExportPayload(
        filename = filename,
        mime = manifest.mime.ifBlank { requestMime },
        bytes = bytes,
        text = "",
        url = "",
      )
    }
    if (kind == "x07.web_ui.effect.device.files.save_json") {
      val jsonValue =
        when {
          payload.has("value") -> payload.get("value")
          payload.has("json") -> payload.get("json")
          else -> JSONObject.NULL
        }
      val body = "${jsonValueToPrettyString(jsonValue)}\n"
      return ExportPayload(
        filename = filename,
        mime = requestMime,
        bytes = body.toByteArray(Charsets.UTF_8),
        text = body,
        url = "",
      )
    }
    val text =
      when {
        payload.has("text") -> payload.optString("text", "")
        payload.has("value") -> payload.optString("value", "")
        payload.optJSONObject("body")?.has("text") == true ->
          payload.optJSONObject("body")?.optString("text", "").orEmpty()
        else -> ""
      }
    val url = payload.optString("url", payload.optString("href", ""))
    val body = if (text.isNotEmpty()) text else url
    if (body.isEmpty()) {
      throw IllegalArgumentException("request payload missing text/url/blob_handle")
    }
    return ExportPayload(
      filename = filename,
      mime = requestMime,
      bytes = body.toByteArray(Charsets.UTF_8),
      text = text,
      url = url,
    )
  }

  private fun handleBlobsRequest(pending: PendingNativeRequest) {
    val activeBlobStore = blobStore
    if (activeBlobStore == null) {
      completeRequest(
        pending = pending,
        status = "unsupported",
        payload = JSONObject().put("reason", "blob_store_disabled"),
      )
      return
    }
    val payload = pending.request.optJSONObject("payload") ?: JSONObject()
    val handle = payload.optString("handle", "")
    try {
      val blob =
        if (pending.request.optString("op", "") == "blobs.delete") {
          activeBlobStore.delete(handle)
        } else {
          activeBlobStore.stat(handle)
        }
      completeRequest(
        pending = pending,
        status = "ok",
        payload = JSONObject().put("blob", blob.toJson()),
      )
    } catch (err: NativeBlobStoreError) {
      completeRequest(
        pending = pending,
        status = "error",
        payload =
          JSONObject()
            .put("reason", err.codeName)
            .put("message", err.message),
      )
    }
  }

  private fun handleLocationRequest(pending: PendingNativeRequest) {
    val locationManager = getSystemService(LocationManager::class.java)
    if (locationManager == null) {
      completeRequest(pending = pending, status = "unsupported", payload = JSONObject())
      return
    }
    val permissionState = permissionState("location_foreground")
    if (permissionState != "granted") {
      completeRequest(
        pending = pending,
        status = if (permissionState == "unsupported") "unsupported" else "denied",
        payload = JSONObject(),
      )
      return
    }
    val provider = pickLocationProvider(locationManager)
    if (provider == null) {
      completeRequest(pending = pending, status = "unsupported", payload = JSONObject())
      return
    }
    if (pendingLocationRequest != null) {
      completeRequest(
        pending = pending,
        status = "error",
        payload = JSONObject().put("message", "location request already in flight"),
      )
      return
    }
    pendingLocationRequest = pending
    val timeoutMs =
      (pending.request.optJSONObject("payload") ?: JSONObject())
        .optLong("timeout_ms", 10_000L)
        .coerceAtLeast(0L)
    val cancellation = CancellationSignal()
    pendingLocationCancellation = cancellation
    val timeout =
      Runnable {
        val active = pendingLocationRequest ?: return@Runnable
        pendingLocationRequest = null
        pendingLocationTimeout = null
        pendingLocationCancellation?.cancel()
        pendingLocationCancellation = null
        completeRequest(active, "timeout", JSONObject())
      }
    pendingLocationTimeout = timeout
    mainHandler.postDelayed(timeout, timeoutMs)
    try {
      LocationManagerCompat.getCurrentLocation(
        locationManager,
        provider,
        cancellation,
        ContextCompat.getMainExecutor(this),
      ) { location ->
        finishLocationRequest(location)
      }
    } catch (err: SecurityException) {
      clearLocationRequest()
      completeRequest(pending, "denied", JSONObject())
    } catch (err: Exception) {
      clearLocationRequest()
      completeRequest(
        pending,
        "error",
        JSONObject().put("message", err.message ?: "location request failed"),
      )
    }
  }

  private fun finishLocationRequest(location: Location?) {
    val pending = pendingLocationRequest ?: return
    clearLocationRequest()
    if (location == null) {
      completeRequest(
        pending = pending,
        status = "error",
        payload = JSONObject().put("message", "location unavailable"),
      )
      return
    }
    val payload =
      JSONObject()
        .put("latitude", location.latitude)
        .put("longitude", location.longitude)
        .put("accuracy_m", location.accuracy)
        .put("captured_at_ms", unixTimeMs())
    if (location.hasAltitude()) {
      payload.put("altitude_m", location.altitude)
    }
    completeRequest(pending = pending, status = "ok", payload = payload)
  }

  private fun clearLocationRequest() {
    pendingLocationTimeout?.let(mainHandler::removeCallbacks)
    pendingLocationTimeout = null
    pendingLocationCancellation?.cancel()
    pendingLocationCancellation = null
    pendingLocationRequest = null
  }

  private fun handleShareRequest(request: JSONObject): JSONObject {
    val payload = request.optJSONObject("payload") ?: JSONObject()
    if (request.optString("kind", "") == "x07.web_ui.effect.device.share.share_files") {
      return nativeBridgeResult(
        family = "share",
        request = request,
        status = "unsupported",
        payload = JSONObject().put("reason", "share_blob_not_supported"),
      )
    }
    val export =
      try {
        resolveExportPayload(request.optString("kind", ""), payload)
      } catch (err: NativeBlobStoreError) {
        return nativeBridgeResult(
          family = "share",
          request = request,
          status = "unsupported",
          payload = JSONObject().put("reason", err.codeName).put("message", err.message),
        )
      } catch (err: Exception) {
        return nativeBridgeResult(
          family = "share",
          request = request,
          status = "error",
          payload = JSONObject().put("reason", "invalid_request").put("message", err.message ?: "invalid share payload"),
        )
      }

    if (export.text.isEmpty() && export.url.isEmpty()) {
      return nativeBridgeResult(
        family = "share",
        request = request,
        status = "unsupported",
        payload = JSONObject().put("reason", "share_blob_not_supported"),
      )
    }

    val shareBody =
      buildString {
        if (export.text.isNotEmpty()) append(export.text)
        if (export.url.isNotEmpty()) {
          if (isNotEmpty()) append('\n')
          append(export.url)
        }
      }
    return try {
      val intent =
        Intent(Intent.ACTION_SEND)
          .setType("text/plain")
          .putExtra(Intent.EXTRA_TEXT, shareBody)
      payload.optString("title", payload.optString("subject", ""))
        .takeIf { it.isNotBlank() }
        ?.let { intent.putExtra(Intent.EXTRA_SUBJECT, it) }
      startActivity(Intent.createChooser(intent, payload.optString("title", "Share")))
      nativeBridgeResult(
        family = "share",
        request = request,
        status = "ok",
        payload =
          JSONObject()
            .put("text_bytes_len", shareBody.toByteArray(Charsets.UTF_8).size)
            .put("shared", true),
      )
    } catch (err: Exception) {
      nativeBridgeResult(
        family = "share",
        request = request,
        status = "unsupported",
        payload = JSONObject().put("message", err.message ?: "share unavailable"),
      )
    }
  }

  private fun handleDroppedClipData(clipData: ClipData?) {
    if (!capabilities.allows("files.drop") || !capabilities.allows("blob_store")) {
      return
    }
    val uris = mutableListOf<Uri>()
    val itemCount = clipData?.itemCount ?: 0
    for (i in 0 until itemCount) {
      clipData?.getItemAt(i)?.uri?.let(uris::add)
    }
    if (uris.isEmpty()) {
      return
    }
    val startedAtMs = unixTimeMs()
    ioExecutor.execute {
      val (status, payload) = importUris(uris, "files.drop")
      telemetry.emitNativeEvent(
        eventClass = if (status == "error") "runtime.error" else "bridge.timing",
        name = "device.files.drop",
        severity = if (status == "error") "error" else "info",
        attributes =
          mapOf(
            "x07.device.op" to "files.drop",
            "x07.device.request_id" to "",
            "x07.device.status" to status,
            "x07.device.capability" to "files.drop",
            "x07.device.platform" to "android",
            "x07.device.duration_ms" to (unixTimeMs() - startedAtMs),
            "x07.device.accepted_count" to payload.optInt("accepted_count", 0),
            "x07.device.rejected_count" to payload.optInt("rejected_count", 0),
          ),
        body = payload.optJSONArray("errors")?.toString(),
      )
      val event =
        JSONObject()
          .put("type", "files.drop")
          .put("status", status)
          .put("source", "android")
          .put("files", payload.optJSONArray("files") ?: JSONArray())
          .put("blobs", payload.optJSONArray("blobs") ?: JSONArray())
          .put("accepted_count", payload.optInt("accepted_count", 0))
          .put("rejected_count", payload.optInt("rejected_count", 0))
      if (payload.has("errors")) {
        event.put("errors", payload.optJSONArray("errors"))
      }
      if (payload.optBoolean("partial", false)) {
        event.put("partial", true)
      }
      mainHandler.post {
        sendBridgePayload("__x07DispatchDeviceEvent", event)
      }
    }
  }

  private fun handleNotificationsRequest(request: JSONObject): JSONObject {
    val payload = request.optJSONObject("payload") ?: JSONObject()
    val notificationId =
      payload.optString(
        "notification_id",
        payload.optString("id", request.optString("request_id", "")),
      ).trim()

    if (request.optString("op") == "notifications.cancel") {
      scheduledNotifications.remove(notificationId)?.let(mainHandler::removeCallbacks)
      return nativeBridgeResult(
        family = "notifications",
        request = request,
        status = "ok",
        payload = JSONObject().put("notification_id", notificationId),
      )
    }

    val delayMs = payload.optLong("delay_ms", 0L).coerceAtLeast(0L)
    scheduledNotifications.remove(notificationId)?.let(webView::removeCallbacks)
    val runnable =
      Runnable {
        sendBridgePayload(
          "__x07DispatchDeviceEvent",
          JSONObject()
            .put("type", "notification.opened")
            .put("notification_id", notificationId),
        )
      }
    scheduledNotifications[notificationId] = runnable
    mainHandler.postDelayed(runnable, delayMs)
    return nativeBridgeResult(
      family = "notifications",
      request = request,
      status = "ok",
      payload = JSONObject().put("notification_id", notificationId),
    )
  }

  private fun handleHapticsRequest(request: JSONObject): JSONObject {
    val pattern = request.optJSONObject("payload")?.optString("pattern", "")?.trim().orEmpty()
    val timings =
      when (pattern) {
        "selection" -> longArrayOf(0, 25)
        "impact" -> longArrayOf(0, 40)
        "victory" -> longArrayOf(0, 18, 36, 18)
        "defeat" -> longArrayOf(0, 45, 24, 55)
        else -> null
      }
    if (timings == null) {
      return nativeBridgeResult(
        family = "haptics",
        request = request,
        status = "error",
        payload =
          JSONObject()
            .put("reason", "invalid_pattern")
            .put("pattern", pattern),
      )
    }
    val vibrator = deviceVibrator()
      ?: return nativeBridgeResult(
        family = "haptics",
        request = request,
        status = "unsupported",
        payload = JSONObject().put("reason", "vibrator_unavailable"),
      )
    if (!vibrator.hasVibrator()) {
      return nativeBridgeResult(
        family = "haptics",
        request = request,
        status = "unsupported",
        payload = JSONObject().put("reason", "vibrator_unavailable"),
      )
    }
    return try {
      if (Build.VERSION.SDK_INT >= 26) {
        vibrator.vibrate(VibrationEffect.createWaveform(timings, -1))
      } else {
        @Suppress("DEPRECATION")
        vibrator.vibrate(timings, -1)
      }
      nativeBridgeResult(
        family = "haptics",
        request = request,
        status = "ok",
        payload = JSONObject().put("pattern", pattern),
      )
    } catch (err: Exception) {
      nativeBridgeResult(
        family = "haptics",
        request = request,
        status = "error",
        payload =
          JSONObject()
            .put("message", err.message ?: "haptics trigger failed")
            .put("pattern", pattern),
      )
    }
  }

  private fun nativeBridgeResult(
    family: String,
    request: JSONObject,
    status: String,
    payload: JSONObject,
  ): JSONObject {
    return JSONObject()
      .put("family", family)
      .put(
        "result",
        JSONObject()
          .put("request_id", request.optString("request_id", ""))
          .put("op", request.optString("op", ""))
          .put("capability", request.optString("capability", ""))
          .put("status", status)
          .put("payload", payload)
          .put(
            "host_meta",
            JSONObject()
              .put("platform", "android")
              .put("provider", "android_native"),
          ),
      )
  }

  private fun resultStatus(result: JSONObject): String {
    return result.optJSONObject("result")?.optString("status", "error") ?: "error"
  }

  private fun sendBridgeReply(
    bridgeRequestId: String,
    result: JSONObject,
  ) {
    sendBridgePayload(
      "__x07ReceiveDeviceReply",
      JSONObject()
        .put("bridge_request_id", bridgeRequestId)
        .put("result", result),
    )
  }

  private fun completeRequest(
    pending: PendingNativeRequest,
    status: String,
    payload: JSONObject,
    eventClass: String? = null,
    eventName: String? = null,
    severity: String? = null,
  ) {
    val family = pending.request.optString("family", "")
    val result = nativeBridgeResult(family, pending.request, status, payload)
    sendBridgeReply(pending.bridgeRequestId, result)
    emitRequestTelemetry(
      request = pending.request,
      status = status,
      durationMs = unixTimeMs() - pending.startedAtMs,
      payload = payload,
      eventClass = eventClass,
      eventName = eventName,
      severity = severity,
    )
  }

  private fun emitRequestTelemetry(
    request: JSONObject,
    status: String,
    durationMs: Long,
    payload: JSONObject? = null,
    eventClass: String? = null,
    eventName: String? = null,
    severity: String? = null,
  ) {
    val attributes = linkedMapOf<String, Any>(
      "x07.device.op" to request.optString("op", ""),
      "x07.device.request_id" to request.optString("request_id", ""),
      "x07.device.status" to status,
      "x07.device.capability" to request.optString("capability", ""),
      "x07.device.platform" to "android",
      "x07.device.duration_ms" to durationMs,
    )
    val reason = payload?.optString("reason", "")?.trim().orEmpty()
    if (reason.isNotEmpty()) {
      attributes["x07.device.reason"] = reason
    }
    telemetry.emitNativeEvent(
      eventClass = eventClass ?: if (status == "error") "runtime.error" else "bridge.timing",
      name = eventName ?: requestTelemetryName(request, status),
      severity = severity ?: if (status == "error") "error" else "info",
      attributes = attributes,
    )
  }

  private fun requestTelemetryName(request: JSONObject, status: String): String {
    return when (request.optString("op", "")) {
      "audio.play" -> "device.audio.play"
      "audio.stop" -> "device.audio.stop"
      "haptics.trigger" -> "device.haptics.trigger"
      else -> if (status == "error") "device.op.error" else "device.op.result"
    }
  }

  private fun deviceVibrator(): Vibrator? {
    return if (Build.VERSION.SDK_INT >= 31) {
      getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
  }

  private fun permissionState(permission: String): String {
    return when (permission) {
      "camera" -> cameraPermissionState()
      "location_foreground" -> locationPermissionState()
      "notifications" -> notificationPermissionState()
      else -> "unsupported"
    }
  }

  private fun cameraPermissionState(): String {
    if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
      return "unsupported"
    }
    if (hasPermission(Manifest.permission.CAMERA)) {
      return "granted"
    }
    return if (wasPermissionRequested("camera")) "denied" else "prompt"
  }

  private fun locationPermissionState(): String {
    val locationManager = getSystemService(LocationManager::class.java) ?: return "unsupported"
    if (locationManager.allProviders.isEmpty()) {
      return "unsupported"
    }
    if (hasPermission(Manifest.permission.ACCESS_FINE_LOCATION) || hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)) {
      return "granted"
    }
    return if (wasPermissionRequested("location_foreground")) "denied" else "prompt"
  }

  private fun notificationPermissionState(): String {
    val enabled = NotificationManagerCompat.from(this).areNotificationsEnabled()
    if (Build.VERSION.SDK_INT < 33) {
      return if (enabled) "granted" else "denied"
    }
    if (hasPermission(Manifest.permission.POST_NOTIFICATIONS)) {
      return "granted"
    }
    if (!enabled && wasPermissionRequested("notifications")) {
      return "denied"
    }
    return if (wasPermissionRequested("notifications")) "denied" else "prompt"
  }

  private fun hasPermission(permission: String): Boolean {
    return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
  }

  private fun rememberPermissionRequest(permission: String) {
    nativePrefs.edit().putBoolean("permission.$permission", true).apply()
  }

  private fun wasPermissionRequested(permission: String): Boolean {
    return nativePrefs.getBoolean("permission.$permission", false)
  }

  private fun sendBridgePayload(hookName: String, payload: JSONObject) {
    val json = payload.toString()
    webView.post {
      webView.evaluateJavascript("globalThis.$hookName?.($json);", null)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    webView = WebView(this)
    setContentView(webView)

    if (capabilities.allows("blob_store")) {
      blobStore =
        try {
          NativeBlobStore(this, capabilities)
        } catch (err: NativeBlobStoreError) {
          telemetry.emitNativeEvent(
            eventClass = "runtime.error",
            name = "blob_store.init_failed",
            severity = "error",
            attributes =
              mapOf(
                "x07.device.platform" to "android",
                "x07.device.reason" to err.codeName,
              ),
            body = err.message,
          )
          null
        }
    }

    webView.settings.javaScriptEnabled = true
    webView.settings.domStorageEnabled = true
    webView.settings.allowFileAccess = false
    webView.settings.allowContentAccess = false
    webView.settings.allowFileAccessFromFileURLs = false
    webView.settings.allowUniversalAccessFromFileURLs = false
    webView.addJavascriptInterface(X07IpcBridge(this, telemetry), "ipc")
    webView.setOnDragListener { _, event ->
      when (event.action) {
        DragEvent.ACTION_DRAG_STARTED -> capabilities.allows("files.drop")
        DragEvent.ACTION_DROP -> {
          handleDroppedClipData(event.clipData)
          true
        }
        else -> event.clipData?.itemCount?.let { it >= 0 } ?: false
      }
    }

    val assetLoader = WebViewAssetLoader.Builder()
      .addPathHandler("/assets/", X07AssetsPathHandler(this))
      .build()

    webView.webViewClient = object : WebViewClient() {
      private fun allowlistNavigation(request: WebResourceRequest): Boolean {
        val url = request.url
        val scheme = url.scheme ?: return false
        if (scheme == "x07") return true
        if (scheme == "about" && url.toString() == "about:blank") return true
        return scheme == "https" && url.host == "appassets.androidplatform.net"
      }

      override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest,
      ): Boolean {
        if (allowlistNavigation(request)) return false
        Log.w("x07", "blocked navigation: ${request.url}")
        return true
      }

      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
      ): WebResourceResponse? {
        return assetLoader.shouldInterceptRequest(request.url)
      }

      override fun onRenderProcessGone(
        view: WebView,
        detail: RenderProcessGoneDetail,
      ): Boolean {
        telemetry.emitNativeEvent(
          eventClass = "host.webview_crash",
          name = "host.webview_crash",
          severity = "error",
          attributes =
            mapOf(
              "hook" to "android.onRenderProcessGone",
              "did_crash" to detail.didCrash(),
              "renderer_priority_at_exit" to detail.rendererPriorityAtExit(),
            ),
        )
        Log.e("x07", "webview render process gone; didCrash=${detail.didCrash()}")
        return true
      }
    }

    webView.loadUrl("https://appassets.androidplatform.net/assets/x07/index.html")
  }

  override fun onDestroy() {
    super.onDestroy()
    for (task in scheduledNotifications.values) {
      mainHandler.removeCallbacks(task)
    }
    scheduledNotifications.clear()
    clearLocationRequest()
    ioExecutor.shutdownNow()
  }
}
