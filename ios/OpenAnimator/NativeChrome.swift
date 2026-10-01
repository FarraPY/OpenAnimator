import UIKit

/// El fondo de la app y el Liquid Glass de iOS 26, debajo de la página. La página es transparente: deja ver este fondo
/// (azul noche, con un resplandor arriba) y, donde marca `data-glass` (botones, barras, la hoja de abajo), dice dónde
/// va cada pieza (glass.layout); acá se dibuja el vidrio de iOS en ese lugar y la página dibuja encima sus íconos y
/// textos. Lo que la página pone por arriba (una ventana, un menú) tapa el vidrio como a cualquier otra cosa.
/// Antes de iOS 26 sólo queda el fondo y la página dibuja su vidrio con CSS. Entre el fondo y el vidrio va la vista previa
/// del editor (NativePreview, embed).
final class NativeChrome {
    let view = UIView()
    private let background = UIView()
    private let base = CAGradientLayer()
    private let glow = CAGradientLayer()
    private let pieces = UIView()
    private var glass: [String: (view: UIVisualEffectView, look: String)] = [:]

    init() {
        view.isUserInteractionEnabled = false
        view.backgroundColor = UIColor(red: 0.02, green: 0.035, blue: 0.07, alpha: 1)
        base.colors = [rgb(0x0d1a36), rgb(0x081024), rgb(0x050912)]
        base.locations = [0, 0.5, 1]
        glow.type = .radial
        glow.colors = [UIColor(red: 0.33, green: 0.45, blue: 1, alpha: 0.22).cgColor, UIColor(red: 0.33, green: 0.45, blue: 1, alpha: 0).cgColor]
        glow.startPoint = CGPoint(x: 0.5, y: 0.22)
        glow.endPoint = CGPoint(x: 1.25, y: 0.62)
        background.layer.addSublayer(base)
        background.layer.addSublayer(glow)
        view.addSubview(background)
        view.addSubview(pieces)
    }

    func resize(_ bounds: CGRect) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        view.frame = bounds
        background.frame = bounds
        pieces.frame = bounds
        base.frame = bounds
        glow.frame = bounds
        CATransaction.commit()
    }

    /// [{id, x, y, w, h, r, alpha?, tint?: "rgb(…)"|"rgba(…)", clear?}] en puntos de la pantalla, en el orden de la
    /// página (lo de adentro después: queda arriba). Lo que no viene se saca. Devuelve si hay Liquid Glass.
    func layout(_ items: [[String: Any]]) -> Bool {
        guard #available(iOS 26.0, *) else { return false }
        let num = { (d: [String: Any], k: String) -> CGFloat in CGFloat((d[k] as? NSNumber)?.doubleValue ?? 0) }
        UIView.performWithoutAnimation {
            var seen = Set<String>()
            for (i, it) in items.enumerated() {
                let id = it["id"] as? String ?? "\(i)"
                seen.insert(id)
                var g: (view: UIVisualEffectView, look: String)
                if let have = glass[id] { g = have } else {
                    let v = UIVisualEffectView(effect: nil)
                    v.layer.cornerCurve = .continuous
                    v.clipsToBounds = true
                    g = (view: v, look: "")
                }
                let tint = it["tint"] as? String ?? ""
                let clear = it["clear"] as? Bool ?? false
                let look = "\(clear) \(tint)"
                if g.look != look {
                    let effect = UIGlassEffect(style: clear ? .clear : .regular)
                    effect.tintColor = NativeChrome.color(tint)
                    g.view.effect = effect
                    g.look = look
                }
                g.view.frame = CGRect(x: num(it, "x"), y: num(it, "y"), width: num(it, "w"), height: num(it, "h"))
                g.view.layer.cornerRadius = min(num(it, "r"), min(g.view.bounds.width, g.view.bounds.height) / 2)
                g.view.alpha = (it["alpha"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 1
                pieces.insertSubview(g.view, at: i) // el orden de la página: lo de adentro, arriba
                glass[id] = g
            }
            for (id, g) in glass where !seen.contains(id) {
                g.view.removeFromSuperview()
                glass[id] = nil
            }
        }
        return true
    }

    func clear() { _ = layout([]) }

    /// La vista previa del editor (NativePreview): arriba del fondo y debajo del vidrio, así los controles de pantalla
    /// completa son vidrio de iOS sobre el video.
    func embed(_ v: UIView) { view.insertSubview(v, aboveSubview: background) }
    /// Detrás del fondo: en pantalla (WebKit la dibuja) pero sin que se vea.
    func embedBehind(_ v: UIView) { view.insertSubview(v, belowSubview: background) }

    private func rgb(_ hex: Int) -> CGColor {
        UIColor(red: CGFloat(hex >> 16 & 255) / 255, green: CGFloat(hex >> 8 & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1).cgColor
    }

    /// "rgb(123, 108, 255)" o "rgba(123, 108, 255, .5)" (lo que da getComputedStyle) → UIColor; vacío → sin tinte.
    private static func color(_ s: String) -> UIColor? {
        let n = s.split(whereSeparator: { !"0123456789.".contains($0) }).compactMap { Double($0) }
        guard n.count >= 3 else { return nil }
        return UIColor(red: n[0] / 255, green: n[1] / 255, blue: n[2] / 255, alpha: n.count > 3 ? n[3] : 1)
    }
}
