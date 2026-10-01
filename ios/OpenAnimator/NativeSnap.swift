import UIKit
import WebKit

/// Los fotogramas para Claude (oa_ver_fotogramas, hojas de contactos, miniaturas): snap.* del puente, como Snap.java en
/// Android. El compositor (capture=1) en una vista web propia, igual que una vista de la exportación (CaptureWorker:
/// dibujada justo a la resolución del video, devicePixelRatio 1), y cada imagen vuelve a la página como JPEG o PNG.
/// Antes iban por el compositor oculto de la página: modern-screenshot (lento) y, con escenas pesadas, la memoria del
/// motor web de la interfaz (ver NativePreview).
///
/// La vista va detrás del fondo de NativeChrome: en pantalla (si no, WebKit no la dibuja) pero tapada, así no se ve
/// mientras el usuario usa la app.
final class NativeSnap {
    typealias Reply = (Any?, String?) -> Void
    let view = UIView()
    private let schemes: SchemeHandler
    private var worker: CaptureWorker?
    private var openReply: Reply?
    private var timer: Timer?
    private var size = CGSize(width: 1920, height: 1080)

    init(schemes: SchemeHandler) {
        self.schemes = schemes
        view.isUserInteractionEnabled = false
        view.isHidden = true
    }

    /// {url, width, height}: abre el compositor y contesta {width, height} cuando cargó.
    func open(_ a: [String: Any], _ reply: @escaping Reply) {
        close()
        guard let s = a["url"] as? String, let url = URL(string: s) else { reply(nil, "Falta la dirección del compositor"); return }
        let num = { (k: String, d: Double) -> Double in (a[k] as? NSNumber)?.doubleValue ?? d }
        let scale = max(1, view.window?.screen.scale ?? 3)
        size = CGSize(width: num("width", 1920), height: num("height", 1080))
        let points = CGSize(width: size.width / scale, height: size.height / scale)
        let w = CaptureWorker(schemes: schemes, size: size, points: points, prefs: ["PreferPageRenderingUpdatesNear60FPSEnabled": false])
        let fit = min(1, view.bounds.width / 3 / max(1, points.width))
        w.web.transform = CGAffineTransform(scaleX: fit, y: fit)
        w.web.center = CGPoint(x: view.bounds.midX, y: view.bounds.maxY - points.height * fit)
        w.onReady = { [weak self] error in
            guard let self, let r = self.openReply else { return }
            self.openReply = nil
            self.timer?.invalidate()
            if let error { self.close(); r(nil, error) } else { r(["width": Int(self.size.width), "height": Int(self.size.height)], nil) }
        }
        w.onDead = { [weak self] why in
            AppLog.write("claude", "ERROR", "Fotogramas: \(why)")
            self?.close()
        }
        openReply = reply
        worker = w
        view.addSubview(w.web)
        view.isHidden = false
        w.load(url)
        timer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in
            guard let self, let r = self.openReply else { return }
            self.openReply = nil
            self.close()
            r(nil, "El compositor no cargó en 45 s")
        }
    }

    /// El proyecto o el timeline pudieron cambiar en disco: el compositor los vuelve a leer.
    func reload(_ reply: @escaping Reply) {
        guard let w = worker, w.ready else { reply(nil, "Los fotogramas no están abiertos"); return }
        w.web.callAsyncJavaScript("await window.__oaCompositor.reload(); return true", arguments: [:], in: nil, in: .page) { r in
            if case .failure(let e) = r { reply(nil, "El compositor no recargó: \(e.localizedDescription)") } else { reply(true, nil) }
        }
    }

    /// {t, width, format: jpeg|png, quality, cost}: el fotograma en t, de `width` píxeles de ancho como mucho, en base64;
    /// con cost, además lo que le cuesta a la escena (la medición mueve la escena: va después de la imagen).
    func frame(_ a: [String: Any], _ reply: @escaping Reply) {
        guard let w = worker, w.idle else { reply(nil, worker == nil ? "Los fotogramas no están abiertos" : "La vista de fotogramas está ocupada"); return }
        let t = (a["t"] as? NSNumber)?.doubleValue ?? 0
        let outW = CGFloat((a["width"] as? NSNumber)?.doubleValue ?? 1280)
        let png = (a["format"] as? String) == "png"
        let quality = CGFloat((a["quality"] as? NSNumber)?.doubleValue ?? 0.9)
        let cost = a["cost"] as? Bool ?? false
        let t0 = Date()
        w.render(t: t) { [weak self] result in
            switch result {
            case .failure(let e): reply(nil, e.message)
            case .success(let shot):
                let width = min(CGFloat(shot.cg.width), max(16, outW))
                let height = (width * CGFloat(shot.cg.height) / CGFloat(max(1, shot.cg.width))).rounded()
                let fmt = UIGraphicsImageRendererFormat()
                fmt.scale = 1
                fmt.opaque = true
                let img = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: fmt).image { _ in
                    UIImage(cgImage: shot.cg).draw(in: CGRect(x: 0, y: 0, width: width, height: height))
                }
                guard let data = png ? img.pngData() : img.jpegData(compressionQuality: max(0.5, min(1, quality))) else { reply(nil, "No se pudo codificar el fotograma"); return }
                let o: [String: Any] = ["data": data.base64EncodedString(), "mime": png ? "image/png" : "image/jpeg",
                                        "width": Int(width), "height": Int(height), "ms": Int(Date().timeIntervalSince(t0) * 1000)]
                guard cost, let web = self?.worker?.web else { reply(o, nil); return }
                // __oaCapCost deja el resultado en __oaCapCostResult (texto JSON) cuando termina.
                web.callAsyncJavaScript("""
                window.__oaCapCost(t)
                for (let i = 0; i < 400 && !window.__oaCapCostResult; i++) await new Promise((r) => setTimeout(r, 50))
                return window.__oaCapCostResult || ''
                """, arguments: ["t": t], in: nil, in: .page) { r in
                    var out = o
                    if case .success(let v) = r, let s = v as? String, let d = s.data(using: .utf8),
                       let c = try? JSONSerialization.jsonObject(with: d) as? [String: Any], c["error"] == nil { out["cost"] = c }
                    reply(out, nil)
                }
            }
        }
    }

    func close() {
        timer?.invalidate()
        if let r = openReply { openReply = nil; r(nil, "cancelado") }
        worker?.close()
        worker = nil
        view.isHidden = true
    }
}
