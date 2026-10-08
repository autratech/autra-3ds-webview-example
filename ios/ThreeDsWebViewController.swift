// Trecho de referência — não compila sozinho. Mostra o mínimo para hospedar a
// página 3DS numa WKWebView e ler os eventos enviados pela página.
import UIKit
import WebKit

final class ThreeDsWebViewController: UIViewController, WKScriptMessageHandler {

    private var webView: WKWebView!
    private let pageURL: URL   // ex.: https://seu-backend.example.com/3ds.html
    var onFinished: ((_ approved: Bool, _ paymentID: String?) -> Void)?

    init(pageURL: URL) {
        self.pageURL = pageURL
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("não usado") }

    override func viewDidLoad() {
        super.viewDidLoad()

        let contentController = WKUserContentController()
        // Expõe window.webkit.messageHandlers.AutraBridge.postMessage(obj) para a página.
        contentController.add(self, name: "AutraBridge")

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        // JavaScript é habilitado por padrão; a Cardinal precisa dele nos iframes.

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(webView)
        webView.load(URLRequest(url: pageURL))
    }

    deinit {
        // Evita retain cycle: o handler segura uma referência forte ao controller.
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "AutraBridge")
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "AutraBridge",
              let body = message.body as? [String: Any],
              let event = body["event"] as? String else { return }
        let data = body["data"] as? [String: Any] ?? [:]

        switch event {
        case "3DS_CHALLENGE_STARTED":
            // O portador vai interagir com o iframe do emissor: não feche a tela.
            break
        case "3DS_RESULT":
            // data["eciRaw"] / data["vres_enrolled"]: ver tabela de interpretação no README.
            break
        case "PAYMENT_RESULT":
            let approved = (data["status"] as? String) == "ACCEPTED"
            onFinished?(approved, data["paymentID"] as? String)
        case "3DS_CHALLENGE_TIMEOUT", "ERROR":
            // data["code"], data["msg"], data["requestId"] — guarde o requestId para o suporte.
            onFinished?(false, nil)
        default:
            // 3DS_SETUP_DONE, 3DS_DDC_DONE, 3DS_AUTH_FRICTIONLESS, 3DS_CHALLENGE_COMPLETE: progresso.
            break
        }
    }
}
