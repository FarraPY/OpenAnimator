import UIKit

/// Liquid Glass de iOS 26 sobre la columna de nombres de las pistas del timeline. La página dice dónde va cada panel, con
/// qué color, ícono y nombre (glass.set); acá sólo se dibuja: los toques pasan a la página (que tiene ahí su propia
/// columna, transparente). Antes de iOS 26 no hace nada y la página dibuja su vidrio con CSS.
final class GlassOverlay {
    private final class Cell {
        let view = UIVisualEffectView(effect: nil)
        let icon = UIImageView()
        let label = UILabel()
        var color = ""
    }

    private let container = UIView()
    private var cells: [String: Cell] = [:]

    init(in host: UIView) {
        container.isUserInteractionEnabled = false
        container.clipsToBounds = true
        container.isHidden = true
        host.addSubview(container)
    }

    /// {clip: {x, y, w, h}, items: [{id, name, kind, color: "rgb(…)", x, y, w, h}]} en puntos de la pantalla; sin
    /// items, se esconde. Devuelve si hay Liquid Glass (iOS 26).
    func set(_ a: [String: Any]) -> Bool {
        guard #available(iOS 26.0, *) else { return false }
        let items = a["items"] as? [[String: Any]] ?? []
        guard let clip = a["clip"] as? [String: Any], !items.isEmpty else {
            container.isHidden = true
            return true
        }
        let num = { (d: [String: Any], k: String) -> CGFloat in CGFloat((d[k] as? NSNumber)?.doubleValue ?? 0) }
        UIView.performWithoutAnimation {
            container.frame = CGRect(x: num(clip, "x"), y: num(clip, "y"), width: num(clip, "w"), height: num(clip, "h"))
            container.superview?.bringSubviewToFront(container)
            var seen = Set<String>()
            for it in items {
                let id = it["id"] as? String ?? ""
                seen.insert(id)
                let cell = cells[id] ?? add(id)
                let frame = CGRect(x: num(it, "x") - container.frame.minX, y: num(it, "y") - container.frame.minY, width: num(it, "w"), height: num(it, "h"))
                cell.view.frame = frame
                let colorText = it["color"] as? String ?? ""
                if cell.color != colorText {
                    cell.color = colorText
                    let color = GlassOverlay.color(colorText)
                    let glass = UIGlassEffect()
                    glass.tintColor = color.withAlphaComponent(0.42)
                    cell.view.effect = glass
                    cell.icon.tintColor = .white
                }
                cell.icon.image = UIImage(systemName: GlassOverlay.symbol(it["kind"] as? String), withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
                cell.label.text = it["name"] as? String
                let h = frame.height
                cell.icon.frame = CGRect(x: 13, y: (h - 20) / 2, width: 20, height: 20)
                cell.label.frame = CGRect(x: 39, y: 0, width: max(0, frame.width - 47), height: h)
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
        // El vidrio redondeado del lado de los clips; del otro, pegado al borde de la pantalla.
        cell.view.layer.cornerRadius = 16
        cell.view.layer.cornerCurve = .continuous
        cell.view.layer.maskedCorners = [.layerMaxXMinYCorner, .layerMaxXMaxYCorner]
        cell.view.clipsToBounds = true
        cell.icon.contentMode = .scaleAspectFit
        cell.label.font = .systemFont(ofSize: 13.5, weight: .semibold)
        cell.label.textColor = .white
        cell.label.adjustsFontSizeToFitWidth = true
        cell.label.minimumScaleFactor = 0.8
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
