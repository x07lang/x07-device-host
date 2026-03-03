import SwiftUI
import WebKit

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
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      _ = userContentController
      _ = message
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
  }
}

