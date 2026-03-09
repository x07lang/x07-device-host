package org.x07.deviceapp

import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
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

private class X07IpcBridge(private val telemetry: X07TelemetryCoordinator) {
  @JavascriptInterface
  fun postMessage(msg: String) {
    if (!telemetry.handleIpc(msg)) {
      Log.i("x07", "ipc: $msg")
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

class MainActivity : AppCompatActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val telemetry = X07TelemetryCoordinator()
    val webView = WebView(this)
    setContentView(webView)

    webView.settings.javaScriptEnabled = true
    webView.settings.domStorageEnabled = true
    webView.settings.allowFileAccess = false
    webView.settings.allowContentAccess = false
    webView.settings.allowFileAccessFromFileURLs = false
    webView.settings.allowUniversalAccessFromFileURLs = false
    webView.addJavascriptInterface(X07IpcBridge(telemetry), "ipc")

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
}
