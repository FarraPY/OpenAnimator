import UIKit
import WebKit

/// La pantalla de la app: un WKWebView con la interfaz, servida por SchemeHandler y conectada a lo nativo por Bridge.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private(set) var webView: WKWebView!
    private let schemes = SchemeHandler()
    private lazy var bridge = Bridge(controller: self)
    static let diagMode = ProcessInfo.processInfo.arguments.contains("-OADiag")
    /// Pruebas en el simulador: -OATest e2e corre src/iphone/test/e2e.ts; -OADev '{"env":…}' usa una API de mentira.
    static func argument(_ name: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
    private static let background = UIColor(red: 11 / 255, green: 12 / 255, blue: 15 / 255, alpha: 1)

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemes, forURLScheme: "oa")
        config.setURLSchemeHandler(schemes, forURLScheme: "oaproj")
        // La vista previa y la exportación reproducen video y audio sin un toque previo.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "oa")
        if Self.diagMode || Self.argument("-OATest") != nil {
            // Pruebas: lo que la página escribe en la consola (y sus errores) sale por la salida de la app.
            let forward = """
            (() => {
              const send = (lvl, args) => { try { window.webkit.messageHandlers.oa.postMessage({ op: 'log', text: lvl + ' ' + args.map((a) => { try { return typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a) } catch (e) { return String(a) } }).join(' ').slice(0, 3000) }) } catch (e) {} }
              for (const lvl of ['log', 'warn', 'error']) { const o = console[lvl]; console[lvl] = (...a) => { send(lvl, a); o.apply(console, a) } }
              addEventListener('error', (e) => send('onerror', [e.message, (e.filename || '') + ':' + (e.lineno || '')]))
              addEventListener('unhandledrejection', (e) => send('unhandled', [e.reason]))
            })()
            """
            config.userContentController.addUserScript(WKUserScript(source: forward, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        if let test = Self.argument("-OATest") {
            var js = "window.__oaTest = \(Self.json(test));"
            if let dev = Self.argument("-OADev") { js += "try { localStorage.setItem('oa.claudeDev', \(Self.json(dev))) } catch (e) {}" }
            config.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
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
        if Self.diagMode || Self.argument("-OATest") != nil {
            // Si la prueba se traba, igual termina (la integración continua espera el resultado).
            let limit: Double = Self.diagMode ? 170 : 900
            DispatchQueue.main.asyncAfter(deadline: .now() + limit) { print("OA-DIAG-TIMEOUT"); fflush(stdout); exit(2) }
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
