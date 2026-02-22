import SwiftUI
import WebKit

struct GameWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.setValue(true, forKey: "allowUniversalAccessFromFileURLs")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.isScrollEnabled = false

        if let gameURL = Bundle.main.url(
            forResource: "index",
            withExtension: "html",
            subdirectory: "GameAssets"
        ) {
            let gameDir = gameURL.deletingLastPathComponent()
            webView.loadFileURL(gameURL, allowingReadAccessTo: gameDir)
        }

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
