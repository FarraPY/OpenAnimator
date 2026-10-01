import Foundation
import UIKit

/// El registro de la app: Documentos/logs/app.log (también se ve en la app Archivos). Lo escribe Swift, así queda
/// aunque se cierre el motor web: lo que manda la página (op log: errores, avisos, Claude, la exportación) y lo del
/// sistema (memoria, cierres del motor web, segundo plano, temperatura, ahorro de batería). Con «En vivo» (Ajustes ›
/// Depuración), cada línea va también a una computadora de la misma red (scripts/registro-remoto.mjs).
enum AppLog {
    private static let queue = DispatchQueue(label: "oa.log", qos: .utility)
    private static var handle: FileHandle?
    private static var size: UInt64 = 0
    private static let limit: UInt64 = 4 << 20 // al pasarlo, app.log → app.1.log
    private static var remote: URL?
    private static var outbox: [String] = []
    private static var sending = false
    private static var sentAt: Date?
    private static var lastTry: Date?
    /** Hay un error esperando: afuera de la red local se manda sin esperar la tanda (pero no más de una vez cada 10 s). */
    private static var urgent = false
    private static var lastError: String?
    private static var timer: DispatchSourceTimer?
    private static let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static var file: URL { Storage.data.appendingPathComponent("logs/app.log") }

