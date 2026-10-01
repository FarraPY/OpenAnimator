import UIKit

/// Liquid Glass de iOS 26 para la columna de nombres de las pistas del timeline: cubre todo ese costado (abajo de la
/// regla) con una pieza de vidrio por pista, teñida de su color, con el ícono y el nombre en blanco. La página dice dónde
/// va cada pista (glass.set) y cómo se ve (vidrio esmerilado o transparente y cuánto color); acá sólo se dibuja: los
/// toques pasan a la página, que tiene ahí su propia columna, transparente. Antes de iOS 26 no hace nada y la página
/// dibuja su vidrio con CSS.
final class GlassOverlay {
    private final class Cell {
        let view = UIVisualEffectView(effect: nil)
        let icon = UIImageView()
        let label = UILabel()
        var look = ""
    }

    private let container = UIView()
    private var cells: [String: Cell] = [:]

    init(in host: UIView) {
        container.isUserInteractionEnabled = false
        container.isHidden = true
        container.clipsToBounds = true // abajo de la regla: una pista que sube queda detrás de ella
        host.addSubview(container)
    }

    /// {clip: {x, y, w, h}, ruler, items: [{id, name, kind, color: "rgb(…)", x, y, w, h}], style: "regular" | "clear",
    /// tint: 0…1} en puntos de la pantalla (clip: lo visible del timeline, con la regla arriba, de `ruler` de alto; cada
    /// item: el lugar del nombre de una pista). Sin items, se esconde. Devuelve si hay Liquid Glass.
    func set(_ a: [String: Any]) -> Bool {
        guard #available(iOS 26.0, *) else { return false }
        let items = a["items"] as? [[String: Any]] ?? []
        guard let clip = a["clip"] as? [String: Any], !items.isEmpty else {
            container.isHidden = true
            return true
        }
        let num = { (d: [String: Any], k: String) -> CGFloat in CGFloat((d[k] as? NSNumber)?.doubleValue ?? 0) }
        let clear = a["style"] as? String == "clear"
        let tint = (a["tint"] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 0.5
        UIView.performWithoutAnimation {
            // Arriba a la izquierda del timeline y del ancho de la columna: si el timeline rebota en un borde, el
            // vidrio no se mueve ni se estira.
            let top = num(clip, "y") + num(a, "ruler")
            let colW = items.map { num($0, "w") }.max() ?? 116
            container.frame = CGRect(x: num(clip, "x"), y: top, width: colW, height: max(0, num(clip, "y") + num(clip, "h") - top))
            container.superview?.bringSubviewToFront(container)
            var seen = Set<String>()
            for it in items {
                let id = it["id"] as? String ?? ""
                seen.insert(id)
                let cell = cells[id] ?? add(id)
                let rgb = it["color"] as? String ?? ""
                let look = "\(clear) \(tint) \(rgb)"
                if cell.look != look {
                    let glass = UIGlassEffect(style: clear ? .clear : .regular)
                    glass.tintColor = GlassOverlay.color(rgb).withAlphaComponent(tint)
                    cell.view.effect = glass
                    cell.look = look
                }
                // Todo el alto de la pista menos la línea que la separa de la siguiente.
                cell.view.frame = CGRect(x: 0, y: num(it, "y") - top, width: colW, height: max(0, num(it, "h") - 1))
                let h = cell.view.bounds.height
                cell.icon.image = UIImage(systemName: GlassOverlay.symbol(it["kind"] as? String), withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
                cell.icon.frame = CGRect(x: 13, y: (h - 22) / 2, width: 22, height: 22)
                cell.label.text = it["name"] as? String
                cell.label.frame = CGRect(x: 42, y: 0, width: max(0, colW - 48), height: h)
            }
            for (id, cell) in cells where !seen.contains(id) {
                cell.view.removeFromSuperview()
                cells[id] = nil
            }
            container.isHidden = false
        }
        return true
    }

    func hide() { container.isHidden = true }

    private func add(_ id: String) -> Cell {
        let cell = Cell()
        cell.icon.contentMode = .scaleAspectFit
        cell.icon.tintColor = .white
        cell.label.font = .systemFont(ofSize: 15, weight: .semibold)
        cell.label.textColor = .white
        cell.label.adjustsFontSizeToFitWidth = true
        cell.label.minimumScaleFactor = 0.75
        cell.view.contentView.addSubview(cell.icon)
        cell.view.contentView.addSubview(cell.label)
        container.addSubview(cell.view)
        cells[id] = cell
        return cell
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
