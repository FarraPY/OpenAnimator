import UIKit
import WebKit

/// La captura de la exportación en el iPhone (cap.* del puente, como Capture.java en Android): el compositor
/// (capture=1) en una vista web propia y cada fotograma, de takeSnapshot directo al codificador de iOS (NativeEncoder),
/// sin pasar por la página.
///
/// La vista mide el video ÷ la densidad de la pantalla (1920×1080 → 640×360 puntos) y el compositor tiene viewport del
/// ancho del video con escala 1/densidad: WebKit dibuja justo a la resolución del video (ni ×3 ni menos; ver
/// NativePreview: la escala de los contenedores no cuenta, la de la página sí) y las escenas ven devicePixelRatio 1, como
/// en la PC. Para que WebKit la dibuje tiene que estar en pantalla: va debajo de la página, detrás de la ventana de
/// exportar, achicada con una transformación (que WebKit no ve). Es otro proceso, con su propio límite de memoria.
/// Antes, el método «compatible» (copiar el DOM a una imagen dentro de la página) iba a 1,3 fps y con «Prueba de render»
/// el motor web de la interfaz pasaba los 2 GB en el fotograma 78.
final class NativeCapture: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let view = UIView()
    private var web: WKWebView?
    private let schemes: SchemeHandler
    /// El video en píxeles y la vista web en puntos.
    private var size = CGSize.zero, points = CGSize.zero
    private var startReply: ((Any?, String?) -> Void)?
    private var frameReply: ((Any?, String?) -> Void)?
    private var want = 0, wantPreview = false, frameStart = Date()
    private var timer: Timer?
    private var n = 0, totalMs = 0.0, snapMs = 0.0, encMs = 0.0, maxMs = 0.0

    init(schemes: SchemeHandler) {
        self.schemes = schemes
        super.init()
        view.isUserInteractionEnabled = false
        view.isHidden = true
    }

    /// {url, width, height}: abre el compositor y contesta cuando cargó (__oaCapReady).
    func start(_ a: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        close()
        guard let s = a["url"] as? String, let url = URL(string: s) else { reply(nil, "Falta la dirección del compositor"); return }
        let num = { (k: String, d: Double) -> CGFloat in CGFloat((a[k] as? NSNumber)?.doubleValue ?? d) }
        let scale = max(1, view.window?.screen.scale ?? 3)
        size = CGSize(width: num("width", 1920), height: num("height", 1080))
        points = CGSize(width: size.width / scale, height: size.height / scale)
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemes, forURLScheme: "oa")
        config.setURLSchemeHandler(schemes, forURLScheme: "oaproj")
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        let uc = config.userContentController
        uc.add(CaptureHandler(self), name: "oaCap")
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
        let w = WKWebView(frame: CGRect(origin: .zero, size: points), configuration: config)
        w.isInspectable = true
        w.navigationDelegate = self
        w.isOpaque = true
        w.backgroundColor = .black
        w.scrollView.backgroundColor = .black
        w.scrollView.isScrollEnabled = false
        w.scrollView.bounces = false
        w.scrollView.contentInsetAdjustmentBehavior = .never
        w.isUserInteractionEnabled = false
        // Entera en la pantalla (si no, WebKit no dibuja lo que queda afuera), detrás de la ventana de exportar.
        let b = view.bounds
        let fit = min(1, (b.width - 40) / points.width, b.height * 0.35 / points.height)
        w.transform = CGAffineTransform(scaleX: fit, y: fit)
        w.center = CGPoint(x: b.midX, y: b.height * 0.62)
        view.addSubview(w)
        view.isHidden = false
        web = w
        startReply = reply
        n = 0; totalMs = 0; snapMs = 0; encMs = 0; maxMs = 0; want = 0
        timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in self?.failStart("El compositor no cargó en 45 s") }
        w.load(URLRequest(url: url))
    }

    /// {t, preview}: deja el compositor en t, toma la imagen y la manda al codificador. Contesta {preview?} (un JPEG
    /// chico en base64, para la ventana de exportar) cuando el fotograma ya está en el video.
    func frame(_ a: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let web, startReply == nil else { reply(nil, "La captura no está abierta"); return }
        let t = (a["t"] as? NSNumber)?.doubleValue ?? 0
        want += 1
        wantPreview = a["preview"] as? Bool ?? false
        frameReply = reply
        frameStart = Date()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in self?.finishFrame(error: "La escena tardó más de 60 s en dibujar un fotograma") }
        web.evaluateJavaScript("__oaCap(\(t), \(want)); 0", completionHandler: nil)
    }

    /// Lo que se midió (para los detalles de la exportación).
    func stop() -> [String: Any] {
        let r: [String: Any] = ["mode": "ios", "frames": n, "msPerFrame": n > 0 ? totalMs / Double(n) : 0, "maxMs": maxMs,
                                "snapMs": n > 0 ? snapMs / Double(n) : 0, "encMs": n > 0 ? encMs / Double(n) : 0]
        close()
        return r
    }

    func close() {
        timer?.invalidate()
        failStart("cancelado")
        finishFrame(error: "cancelado")
        guard let w = web else { return }
        w.configuration.userContentController.removeScriptMessageHandler(forName: "oaCap")
        w.navigationDelegate = nil
        w.stopLoading()
        w.removeFromSuperview()
        web = nil
        view.isHidden = true
    }

    private func viewportScript() -> String {
        let s = points.width > 0 && size.width > 0 ? points.width / size.width : 1.0 / 3
        return """
        (() => { let m = document.querySelector('meta[name=viewport]'); if (!m) { m = document.createElement('meta'); m.name = 'viewport'; (document.head || document.documentElement).appendChild(m) }
          m.content = 'width=\(Int(size.width)), initial-scale=\(s), minimum-scale=\(s), maximum-scale=\(s), user-scalable=no' })()
        """
    }

    private func snap() {
        guard let web else { return }
        let cfg = WKSnapshotConfiguration()
        cfg.rect = CGRect(origin: .zero, size: points)
        cfg.snapshotWidth = NSNumber(value: Double(points.width))
        cfg.afterScreenUpdates = true
        let s0 = Date()
        web.takeSnapshot(with: cfg) { [weak self] image, error in
            guard let self else { return }
            guard let image, let cg = image.cgImage else {
                self.finishFrame(error: "No se pudo tomar la imagen del fotograma: " + (error?.localizedDescription ?? "sin imagen"))
                return
            }
            let snap = Date().timeIntervalSince(s0) * 1000
            let preview = self.wantPreview ? Self.jpeg(image, width: 480) : nil
            let e0 = Date()
            NativeEncoder.appendCaptured(cg) { err in
                DispatchQueue.main.async {
                    let total = Date().timeIntervalSince(self.frameStart) * 1000
                    self.n += 1; self.totalMs += total; self.snapMs += snap; self.encMs += Date().timeIntervalSince(e0) * 1000
                    self.maxMs = max(self.maxMs, total)
                    if let err { self.finishFrame(error: err) } else { self.finishFrame(result: preview.map { ["preview": $0] } ?? [:]) }
                }
            }
        }
    }

    private static func jpeg(_ img: UIImage, width: CGFloat) -> String? {
        let h = width * img.size.height / max(1, img.size.width)
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        let small = UIGraphicsImageRenderer(size: CGSize(width: width, height: h), format: fmt).image { _ in img.draw(in: CGRect(x: 0, y: 0, width: width, height: h)) }
        return small.jpegData(compressionQuality: 0.6)?.base64EncodedString()
    }

    private func failStart(_ why: String) {
        guard let reply = startReply else { return }
        startReply = nil
        timer?.invalidate()
        reply(nil, why)
        if why != "cancelado" { close() }
    }

    private func finishFrame(result: Any? = nil, error: String? = nil) {
        guard let reply = frameReply else { return }
        frameReply = nil
        timer?.invalidate()
        if let error { reply(nil, error) } else { reply(result ?? [:], nil) }
    }

    // MARK: mensajes y cierres

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.webView === web, let b = message.body as? [String: Any] else { return }
        if let r = b["ready"] {
            guard let reply = startReply else { return }
            if (r as? Bool) == true {
                startReply = nil
                timer?.invalidate()
                reply(["width": Double(size.width), "height": Double(size.height)], nil)
            } else { failStart("El compositor no cargó: \(r)") }
        } else if let e = b["error"] as? String {
            finishFrame(error: e)
        } else if let d = (b["done"] as? NSNumber)?.intValue, d == want, frameReply != nil {
            snap()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === web { webView.evaluateJavaScript(viewportScript(), completionHandler: nil) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === web else { return }
        AppLog.write("exportar", "ERROR", "iOS cerró la vista de captura de la exportación (casi siempre, falta de memoria)")
        let why = "iOS cerró la vista de captura (casi siempre, falta de memoria)"
        failStart(why)
        finishFrame(error: why)
        close()
    }
}

/// WKUserContentController retiene a su manejador: así NativeCapture no queda retenido por su propia vista web.
private final class CaptureHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