    static func machine() -> String {
        var u = utsname()
        uname(&u)
        return withUnsafePointer(to: &u.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) } }
    }

    private static func thermal(_ s: ProcessInfo.ThermalState) -> String {
        switch s {
        case .nominal: return "normal"
        case .fair: return "tibio"
        case .serious: return "caliente (iOS baja la velocidad)"
        case .critical: return "crítico"
        @unknown default: return "?"
        }
    }

    /// Al arrancar: una línea con el equipo y lo que se escucha del sistema.
    static func start() {
        if let s = UserDefaults.standard.string(forKey: "oa.log.remote") { remote = URL(string: s) }
        let p = ProcessInfo.processInfo
        let app = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        write("app", "INFO", "Arranca OpenAnimator \(app) (\(build)) · \(machine()) · iOS \(UIDevice.current.systemVersion) · memoria \(p.physicalMemory >> 20) MB · temperatura \(thermal(p.thermalState))\(p.isLowPowerModeEnabled ? " · ahorro de batería" : "")")
        let nc = NotificationCenter.default
        nc.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil) { _ in
            write("sistema", "WARN", "Temperatura: \(thermal(ProcessInfo.processInfo.thermalState))")
        }
        nc.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: nil) { _ in
            write("sistema", "INFO", ProcessInfo.processInfo.isLowPowerModeEnabled ? "Ahorro de batería activado" : "Ahorro de batería desactivado")
        }
        nc.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil) { _ in write("sistema", "WARN", "iOS avisa que falta memoria") }
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { _ in write("app", "INFO", "En segundo plano") }
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { _ in write("app", "INFO", "De vuelta en primer plano") }
        nc.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: nil) { _ in write("app", "INFO", "La app se cierra") }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { send() }
        t.resume()
        timer = t
    }

    static func write(_ source: String, _ level: String, _ text: String) { add([(level, source, text, nil)]) }

    /// Líneas: nivel, origen, texto y, si viene de la página, cuándo pasó (ms desde 1970).
    static func add(_ lines: [(String, String, String, Double?)]) {
        let now = Date()
        queue.async {
            var out = ""
            for (level, source, text, t) in lines {
                let when = t.map { Date(timeIntervalSince1970: $0 / 1000) } ?? now
                out += "\(stamp.string(from: when)) \(level.padding(toLength: 5, withPad: " ", startingAt: 0)) [\(source)] \(redact(text).replacingOccurrences(of: "\n", with: "\n    "))\n"
            }
            append(Data(out.utf8))
            if remote != nil {
                outbox.append(out)
                if outbox.count > 3000 { outbox.removeFirst(outbox.count - 3000) }
                if lines.contains(where: { $0.0 == "ERROR" }) { urgent = true }
            }
        }
    }

    /// Nada de credenciales en el registro (ni en vivo).
    private static func redact(_ s: String) -> String {
        s.replacingOccurrences(of: "sk-ant-[A-Za-z0-9_-]{8,}", with: "sk-ant-…", options: .regularExpression)
            .replacingOccurrences(of: "(?i)(bearer|x-api-key[\"':= ]+)\\s*[A-Za-z0-9._~+/=-]{12,}", with: "$1 …", options: .regularExpression)
            .replacingOccurrences(of: "([?&](code|state)=)[A-Za-z0-9._~%-]{8,}", with: "$1…", options: .regularExpression)
    }

    private static func append(_ data: Data) {
        let fm = FileManager.default
        if handle == nil {
            try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !fm.fileExists(atPath: file.path) { fm.createFile(atPath: file.path, contents: nil) }
            handle = try? FileHandle(forWritingTo: file)
            size = (try? handle?.seekToEnd()) ?? 0
        }
        guard let h = handle else { return }
        try? h.write(contentsOf: data)
        size += UInt64(data.count)
        if size > limit {
            try? h.close()
            handle = nil
            let old = file.deletingLastPathComponent().appendingPathComponent("app.1.log")
            try? fm.removeItem(at: old)
            try? fm.moveItem(at: file, to: old)
        }
    }

    // MARK: en vivo

    /// http(s)://<computadora>:<puerto>/k/<clave> (lo muestra scripts/registro-remoto.mjs), o nil para apagarlo.
    static func setRemote(_ s: String?) -> [String: Any] {
        let url = s.flatMap { URL(string: $0.trimmingCharacters(in: .whitespacesAndNewlines)) }.flatMap { ["http", "https"].contains($0.scheme?.lowercased() ?? "") && $0.host != nil ? $0 : nil }
        queue.sync {
            remote = url
            outbox.removeAll()
            sentAt = nil
            lastError = nil
            if let url {
                UserDefaults.standard.set(url.absoluteString, forKey: "oa.log.remote")
                // Para tener contexto: lo último del registro va primero.
                if let h = try? FileHandle(forReadingFrom: file) {
                    let end = (try? h.seekToEnd()) ?? 0
                    try? h.seek(toOffset: end > 65_536 ? end - 65_536 : 0)
                    if let d = try? h.readToEnd(), !d.isEmpty { outbox.append("--- lo último del registro ---\n" + String(decoding: d, as: UTF8.self) + "--- en vivo ---\n") }
                    try? h.close()
                }
            } else {
                UserDefaults.standard.removeObject(forKey: "oa.log.remote")
            }
        }
        if url != nil { write("app", "INFO", "Registro en vivo encendido") }
        return status()
    }

    static func status() -> [String: Any] {
        queue.sync { () -> [String: Any] in
            var d: [String: Any] = ["pending": outbox.count, "size": Double(size)]
            d["remote"] = remote?.absoluteString
            d["sentAt"] = sentAt.map { $0.timeIntervalSince1970 * 1000 }
            d["error"] = lastError
            return d
        }
    }

    /// En la red local, lo nuevo cada segundo. Afuera (ntfy.sh, un túnel) en tandas de 30 s: ntfy.sh deja 250 mensajes
    /// por día. Si no responde, se guarda y se reintenta.
    private static func send() {
        guard let url = remote, !sending, !outbox.isEmpty else { return }
        let host = url.host?.lowercased() ?? ""
        let local = host == "localhost" || host.hasSuffix(".local") || ["10.", "127.", "192.168.", "172."].contains { host.hasPrefix($0) }
        let gap = Date().timeIntervalSince(lastTry ?? .distantPast)
        guard local || gap >= 30 || (urgent && gap >= 10) else { return }
        lastTry = Date()
        urgent = false
        let count = outbox.count
        var req = URLRequest(url: url, timeoutInterval: 5)
        req.httpMethod = "POST"
        req.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(outbox.joined().utf8)
        sending = true
        URLSession.shared.dataTask(with: req) { _, response, error in
            queue.async {
                sending = false
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                if error == nil, (200..<300).contains(code) {
                    outbox.removeFirst(min(count, outbox.count))
                    sentAt = Date()
                    lastError = nil
                } else {
                    lastError = error?.localizedDescription ?? "La computadora respondió \(code)"
                }
            }
        }.resume()
    }
}
