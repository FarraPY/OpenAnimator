import UIKit
import WebKit

/// La captura de la exportación en el iPhone (cap.* del puente, como Capture.java en Android): el compositor
/// (capture=1) en vistas web propias y cada fotograma, de takeSnapshot directo al codificador de iOS (NativeEncoder),
/// sin pasar por la página.
///
/// Cada vista mide el video ÷ la densidad de la pantalla (1920×1080 → 640×360 puntos) y el compositor tiene viewport del
/// ancho del video con escala 1/densidad: WebKit dibuja justo a la resolución del video (ni ×3 ni menos; ver
/// NativePreview: la escala de los contenedores no cuenta, la de la página sí) y las escenas ven devicePixelRatio 1, como
/// en la PC. Para que WebKit las dibuje tienen que estar en pantalla: van debajo de la página, detrás de la ventana de
/// exportar, achicadas con una transformación (que WebKit no ve).
///
/// Varias a la vez (`workers`, cada una su proceso): takeSnapshot espera a que el motor web entregue su próximo cuadro y
/// el servidor de Core Animation lo copie (WKWebViewIOS.mm: CARenderServerSnapshot), así que casi todo el tiempo de un
/// fotograma (~70 de 90 ms) es espera. Cada vista hace fotogramas distintos (se piden en orden y se reparten) y el
/// codificador los pone en el video por su número (NativeEncoder.appendCaptured).
/// Antes, el método «compatible» (copiar el DOM a una imagen dentro de la página) iba a 1,3 fps y con «Prueba de render»
/// el motor web de la interfaz pasaba los 2 GB en el fotograma 78.
final class NativeCapture: NSObject {
    typealias Reply = (Any?, String?) -> Void
    let view = UIView()
    private let schemes: SchemeHandler
    private var workers: [CaptureWorker] = []
    private var queue: [(i: Int, t: Double, preview: Bool, reply: Reply)] = []
    private var startReply: Reply?
    private var timer: Timer?
    private var n = 0, totalMs = 0.0, snapMs = 0.0, maxMs = 0.0, t0 = Date()

    init(schemes: SchemeHandler) {
        self.schemes = schemes
        super.init()
        view.isUserInteractionEnabled = false
        view.isHidden = true
    }

