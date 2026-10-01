import UIKit

/// Los menús de iOS (UIMenu) que salen de un botón de la página, como en las apps de Apple: donde la página marca
/// `data-menu`, acá va un botón invisible de iOS con ese menú (su vidrio, su animación, los íconos del sistema) y, al
/// elegir, se le avisa a la página (evento `menu`). La página dice dónde va cada uno y qué tiene (menu.layout); cuando
/// algo de la página tapa la pantalla (una ventana, una hoja), no manda ninguno.
final class NativeMenus {
    private var buttons: [String: (button: UIButton, sig: String)] = [:]
    weak var host: UIView?
    var onSelect: ((String, Int) -> Void)?

    /// [{key, x, y, w, h, title, sig, items: [{label, sf?, desc?, danger?, disabled?, checked?} | {sep: true}]}]
    func layout(_ items: [[String: Any]]) {
        guard let host else { return }
        let num = { (d: [String: Any], k: String) -> CGFloat in CGFloat((d[k] as? NSNumber)?.doubleValue ?? 0) }
        var seen = Set<String>()
        for it in items {
            guard let key = it["key"] as? String else { continue }
            seen.insert(key)
            var b: (button: UIButton, sig: String)
            if let have = buttons[key] { b = have } else {
                let button = UIButton(type: .custom)
                button.backgroundColor = .clear
                button.showsMenuAsPrimaryAction = true
                host.addSubview(button)
                b = (button: button, sig: "")
            }
            b.button.frame = CGRect(x: num(it, "x"), y: num(it, "y"), width: num(it, "w"), height: num(it, "h"))
            let sig = it["sig"] as? String ?? ""
            if b.sig != sig {
                b.button.menu = menu(key, it["title"] as? String ?? "", it["items"] as? [[String: Any]] ?? [])
                b.sig = sig
            }
            host.bringSubviewToFront(b.button)
            buttons[key] = b
        }
        for (key, b) in buttons where !seen.contains(key) {
            b.button.removeFromSuperview()
            buttons[key] = nil
        }
    }

    private func menu(_ key: String, _ title: String, _ entries: [[String: Any]]) -> UIMenu {
        UIMenu(title: title, children: children(key, entries))
    }

    /// Las opciones, en grupos (los separadores de la página) como en los menús de iOS, con submenús; cada opción
    /// avisa su número (`id`, el que puso la página).
    private func children(_ key: String, _ entries: [[String: Any]]) -> [UIMenuElement] {
        var groups: [[UIMenuElement]] = [[]]
        for e in entries {
            if e["sep"] as? Bool == true { groups.append([]); continue }
            let label = e["label"] as? String ?? ""
            let image = (e["sf"] as? String).flatMap { UIImage(systemName: $0) }
            if let sub = e["sub"] as? [[String: Any]] {
                groups[groups.count - 1].append(UIMenu(title: label, subtitle: e["desc"] as? String, image: image, children: children(key, sub)))
                continue
            }
            var attrs: UIMenuElement.Attributes = []
            if e["danger"] as? Bool == true { attrs.insert(.destructive) }
            if e["disabled"] as? Bool == true { attrs.insert(.disabled) }
            let id = (e["id"] as? NSNumber)?.intValue ?? -1
            groups[groups.count - 1].append(UIAction(title: label, subtitle: e["desc"] as? String, image: image, attributes: attrs,
                                                     state: e["checked"] as? Bool == true ? .on : .off) { [weak self] _ in self?.onSelect?(key, id) })
        }
        let parts = groups.filter { !$0.isEmpty }
        return parts.count == 1 ? parts[0] : parts.map { UIMenu(title: "", options: .displayInline, children: $0) }
    }
}
