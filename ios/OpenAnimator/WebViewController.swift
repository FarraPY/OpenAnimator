import UIKit
import WebKit

/// La pantalla de la app: un WKWebView transparente con la interfaz (servida por SchemeHandler y conectada a lo nativo
/// por Bridge) sobre el fondo y el Liquid Glass de iOS (NativeChrome, que ubica la página: glass.layout).
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private(set) var webView: WKWebView!
    private let backHint = UIImageView(image: UIImage(systemName: "chevron.backward.circle.fill"))
    let chrome = NativeChrome()
    /// Los menús de iOS que salen de los botones de la página (los ubica la página: menu.layout).
    let menus = NativeMenus()
    private let schemes = SchemeHandler()
    /// La vista previa del editor, en su propia vista web (la ubica la página: preview.*).
    private(set) lazy var preview = NativePreview(schemes: schemes)
    /// La captura de la exportación, en su propia vista web (cap.*).
    private(set) lazy var capture = NativeCapture(schemes: schemes)
    private lazy var bridge = Bridge(controller: self)
    static let diagMode = ProcessInfo.processInfo.arguments.contains("-OADiag")
    /// Pruebas en el simulador: -OATest e2e corre src/iphone/test/e2e.ts; -OADev '{"env":…}' usa una API de mentira.
    static func argument(_ name: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
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
            config.userContentController.addUserScript(WKUserScript(source: forward, injectionTime: .atDocumentStart, forMainFrameOnly: false))
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
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.contentInsetAdjustmentBehavior = .never // la página maneja las áreas seguras (viewport-fit=cover)
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = false
        webView = web
        // Abajo el fondo y el vidrio; arriba la página, transparente.
        let root = UIView()
        chrome.embed(preview.view)
        chrome.embed(capture.view)
        root.addSubview(chrome.view)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.addSubview(web)
        view = root
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        chrome.resize(view.bounds)
        preview.view.frame = view.bounds
        capture.view.frame = view.bounds
        webView.frame = view.bounds
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        menus.host = view
        menus.onSelect = { [weak self] key, index in self?.emit("menu", ["key": key, "index": index]) }
        preview.onMessage = { [weak self] m in self?.emit("preview", m) }
        load()
        let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgePan(_:)))
        edge.edges = .left
        view.addGestureRecognizer(edge)
        backHint.tintColor = UIColor(white: 1, alpha: 0.92)
        backHint.frame = CGRect(x: 0, y: 0, width: 38, height: 38)
        backHint.alpha = 0
        backHint.isUserInteractionEnabled = false
        view.addSubview(backHint)
        if Self.diagMode || Self.argument("-OATest") != nil {
            // Si la prueba se traba, igual termina (la integración continua espera el resultado).
            let limit: Double = Self.diagMode ? 170 : 900
            DispatchQueue.main.asyncAfter(deadline: .now() + limit) { print("OA-DIAG-TIMEOUT"); fflush(stdout); exit(2) }
        }
    }

    private func load(recovered: Bool = false, crashed: Bool = false) {
        chrome.clear()
        menus.layout([])
        preview.close()
        capture.close()
        let start = Self.diagMode ? "oa://localhost/__diag/index.html" : "oa://localhost/index.html" + (recovered ? "?recovered=1" : crashed ? "?crashed=1" : "")
        webView.load(URLRequest(url: URL(string: start)!))
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // La app va siempre en vertical; sólo la pantalla completa del video gira (y, si el video es horizontal, se pone
    // horizontal sola, como en las apps de video), sin la barra de estado ni la del inicio.
    private var fullScreen = false
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { fullScreen ? .allButUpsideDown : .portrait }
    override var prefersStatusBarHidden: Bool { fullScreen }
    override var prefersHomeIndicatorAutoHidden: Bool { fullScreen }

    func setFullScreen(_ on: Bool, landscape: Bool) {
        fullScreen = on
        setNeedsStatusBarAppearanceUpdate()
        setNeedsUpdateOfHomeIndicatorAutoHidden()
        setNeedsUpdateOfSupportedInterfaceOrientations()
        let want: UIInterfaceOrientationMask = on && landscape ? .landscape : .portrait
        view.window?.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: want)) { error in
            AppLog.write("app", "WARN", "No se pudo girar la pantalla: \(error.localizedDescription)")
        }
    }

    /// Volver deslizando desde el borde izquierdo, como en las apps de iOS: la página decide qué es volver (__oaBack).
    @objc private func edgePan(_ g: UIScreenEdgePanGestureRecognizer) {
        let x = g.translation(in: view).x
        let ready = x > 80 || (x > 30 && g.velocity(in: view).x > 700)
        switch g.state {
        case .began:
            view.bringSubviewToFront(backHint)
            fallthrough
        case .changed:
            backHint.center = CGPoint(x: 8 + min(x, 96) / 2, y: g.location(in: view).y)
            backHint.alpha = min(1, x / 70)
            backHint.transform = ready ? CGAffineTransform(scaleX: 1.15, y: 1.15) : .identity
        default:
            if g.state == .ended && ready { webView.evaluateJavaScript("window.__oaBack && window.__oaBack()", completionHandler: nil) }
            UIView.animate(withDuration: 0.2) {
                self.backHint.alpha = 0
                self.backHint.transform = .identity
            }
        }
    }

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
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { processTerminated(nil) }

    /// Lo mismo, con el motivo (método privado de WebKit: si está, WebKit llama a éste en vez del de arriba).
    @objc(_webView:webContentProcessDidTerminateWithReason:)
    func webContentProcessDidTerminate(_ webView: WKWebView, reason: Int) {
        // Un cierre por memoria de iOS (jetsam) también llega como 3: WebKit sólo ve que el proceso se cortó.
        let why = [0: "se pasó del límite de memoria", 1: "se pasó del límite de procesador", 2: "lo pidió la app", 3: "se colgó o se quedó sin memoria"][reason]
        processTerminated(why ?? "motivo " + String(reason))
    }

    /// iOS cerró el motor web: se vuelve a abrir la página y el proyecto. Si se cierra otra vez enseguida (un proyecto
    /// que no entra en memoria lo volvía a cerrar al reabrirse, sin fin), se vuelve al inicio sin reabrirlo.
    private var crashes: [Date] = []
    private func processTerminated(_ why: String?) {
        let now = Date()
        if let last = crashes.last, now.timeIntervalSince(last) < 0.5 { return } // los dos avisos de WebKit
        crashes = crashes.filter { now.timeIntervalSince($0) < 45 } + [now]
        let loop = crashes.count >= 2
        let detail = why.map { " (" + $0 + ")" } ?? " (casi siempre por falta de memoria)"
        AppLog.write("app", "ERROR", "iOS cerró el motor web" + detail + ": "
            + (loop ? "otra vez enseguida, se vuelve al inicio sin reabrir el proyecto" : "se vuelve a abrir la página"))
        if loop { crashes.removeAll() }
        load(recovered: !loop, crashed: loop)
    }

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