    /// {url, width, height, workers}: abre el compositor en cada vista y contesta cuando cargaron todas.
    func start(_ a: [String: Any], _ reply: @escaping Reply) {
        close()
        guard let s = a["url"] as? String, let url = URL(string: s) else { reply(nil, "Falta la dirección del compositor"); return }
        let num = { (k: String, d: Double) -> Double in (a[k] as? NSNumber)?.doubleValue ?? d }
        let scale = max(1, view.window?.screen.scale ?? 3)
        let size = CGSize(width: num("width", 1920), height: num("height", 1080))
        let points = CGSize(width: size.width / scale, height: size.height / scale)
        let count = max(1, min(6, Int(num("workers", 3))))
        // En una grilla de dos columnas en la mitad de abajo de la pantalla (detrás de la ventana de exportar).
        let b = view.bounds, cols = min(2, count), rows = (count + cols - 1) / cols
        let cellW = (b.width - 20) / CGFloat(cols), cellH = b.height * 0.4 / CGFloat(rows)
        let fit = min(1, cellW / points.width, cellH / points.height)
        startReply = reply
        n = 0; totalMs = 0; snapMs = 0; maxMs = 0; t0 = Date()
        let prefs = a["prefs"] as? [String: Any] ?? [:]
        if !prefs.isEmpty { AppLog.write("exportar", "INFO", "Ajustes de WebKit de la captura: \(prefs)") }
        for k in 0..<count {
            let w = CaptureWorker(schemes: schemes, size: size, points: points, prefs: prefs)
            w.web.transform = CGAffineTransform(scaleX: fit, y: fit)
            w.web.center = CGPoint(x: 10 + cellW * (CGFloat(k % cols) + 0.5), y: b.height * 0.55 + cellH * (CGFloat(k / cols) + 0.5))
            w.onReady = { [weak self] error in self?.workerReady(error) }
            w.onDead = { [weak self] why in self?.fail(why) }
            view.addSubview(w.web)
            workers.append(w)
            w.load(url)
        }
        view.isHidden = false
        timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in self?.failStart("El compositor no cargó en 45 s") }
    }

    /// {t, i, preview}: el fotograma i (en t) a la vista que esté libre. Contesta {preview?} (un JPEG chico en base64,
    /// para la ventana de exportar) cuando ya está en el video, en orden.
    func frame(_ a: [String: Any], _ reply: @escaping Reply) {
        guard !workers.isEmpty, startReply == nil else { reply(nil, "La captura no está abierta"); return }
        queue.append((i: (a["i"] as? NSNumber)?.intValue ?? n, t: (a["t"] as? NSNumber)?.doubleValue ?? 0, preview: a["preview"] as? Bool ?? false, reply: reply))
        pump()
    }

    private func pump() {
        for w in workers where w.idle && !queue.isEmpty {
            let r = queue.removeFirst()
            let started = Date()
            w.render(t: r.t) { [weak self] result in
                guard let self else { return }
                switch result {
                case .failure(let e):
                    r.reply(nil, e.message)
                    if e.message != "cancelado" { self.fail(e.message) }
                case .success(let shot):
                    let preview = r.preview ? Self.jpeg(shot.image, width: 480) : nil
                    NativeEncoder.appendCaptured(shot.cg, index: r.i) { err in
                        DispatchQueue.main.async {
                            let total = Date().timeIntervalSince(started) * 1000
                            self.n += 1; self.totalMs += total; self.snapMs += shot.snapMs; self.maxMs = max(self.maxMs, total)
                            if let err { r.reply(nil, err) } else { r.reply(preview.map { ["preview": $0] } ?? [:], nil) }
                        }
                    }
                }
                self.pump()
            }
        }
    }

    /// Lo que se midió (para los detalles de la exportación).
    func stop() -> [String: Any] {
        let wall = Date().timeIntervalSince(t0) * 1000
        let r: [String: Any] = ["mode": "ios", "frames": n, "workers": workers.count, "msPerFrame": n > 0 ? wall / Double(n) : 0,
                                "frameMs": n > 0 ? totalMs / Double(n) : 0, "maxMs": maxMs, "snapMs": n > 0 ? snapMs / Double(n) : 0]
        close()
        return r
    }

    func close() {
        timer?.invalidate()
        if !workers.isEmpty { NativeEncoder.failCaptured("cancelado") }
        failStart("cancelado")
        let pending = queue
        queue.removeAll()
        for r in pending { r.reply(nil, "cancelado") }
        for w in workers { w.close() }
        workers.removeAll()
        view.isHidden = true
    }

    private func workerReady(_ error: String?) {
        guard startReply != nil else { return }
        if let error { failStart(error); return }
        if workers.allSatisfy({ $0.ready }) {
            let reply = startReply
            startReply = nil
            timer?.invalidate()
            reply?(["workers": workers.count], nil)
        }
    }

    private func fail(_ why: String) {
        AppLog.write("exportar", "ERROR", why)
        NativeEncoder.failCaptured(why)
        failStart(why)
        let pending = queue
        queue.removeAll()
        for r in pending { r.reply(nil, why) }
        for w in workers { w.close() }
        workers.removeAll()
        view.isHidden = true
    }

    private func failStart(_ why: String) {
        guard let reply = startReply else { return }
        startReply = nil
        timer?.invalidate()
        reply(nil, why)
        if why != "cancelado" { close() }
    }

    static func jpeg(_ img: UIImage, width: CGFloat) -> String? {
        let h = width * img.size.height / max(1, img.size.width)
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        let small = UIGraphicsImageRenderer(size: CGSize(width: width, height: h), format: fmt).image { _ in img.draw(in: CGRect(x: 0, y: 0, width: width, height: h)) }
        return small.jpegData(compressionQuality: 0.6)?.base64EncodedString()
    }
}

struct CaptureError: Error { let message: String }

