import UIKit
import WebKit

/// La vista previa del editor (el compositor, app/runtime/compositor.js) en una vista web propia, entre el fondo y el
/// vidrio de NativeChrome: la página deja transparente su lugar (Stage.tsx) y dice dónde va (preview.layout, glassUI.ts).
///
/// Por qué no un <iframe> de la página: el video (1920×1080) se achicaba con transform: scale() y WebKit dibuja lo de
/// adentro a tamaño completo × la densidad de la pantalla (×3), porque la escala de los contenedores no cuenta: sólo la
/// de la página (GraphicsLayerCA; bug 27684 de WebKit, abierto desde 2009). La escena CSS 3D de «Prueba de render» pasaba
/// los 2 GB y iOS cerraba la app entera. Acá el compositor tiene un viewport del ancho del video e iOS lo aleja para que
/// entre (escala de página): WebKit dibuja al tamaño de la pantalla (esa escena, ~470 MB en vez de más de 2 GB). Las
/// escenas ven devicePixelRatio 1, como al exportar (sus lienzos, a 1920×1080 y no a 5760×3240). Es otro proceso: tiene
/// su propio límite de memoria, si iOS lo cierra se rehace sólo el video, y las escenas no tienen el rAF a media
/// velocidad de un iframe de otro origen.
final class NativePreview: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    /// Ocupa la pantalla: transparente o, en pantalla completa, negro.
    let view = UIView()
    /// El lugar del video, con sus esquinas.
    private let clip = UIView()
    private var web: WKWebView?
    private var url: URL?
    private var width: CGFloat = 1920
    private let schemes: SchemeHandler
    private var settle: Timer?
    private var fitted = false
    private var crashes: [Date] = []
    /// Lo que manda el compositor ({source: 'oa-compositor', type, …}) y los cierres ({type: 'crashed'}).
    var onMessage: (Any) -> Void = { _ in }

    init(schemes: SchemeHandler) {
        self.schemes = schemes
        super.init()
        view.isUserInteractionEnabled = false
        clip.clipsToBounds = true
        clip.layer.cornerCurve = .continuous
        clip.backgroundColor = .black
        clip.isHidden = true
        view.addSubview(clip)
    }

    /// url: la del compositor (oaproj://…); width: el ancho del video en píxeles (el del viewport).
    func open(_ s: String, width w: Int) {
        close()
        guard let u = URL(string: s) else { return }
        url = u
        width = CGFloat(max(1, w))
        fitted = false
        crashes.removeAll()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(schemes, forURLScheme: "oa")
        config.setURLSchemeHandler(schemes, forURLScheme: "oaproj")
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        let uc = config.userContentController
        uc.add(WeakHandler(self), name: "oaPreview")
        // Todos los marcos (el compositor y cada escena): devicePixelRatio 1 y sin el agrandado automático de letra de iOS
        // en una página alejada (cambiaría los textos de la escena).
        uc.addUserScript(WKUserScript(source: "Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true })",
                                      injectionTime: .atDocumentStart, forMainFrameOnly: false))
        uc.addUserScript(WKUserScript(source: "(document.head || document.documentElement).appendChild(Object.assign(document.createElement('style'), { textContent: 'html { -webkit-text-size-adjust: 100% !important; text-size-adjust: 100% !important; }' }))",
                                      injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        uc.addUserScript(WKUserScript(source: viewportScript(), injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let w = WKWebView(frame: CGRect(origin: .zero, size: target()), configuration: config)
        w.isInspectable = true
        w.navigationDelegate = self
        w.isOpaque = true
        w.backgroundColor = .black
        w.scrollView.backgroundColor = .black
        w.scrollView.isScrollEnabled = false
        w.scrollView.bounces = false
        w.scrollView.contentInsetAdjustmentBehavior = .never
        w.isUserInteractionEnabled = false
        clip.addSubview(w)
        web = w
        fit()
        w.load(URLRequest(url: u))
    }

    func close() {
        settle?.invalidate()
        guard let w = web else { return }
        w.configuration.userContentController.removeScriptMessageHandler(forName: "oaPreview")
        w.navigationDelegate = nil
        w.stopLoading()
        w.removeFromSuperview()
        web = nil
        url = nil
    }

    /// Un mensaje para el compositor (lo que antes iba por postMessage al iframe).
    func post(_ msg: Any) {
        guard let web, JSONSerialization.isValidJSONObject(msg), let data = try? JSONSerialization.data(withJSONObject: msg) else { return }
        web.evaluateJavaScript("window.postMessage(\(String(decoding: data, as: UTF8.self)), '*')", completionHandler: nil)
    }

    /// {x, y, w, h, r (puntos de la pantalla), alpha, black (pantalla completa), hidden}.
    func layout(_ a: [String: Any]) {
        let num = { (k: String) -> CGFloat in CGFloat((a[k] as? NSNumber)?.doubleValue ?? 0) }
        UIView.performWithoutAnimation {
            view.backgroundColor = (a["black"] as? Bool ?? false) ? .black : .clear
            let hidden = a["hidden"] as? Bool ?? false
            clip.isHidden = hidden
            guard !hidden else { return }
            let frame = CGRect(x: num("x"), y: num("y"), width: num("w"), height: num("h"))
            let resized = frame.size != clip.bounds.size
            clip.frame = frame
            clip.layer.cornerRadius = num("r")
            clip.alpha = (a["alpha"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 1
            guard resized else { return }
            if !fitted { fit(); return }
            // Mientras cambia (la hoja que sube, pantalla completa) se estira sin volver a dibujar; quieto un momento,
            // toma el tamaño nuevo e iOS la dibuja a esa escala.
            place()
            settle?.invalidate()
            settle = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in self?.fit() }
        }
    }

    /// El tamaño de la vista web para el lugar actual. Al menos 1/10 del video: iOS no aleja una página más que eso
    /// (escala mínima 0,1); más chico, se achica con una transformación.
    private func target() -> CGSize {
        let size = clip.bounds.size
        let w = max(size.width, width * 0.1, 1)
        return CGSize(width: w, height: size.width > 0 ? w * size.height / size.width : w * 9 / 16)
    }

    private func fit() {
        guard let web else { return }
        fitted = clip.bounds.width > 0
        web.transform = .identity
        web.frame = CGRect(origin: .zero, size: target())
        place()
        web.evaluateJavaScript(viewportScript(), completionHandler: nil)
    }

    /// La vista web (de su tamaño) centrada y escalada al lugar del video.
    private func place() {
        guard let web, web.bounds.width > 0 else { return }
        let size = clip.bounds.size
        let s = size.width / web.bounds.width
        web.transform = CGAffineTransform(scaleX: s, y: s)
        web.center = CGPoint(x: size.width / 2, y: size.height / 2)
    }

    /// El viewport del compositor: el ancho del video, alejado justo para entrar en la vista web.
    private func viewportScript() -> String {
        let s = max(0.1, min(10, target().width / width))
        return """
        (() => { let m = document.querySelector('meta[name=viewport]'); if (!m) { m = document.createElement('meta'); m.name = 'viewport'; (document.head || document.documentElement).appendChild(m) }
          m.content = 'width=\(Int(width)), initial-scale=\(s), minimum-scale=\(s), maximum-scale=\(s), user-scalable=no' })()
        """
    }

    // MARK: mensajes y cierres

    /// La escala con el lugar de ahora (el guion del principio lleva la del momento en que se abrió, quizá sin lugar).
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === web { webView.evaluateJavaScript(viewportScript(), completionHandler: nil) }
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        // Sólo el compositor (el marco principal): las escenas, en sus iframes, no pueden hacerse pasar por él.
        guard message.frameInfo.isMainFrame, message.webView === web else { return }
        onMessage(message.body)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { terminated(webView, nil) }

    @objc(_webView:webContentProcessDidTerminateWithReason:)
    func webContentProcessDidTerminate(_ webView: WKWebView, reason: Int) { terminated(webView, reason) }

    /// iOS cerró el proceso de la vista previa: se vuelve a abrir (la página la deja en el mismo segundo). Tres veces en
    /// 30 s es una parte que no entra ni así: se deja de intentar hasta que la página la vuelva a abrir.
    private func terminated(_ webView: WKWebView, _ reason: Int?) {
        guard webView === web, let url else { return }
        let now = Date()
        if let last = crashes.last, now.timeIntervalSince(last) < 0.5 { return } // los dos avisos de WebKit
        crashes = crashes.filter { now.timeIntervalSince($0) < 30 } + [now]
        let gaveUp = crashes.count >= 3
        let why = reason.flatMap { [0: "se pasó del límite de memoria", 1: "se pasó del límite de procesador", 2: "lo pidió la app", 3: "se colgó o se quedó sin memoria"][$0] } ?? "casi siempre por falta de memoria"
        AppLog.write("app", "ERROR", "iOS cerró la vista previa (\(why)): " + (gaveUp ? "tercera vez en 30 s, no se vuelve a abrir sola" : "se vuelve a abrir sólo el video"))
        onMessage(["source": "oa-compositor", "type": "crashed", "gaveUp": gaveUp])
        if !gaveUp { webView.load(URLRequest(url: url)) }
    }
}

/// WKUserContentController retiene a su manejador: así NativePreview no queda retenido por su propia vista web.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
