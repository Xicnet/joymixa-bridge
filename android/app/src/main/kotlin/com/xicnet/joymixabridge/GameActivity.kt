package com.xicnet.joymixabridge

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

class GameActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_game)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/game/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = findViewById(R.id.gameWebView)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?, request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url ?: return super.shouldInterceptRequest(view, request)

                val path = url.path ?: ""

                // Rewrite /assets/ to /game/game/assets/ so the asset loader serves fonts etc.
                if (url.host == "appassets.androidplatform.net" && path.startsWith("/assets/")) {
                    val rewritten = android.net.Uri.parse("https://appassets.androidplatform.net/game/game$path")
                    return assetLoader.shouldInterceptRequest(rewritten)
                        ?: super.shouldInterceptRequest(view, request)
                }

                // Redirect /api/ and /media/ requests to the real backend
                if (url.host == "appassets.androidplatform.net" && (path.startsWith("/api/") || path.startsWith("/media/"))) {
                    val realUrl = "https://test.joymixa.com${url.path}${url.query?.let { "?$it" } ?: ""}"
                    Log.d("GameWebView", "Proxying: $url → $realUrl")
                    try {
                        val conn = java.net.URL(realUrl).openConnection() as java.net.HttpURLConnection
                        conn.requestMethod = request.method
                        request.requestHeaders?.forEach { (key, value) ->
                            if (key.lowercase() != "host") conn.setRequestProperty(key, value)
                        }
                        if (request.method == "POST" || request.method == "PUT" || request.method == "PATCH") {
                            conn.doOutput = true
                        }
                        val statusCode = conn.responseCode
                        val contentType = conn.contentType ?: "application/json"
                        val mimeType = contentType.split(";")[0].trim()
                        val encoding = conn.contentEncoding ?: "utf-8"
                        val inputStream = if (statusCode in 200..299) conn.inputStream else conn.errorStream
                        val responseHeaders = mutableMapOf<String, String>()
                        conn.headerFields?.forEach { (key, values) ->
                            if (key != null && values.isNotEmpty()) {
                                responseHeaders[key] = values.last()
                            }
                        }
                        responseHeaders["Access-Control-Allow-Origin"] = "*"
                        return WebResourceResponse(mimeType, encoding, statusCode, conn.responseMessage ?: "OK", responseHeaders, inputStream)
                    } catch (e: Exception) {
                        Log.e("GameWebView", "Proxy error: ${e.message}")
                    }
                }

                return request.let { assetLoader.shouldInterceptRequest(it.url) }
                    ?: super.shouldInterceptRequest(view, request)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?, request: WebResourceRequest?
            ): Boolean = false

            override fun onReceivedHttpError(
                view: WebView?, request: WebResourceRequest?,
                errorResponse: WebResourceResponse?
            ) {
                Log.e("GameWebView", "HTTP error: ${request?.url} → ${errorResponse?.statusCode}")
            }

            override fun onReceivedError(
                view: WebView?, errorCode: Int, description: String?, failingUrl: String?
            ) {
                Log.e("GameWebView", "Error ($errorCode): $description @ $failingUrl")
            }
        }

        webView.addJavascriptInterface(LogRelayBridge(), "JoymixaBridge")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                msg?.let {
                    Log.d("GameWebView", "${it.messageLevel()}: ${it.message()} [${it.sourceId()}:${it.lineNumber()}]")
                }
                return true
            }
        }

        webView.loadUrl("https://appassets.androidplatform.net/game/game/index.html")
    }

    /** Native HTTP bridge for log-relay.ts — bypasses mixed-content restrictions. */
    private inner class LogRelayBridge {
        @JavascriptInterface
        fun relayLog(targetUrl: String, json: String) {
            Thread {
                try {
                    val conn = java.net.URL(targetUrl).openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.connectTimeout = 2000
                    conn.readTimeout = 2000
                    conn.doOutput = true
                    conn.outputStream.use { it.write(json.toByteArray()) }
                    conn.responseCode
                    conn.disconnect()
                } catch (_: Exception) { }
            }.start()
        }
    }

    @Deprecated("Use onBackPressedDispatcher")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
