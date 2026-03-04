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
    webView.settings.allowFileAccess = false
    webView.settings.allowContentAccess = false
    webView.settings.allowFileAccessFromFileURLs = false
    webView.settings.allowUniversalAccessFromFileURLs = false
    webView.addJavascriptInterface(X07IpcBridge(), "ipc")

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
    }

    webView.loadUrl("https://appassets.androidplatform.net/assets/x07/index.html")
  }
}
