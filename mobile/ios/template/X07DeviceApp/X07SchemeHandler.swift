import Foundation
import WebKit

final class X07SchemeHandler: NSObject, WKURLSchemeHandler {
  private let root: URL

  override init() {
    if let r = Bundle.main.resourceURL {
      self.root = r.appendingPathComponent("x07", isDirectory: true)
    } else {
      self.root = URL(fileURLWithPath: ".")
    }
    super.init()
  }

  func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
    guard let url = urlSchemeTask.request.url else {
      urlSchemeTask.didFailWithError(NSError(domain: "x07", code: 1))
      return
    }

    let rawPath = url.path.isEmpty || url.path == "/" ? "/index.html" : url.path
    guard let safePath = sanitizePath(rawPath) else {
      urlSchemeTask.didFailWithError(NSError(domain: "x07", code: 2))
      return
    }

    let fileUrl = root.appendingPathComponent(safePath)
    let data: Data
    do {
      data = try Data(contentsOf: fileUrl)
    } catch {
      urlSchemeTask.didFailWithError(error)
      return
    }

    let mime = mimeType(for: safePath)
    let encoding = (mime.hasPrefix("text/") || mime == "application/json") ? "utf-8" : nil
    let resp = URLResponse(
      url: url,
      mimeType: mime,
      expectedContentLength: data.count,
      textEncodingName: encoding
    )
    urlSchemeTask.didReceive(resp)
    urlSchemeTask.didReceive(data)
    urlSchemeTask.didFinish()
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
    _ = urlSchemeTask
  }

  private func sanitizePath(_ path: String) -> String? {
    var p = path
    if p.hasPrefix("/") {
      p.removeFirst()
    }
    if p.isEmpty {
      return "index.html"
    }
    if p.contains("..") {
      return nil
    }
    if p.contains("\\") {
      return nil
    }
    return p
  }

  private func mimeType(for path: String) -> String {
    let lower = path.lowercased()
    if lower.hasSuffix(".html") { return "text/html" }
    if lower.hasSuffix(".js") { return "text/javascript" }
    if lower.hasSuffix(".mjs") { return "text/javascript" }
    if lower.hasSuffix(".wasm") { return "application/wasm" }
    if lower.hasSuffix(".json") { return "application/json" }
    if lower.hasSuffix(".css") { return "text/css" }
    if lower.hasSuffix(".png") { return "image/png" }
    if lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg") { return "image/jpeg" }
    if lower.hasSuffix(".svg") { return "image/svg+xml" }
    return "application/octet-stream"
  }
}

