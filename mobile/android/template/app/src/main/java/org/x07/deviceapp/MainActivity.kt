package org.x07.deviceapp

import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import java.io.InputStream
import java.util.Locale

private class X07IpcBridge {
  @JavascriptInterface
  fun postMessage(msg: String) {
    Log.i("x07", "ipc: $msg")
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

    val webView = WebView(this)
    setContentView(webView)

    webView.settings.javaScriptEnabled = true
    webView.settings.domStorageEnabled = true
    webView.addJavascriptInterface(X07IpcBridge(), "ipc")

    val assetLoader = WebViewAssetLoader.Builder()
      .addPathHandler("/assets/", X07AssetsPathHandler(this))
      .build()

    webView.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
      ): WebResourceResponse? {
        return assetLoader.shouldInterceptRequest(request.url)
      }
    }

    webView.loadUrl("https://appassets.androidplatform.net/assets/x07/index.html")
  }
}