/// Una vista de captura: un proceso del motor web con el compositor, que hace un fotograma a la vez.
final class CaptureWorker: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let web: WKWebView
    private let size: CGSize, points: CGSize
    private(set) var ready = false
    private var busy = false
    var idle: Bool { ready && !busy }
    var onReady: (String?) -> Void = { _ in }
    var onDead: (String) -> Void = { _ in }
    private var done: ((Result<(cg: CGImage, image: UIImage, snapMs: Double), CaptureError>) -> Void)?
    private var want = 0
    private var timer: Timer?

    init(schemes: SchemeHandler, size: CGSize, points: CGSize, prefs: [String: Any] = [:]) {
        self.size = size
        self.points = points
        let config = WKWebViewConfiguration()
        WebKitFeatures.apply(prefs, to: config.preferences)
        config.setURLSchemeHandler(schemes, forURLScheme: "oa")
        config.setURLSchemeHandler(schemes, forURLScheme: "oaproj")
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        web = WKWebView(frame: CGRect(origin: .zero, size: points), configuration: config)
        super.init()
        let uc = config.userContentController
        uc.add(WorkerHandler(self), name: "oaCap")
        // El compositor avisa al poner __oaCapReady / __oaCapDone / __oaCapError (compositor.js, capture=1).
        uc.addUserScript(WKUserScript(source: """
        (() => {
          const post = (m) => { try { webkit.messageHandlers.oaCap.postMessage(m) } catch (e) {} }
          let ready = false, done = 0, error = ''
          Object.defineProperty(window, '__oaCapReady', { configurable: true, get: () => ready, set: (v) => { ready = v; post({ ready: v === true ? true : String(v) }) } })
          Object.defineProperty(window, '__oaCapDone', { configurable: true, get: () => done, set: (v) => { done = v; if (typeof v === 'number') post({ done: v }) } })
          Object.defineProperty(window, '__oaCapError', { configurable: true, get: () => error, set: (v) => { error = v; post({ error: String(v) }) } })
        })()
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        uc.addUserScript(WKUserScript(source: "Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true })",
                                      injectionTime: .atDocumentStart, forMainFrameOnly: false))
        uc.addUserScript(WKUserScript(source: "(document.head || document.documentElement).appendChild(Object.assign(document.createElement('style'), { textContent: 'html { -webkit-text-size-adjust: 100% !important; text-size-adjust: 100% !important; }' }))",
                                      injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        uc.addUserScript(WKUserScript(source: viewportScript(), injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web.isInspectable = true
        web.navigationDelegate = self
        web.isOpaque = true
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isUserInteractionEnabled = false
    }

    func load(_ url: URL) { web.load(URLRequest(url: url)) }

    func render(t: Double, _ completion: @escaping (Result<(cg: CGImage, image: UIImage, snapMs: Double), CaptureError>) -> Void) {
        busy = true
        want += 1
        done = completion
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in self?.finish(.failure(CaptureError(message: "La escena tardó más de 60 s en dibujar un fotograma"))) }
        web.evaluateJavaScript("__oaCap(\(t), \(want)); 0", completionHandler: nil)
    }

    func close() {
        timer?.invalidate()
        finish(.failure(CaptureError(message: "cancelado")))
        web.configuration.userContentController.removeScriptMessageHandler(forName: "oaCap")
        web.navigationDelegate = nil
        web.stopLoading()
        web.removeFromSuperview()
        ready = false
    }

    private func finish(_ r: Result<(cg: CGImage, image: UIImage, snapMs: Double), CaptureError>) {
        guard let d = done else { return }
        done = nil
        busy = false
        timer?.invalidate()
        d(r)
    }

    private func viewportScript() -> String {
        let s = points.width > 0 && size.width > 0 ? points.width / size.width : 1.0 / 3
        return """
        (() => { let m = document.querySelector('meta[name=viewport]'); if (!m) { m = document.createElement('meta'); m.name = 'viewport'; (document.head || document.documentElement).appendChild(m) }
          m.content = 'width=\(Int(size.width)), initial-scale=\(s), minimum-scale=\(s), maximum-scale=\(s), user-scalable=no' })()
        """
    }

    private func snap() {
        let cfg = WKSnapshotConfiguration()
        cfg.rect = CGRect(origin: .zero, size: points)
        cfg.snapshotWidth = NSNumber(value: Double(points.width))
        cfg.afterScreenUpdates = true
        let s0 = Date()
        web.takeSnapshot(with: cfg) { [weak self] image, error in
            guard let self else { return }
            guard let image, let cg = image.cgImage else {
                self.finish(.failure(CaptureError(message: "No se pudo tomar la imagen del fotograma: " + (error?.localizedDescription ?? "sin imagen"))))
                return
            }
            self.finish(.success((cg: cg, image: image, snapMs: Date().timeIntervalSince(s0) * 1000)))
        }
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.webView === web, let b = message.body as? [String: Any] else { return }
        if let r = b["ready"] {
            guard !ready else { return }
            if (r as? Bool) == true { ready = true; onReady(nil) } else { onReady("El compositor no cargó: \(r)") }
        } else if let e = b["error"] as? String {
            finish(.failure(CaptureError(message: e)))
        } else if let d = (b["done"] as? NSNumber)?.intValue, d == want, done != nil {
            snap()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript(viewportScript(), completionHandler: nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let why = "iOS cerró una vista de captura de la exportación (casi siempre, falta de memoria)"
        finish(.failure(CaptureError(message: why)))
        onDead(why)
    }
}

/// WKUserContentController retiene a su manejador: así la vista no queda retenida por sí misma.
private final class WorkerHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}

/// Ajustes internos de WebKit (los que Safari muestra en «Funciones de WebKit»), para medir con cuáles exporta más rápido:
/// {clave de UnifiedWebPreferences.yaml: true/false}, p. ej. AcceleratedFiltersEnabled (filtros con Core Image) o
/// UseGPUProcessForDOMRenderingEnabled. API privada (_features / _setEnabled:forFeature:): si no está, no hace nada.
enum WebKitFeatures {
    static func apply(_ prefs: [String: Any], to p: WKPreferences) {
        guard !prefs.isEmpty else { return }
        let list = NSSelectorFromString("_features"), set = NSSelectorFromString("_setEnabled:forFeature:")
        guard (WKPreferences.self as AnyObject).responds(to: list), p.responds(to: set),
              let all = (WKPreferences.self as AnyObject).perform(list)?.takeUnretainedValue() as? [NSObject] else { return }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        let fn = unsafeBitCast(p.method(for: set), to: Setter.self)
        for f in all {
            guard let key = f.value(forKey: "key") as? String, let on = prefs[key] as? Bool else { continue }
            fn(p, set, on, f)
        }
    }
}
