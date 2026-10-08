// Trecho de referência — não compila sozinho (faltam imports do seu projeto,
// layout, etc.). Mostra o mínimo para hospedar a página 3DS e ler os eventos.
package io.autra.example.threeds

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

class ThreeDsWebViewActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true      // Cardinal e a página dependem de JS
            domStorageEnabled = true      // iframes da Cardinal usam localStorage
            // Não habilite allowFileAccess/allowUniversalAccessFromFileURLs: a página vem de https.
        }
        webView.webViewClient = WebViewClient() // mantém a navegação (inclusive iframes) dentro da WebView

        // Expõe window.AutraBridge.postMessage(json) para a página.
        webView.addJavascriptInterface(AutraBridge(::onBridgeMessage), "AutraBridge")

        // Em produção: https://<seu-backend>/3ds.html
        webView.loadUrl(intent.getStringExtra(EXTRA_URL) ?: "https://seu-backend.example.com/3ds.html")
    }

    /** Chamado na thread da WebView (não é a main thread). */
    private fun onBridgeMessage(json: String) {
        val msg = runCatching { JSONObject(json) }.getOrNull() ?: return
        val event = msg.optString("event")
        val data = msg.optJSONObject("data") ?: JSONObject()
        runOnUiThread {
            when (event) {
                "3DS_CHALLENGE_STARTED" -> {
                    // O portador vai interagir com o iframe do emissor: não feche a tela.
                }
                "3DS_RESULT" -> {
                    // data.eciRaw / data.vres_enrolled dizem se houve autenticação plena (ver README).
                }
                "PAYMENT_RESULT" -> {
                    val approved = data.optString("status") == "ACCEPTED"
                    finishWithResult(approved, data.optString("paymentID"))
                }
                "3DS_CHALLENGE_TIMEOUT", "ERROR" -> {
                    // data.code / data.msg / data.requestId — mostre ao usuário e guarde o requestId p/ suporte.
                    finishWithResult(false, null)
                }
                // 3DS_SETUP_DONE, 3DS_DDC_DONE, 3DS_AUTH_FRICTIONLESS, 3DS_CHALLENGE_COMPLETE: só progresso.
            }
        }
    }

    private fun finishWithResult(approved: Boolean, paymentId: String?) {
        setResult(if (approved) RESULT_OK else RESULT_CANCELED)
        finish()
    }

    /** Objeto exposto à página. O nome do método precisa ser `postMessage`. */
    private class AutraBridge(private val onMessage: (String) -> Unit) {
        @JavascriptInterface
        fun postMessage(json: String) = onMessage(json)
    }

    companion object {
        const val EXTRA_URL = "url"
    }
}
