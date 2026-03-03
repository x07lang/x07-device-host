import SwiftUI

@main
struct X07DeviceAppApp: App {
  var body: some Scene {
    WindowGroup {
      X07WebView()
        .ignoresSafeArea()
    }
  }
}

