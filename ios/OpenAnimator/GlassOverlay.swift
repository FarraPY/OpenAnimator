import UIKit

/// Liquid Glass de iOS 26 para la columna de nombres de las pistas del timeline, en dos estilos (para elegir con
/// capturas): «panel», un solo panel de vidrio flotando sobre la columna (como las barras laterales de iOS) con una fila
/// por pista (el ícono en un cuadrado del color de la pista, como en Ajustes, el nombre y un separador), y «chips», una
/// pieza de vidrio por pista, apenas teñida de su color. La página dice dónde va cada pista (glass.set); acá sólo se
/// dibuja: los toques pasan a la página, que tiene ahí su propia columna, transparente. Antes de iOS 26 no hace nada y
/// la página dibuja su vidrio con CSS.
final class GlassOverlay {
    private final class Row {
        let chip = UIVisualEffectView(effect: nil)
        let tile = UIView()
        let icon = UIImageView()
        let label = UILabel()
        let line = UIView()
        var color = ""
        var views: [UIView] { [chip, tile, icon, label, line] }
    }

    private let container = UIView()
    private let panel = UIVisualEffectView(effect: nil)
    private var rows: [String: Row] = [:]
    private var style = ""

    init(in host: UIView) {
        container.isUserInteractionEnabled = false
        container.clipsToBounds = true
        container.isHidden = true
        panel.layer.cornerRadius = 20
        panel.layer.cornerCurve = .continuous
        panel.clipsToBounds = true
        container.addSubview(panel)
        host.addSubview(container)
    }

    /// {clip: {x, y, w, h}, items: [{id, name, kind, color: "rgb(…)", x, y, w, h}], style: "panel" | "chips"} en puntos
    /// de la pantalla (clip: lo visible de las pistas; cada item: el lugar de su nombre). Sin items, se esconde.
    /// Devuelve si hay Liquid Glass.
    func set(_ a: [String: Any]) -> Bool {
        guard #available(iOS 26.0, *) else { return false }
        let items = a["items"] as? [[String: Any]] ?? []
        guard let clip = a["clip"] as? [String: Any], !items.isEmpty else {
            container.isHidden = true
            return true
        }
        let style = a["style"] as? String == "chips" ? "chips" : "panel"
        if style != self.style {
            for row in rows.values { row.views.forEach { $0.removeFromSuperview() } }
            rows = [:]
            self.style = style
            panel.effect = style == "panel" ? UIGlassEffect() : nil
            panel.isHidden = style != "panel"
        }
        let num = { (d: [String: Any], k: String) -> CGFloat in CGFloat((d[k] as? NSNumber)?.doubleValue ?? 0) }
        let hair = 1 / max(1, container.traitCollection.displayScale)
        UIView.performWithoutAnimation {
            let o = CGPoint(x: num(clip, "x"), y: num(clip, "y"))
            container.frame = CGRect(x: o.x, y: o.y, width: num(clip, "w"), height: num(clip, "h"))
            container.superview?.bringSubviewToFront(container)
            let colW = (items.map { num($0, "x") + num($0, "w") }.max() ?? 116) - o.x
            let bottom = (items.map { num($0, "y") + num($0, "h") }.max() ?? 0) - o.y
            if style == "panel" {
                panel.frame = CGRect(x: 6, y: 6, width: max(0, colW - 12), height: max(0, min(container.bounds.height, bottom) - 12))
            }
            var seen = Set<String>()
            for (n, it) in items.enumerated() {
                let id = it["id"] as? String ?? ""
                seen.insert(id)
                let row = rows[id] ?? add(id)
                let y = num(it, "y") - o.y, h = num(it, "h")
                let rgb = it["color"] as? String ?? ""
                let color = GlassOverlay.color(rgb)
                row.icon.image = UIImage(systemName: GlassOverlay.symbol(it["kind"] as? String), withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold))
                row.label.text = it["name"] as? String
                if style == "panel" {
                    let top = y - panel.frame.minY
                    row.tile.backgroundColor = color
                    row.tile.frame = CGRect(x: 8, y: top + (h - 26) / 2, width: 26, height: 26)
                    row.icon.tintColor = .white
                    row.icon.frame = row.tile.frame.insetBy(dx: 4, dy: 4)
                    row.label.frame = CGRect(x: 41, y: top, width: max(0, panel.bounds.width - 47), height: h)
                    row.line.isHidden = n == items.count - 1
                    row.line.frame = CGRect(x: 41, y: top + h - hair, width: max(0, panel.bounds.width - 41), height: hair)
                } else {
                    if row.color != rgb {
                        let glass = UIGlassEffect()
                        glass.tintColor = color.withAlphaComponent(0.22)
                        row.chip.effect = glass
                        row.color = rgb
                    }
                    row.chip.frame = CGRect(x: 6, y: y + 4, width: max(0, colW - 12), height: max(0, h - 8))
                    row.chip.layer.cornerRadius = min(16, row.chip.bounds.height / 2)
                    row.icon.tintColor = color
                    row.icon.frame = CGRect(x: 10, y: (row.chip.bounds.height - 20) / 2, width: 20, height: 20)
                    row.label.frame = CGRect(x: 35, y: 0, width: max(0, row.chip.bounds.width - 41), height: row.chip.bounds.height)
                }
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
        row.tile.layer.cornerRadius = 7
        row.tile.layer.cornerCurve = .continuous
        row.icon.contentMode = .scaleAspectFit
        row.label.font = .systemFont(ofSize: 14, weight: .semibold)
        row.label.textColor = .label
        row.label.adjustsFontSizeToFitWidth = true
        row.label.minimumScaleFactor = 0.75
        row.line.backgroundColor = .separator
        if style == "panel" {
            [row.tile, row.icon, row.label, row.line].forEach { panel.contentView.addSubview($0) }
        } else {
            row.chip.layer.cornerCurve = .continuous
            row.chip.clipsToBounds = true
            [row.icon, row.label].forEach { row.chip.contentView.addSubview($0) }
            container.addSubview(row.chip)
        }
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
