import UIKit
import WebKit

/// La pantalla de la app: un WKWebView con la interfaz, servida por SchemeHandler y conectada a lo nativo por Bridge.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private(set) var webView: WKWebView!
    private let schemes = SchemeHandler()
    private lazy var bridge = Bridge(controller: self)
    static let diagMode = ProcessInfo.processInfo.arguments.contains("-OADiag")
    private static let background = UIColor(red: 11 / 255, green: 12 / 255, blue: 15 / 255, alpha: 1)

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemes, forURLScheme: "oa")
        config.setURLSchemeHandler(schemes, forURLScheme: "oaproj")
        // La vista previa y la exportación reproducen video y audio sin un toque previo.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "oa")
        let web = WKWebView(frame: .zero, configuration: config)
        web.isInspectable = true
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = Self.background
        web.scrollView.backgroundColor = Self.background
        web.scrollView.contentInsetAdjustmentBehavior = .never // la página maneja las áreas seguras (viewport-fit=cover)
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = false
        webView = web
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        load()
        if Self.diagMode {
            // Si el diagnóstico se traba, igual termina (la integración continua espera el resultado).
            DispatchQueue.main.asyncAfter(deadline: .now() + 170) { print("OA-DIAG-TIMEOUT"); fflush(stdout); exit(2) }
        }
    }

    private func load(recovered: Bool = false) {
        let start = Self.diagMode ? "oa://localhost/__diag/index.html" : "oa://localhost/index.html" + (recovered ? "?recovered=1" : "")
        webView.load(URLRequest(url: URL(string: start)!))
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    /// Evento de lo nativo para la página (pause, resume, memory…), como window.__oaNativeEvent en Android.
    func emit(_ name: String, _ data: Any? = nil) {
        let payload = data.flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }.map { String(decoding: $0, as: UTF8.self) } ?? "null"
        let js = "window.__oaNativeEvent && window.__oaNativeEvent(\(Self.json(name)), \(payload))"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    static func json(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s], options: [])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }

    override func didReceiveMemoryWarning() {
        super.didReceiveMemoryWarning()
        emit("memory")
    }

    // MARK: navegación

    /// Si iOS cierra el proceso web (falta de memoria), la página vuelve a abrir el proyecto (como en Android).
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { load(recovered: true) }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { decisionHandler(.allow); return }
        // Un enlace a la web en la página principal (p. ej. en el chat) se abre en Safari; las escenas sí pueden
        // tener iframes de la web.
        if action.targetFrame?.isMainFrame != false, ["http", "https", "mailto", "tel"].contains(scheme) {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") { UIApplication.shared.open(url) }
        return nil
    }

    // MARK: alert / confirm / prompt (la interfaz usa sus propios diálogos; esto es por si una escena los usa)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Aceptar", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "Aceptar", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "Aceptar", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }
}
