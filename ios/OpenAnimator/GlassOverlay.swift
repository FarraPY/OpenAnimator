import UIKit

/// Liquid Glass de iOS 26 para la columna de nombres de las pistas del timeline: un solo vidrio que cubre todo ese
/// costado (abajo de la regla), sin cortes entre pistas; cada pista lo tiñe apenas con su color y lleva su ícono de ese
/// color, el nombre y una línea fina abajo. La página dice dónde va cada pista (glass.set) y cómo se ve (vidrio
/// transparente o esmerilado, cuánto color); acá sólo se dibuja: los toques pasan a la página, que tiene ahí su propia
/// columna, transparente. Antes de iOS 26 no hace nada y la página dibuja su vidrio con CSS.
final class GlassOverlay {
    private final class Row {
        let wash = UIView()
        let icon = UIImageView()
        let label = UILabel()
        let line = UIView()
        var views: [UIView] { [wash, icon, label, line] }
    }

    private let container = UIView()
    private let sheet = UIVisualEffectView(effect: nil)
    private var rows: [String: Row] = [:]
    private var style = ""

    init(in host: UIView) {
        container.isUserInteractionEnabled = false
        container.isHidden = true
        container.clipsToBounds = true // abajo de la regla: una pista que sube queda detrás de ella
        container.addSubview(sheet)
        host.addSubview(container)
    }

    /// {clip: {x, y, w, h}, ruler, items: [{id, name, kind, color: "rgb(…)", x, y, w, h}], style: "clear" | "regular",
    /// tint: 0…1} en puntos de la pantalla (clip: lo visible del timeline, con la regla arriba, de `ruler` de alto; cada
    /// item: el lugar del nombre de una pista). Sin items, se esconde. Devuelve si hay Liquid Glass.
    func set(_ a: [String: Any]) -> Bool {
        guard #available(iOS 26.0, *) else { return false }
        let items = a["items"] as? [[String: Any]] ?? []
        guard let clip = a["clip"] as? [String: Any], !items.isEmpty else {
            container.isHidden = true
            return true
        }
        let style = a["style"] as? String == "regular" ? "regular" : "clear"
        if style != self.style {
            sheet.effect = UIGlassEffect(style: style == "regular" ? .regular : .clear)
            self.style = style
        }
        let num = { (d: [String: Any], k: String) -> CGFloat in CGFloat((d[k] as? NSNumber)?.doubleValue ?? 0) }
        let tint = (a["tint"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 0.12
        let hair = 1 / max(1, container.traitCollection.displayScale)
        UIView.performWithoutAnimation {
            // Arriba a la izquierda del timeline y del ancho de la columna: si el timeline rebota en un borde, el
            // vidrio no se mueve ni se estira.
            let top = num(clip, "y") + num(a, "ruler")
            let colW = items.map { num($0, "w") }.max() ?? 116
            container.frame = CGRect(x: num(clip, "x"), y: top, width: colW, height: max(0, num(clip, "y") + num(clip, "h") - top))
            container.superview?.bringSubviewToFront(container)
            let bottom = (items.map { num($0, "y") + num($0, "h") }.max() ?? top) - top
            sheet.frame = CGRect(x: 0, y: 0, width: colW, height: max(0, min(container.bounds.height, bottom)))
            var seen = Set<String>()
            for (n, it) in items.enumerated() {
                let id = it["id"] as? String ?? ""
                seen.insert(id)
                let row = rows[id] ?? add(id)
                let color = GlassOverlay.color(it["color"] as? String ?? "")
                let y = num(it, "y") - top, h = num(it, "h")
                row.wash.backgroundColor = color.withAlphaComponent(tint)
                row.wash.frame = CGRect(x: 0, y: y, width: colW, height: h)
                row.icon.image = UIImage(systemName: GlassOverlay.symbol(it["kind"] as? String), withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
                row.icon.tintColor = color
                row.icon.frame = CGRect(x: 13, y: y + (h - 22) / 2, width: 22, height: 22)
                row.label.text = it["name"] as? String
                row.label.frame = CGRect(x: 42, y: y, width: max(0, colW - 48), height: h)
                row.line.isHidden = n == items.count - 1
                row.line.frame = CGRect(x: 0, y: y + h - hair, width: colW, height: hair)
            }
            for (id, row) in rows where !seen.contains(id) {
                row.views.forEach { $0.removeFromSuperview() }
                rows[id] = nil
            }
            container.isHidden = false
        }
        return true
    }

    func hide() { container.isHidden = true }

    private func add(_ id: String) -> Row {
        let row = Row()
        row.icon.contentMode = .scaleAspectFit
        row.label.font = .systemFont(ofSize: 15, weight: .semibold)
        row.label.textColor = .white
        row.label.adjustsFontSizeToFitWidth = true
        row.label.minimumScaleFactor = 0.75
        row.line.backgroundColor = UIColor.white.withAlphaComponent(0.1)
        row.views.forEach { sheet.contentView.addSubview($0) }
        rows[id] = row
        return row
    }

    /// "rgb(123, 108, 255)" (lo que da getComputedStyle) → UIColor.
    private static func color(_ s: String) -> UIColor {
        let n = s.split(whereSeparator: { !"0123456789.".contains($0) }).compactMap { Double($0) }
        guard n.count >= 3 else { return .systemIndigo }
        return UIColor(red: n[0] / 255, green: n[1] / 255, blue: n[2] / 255, alpha: 1)
    }

    /// El ícono del sistema (SF Symbols) de cada tipo de pista.
    private static func symbol(_ kind: String?) -> String {
        switch kind {
        case "scene": return "chevron.left.forwardslash.chevron.right"
        case "voice": return "mic.fill"
        case "music": return "music.note"
        case "sfx": return "waveform"
        case "video": return "film"
        case "image": return "photo"
        case "muted": return "speaker.slash.fill"
        case "hidden": return "eye.slash.fill"
        default: return "speaker.wave.2.fill"
        }
    }
}
