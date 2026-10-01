import Foundation
import WebKit

/// Sirve todo lo que pide el WebView, desde la app (como el AppServer de Android y el Service Worker de la versión web):
///
///   oa://localhost/…                 la interfaz (dentro de la app)
///   oa://localhost/fs/<ruta>         un archivo de la carpeta de datos
///   oa://localhost/cc/<versión>/…    Claude Code instalado
///   oaproj://localhost/p/<id>/…      un proyecto (otro origen: una escena no puede tocar la app); a las escenas HTML se
///                                    les agrega el runtime, que vive en /p/<id>/__oa/ (el mismo origen que la escena)
///   oaproj://localhost/ut/<id>/…     plantillas del usuario
///
/// Los archivos grandes se mandan por partes y con Range (el visor de video pide tramos). Los dos esquemas son
/// "potencialmente confiables" para WebKit (schemeIsHandledBySchemeHandler): hay WebCodecs, WebCrypto, etc.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private var live = Set<ObjectIdentifier>() // tareas en curso (sólo en el hilo principal)
    private let io = DispatchQueue(label: "oa.scheme", qos: .userInitiated, attributes: .concurrent)
    private static let chunk = 1 << 20

    /// Con -OADiag/-OATest se anota cada pedido (para ver qué pide, p. ej., el reproductor de video).
    private static let trace = WebViewController.diagMode || WebViewController.argument("-OATest") != nil

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        live.insert(id)
        let request = task.request
        io.async { [weak self] in
            guard let self else { return }
            let reply = Self.route(request)
            if Self.trace, let url = request.url, url.path.hasSuffix(".mp4") || url.path.hasSuffix(".m4a") || url.path.contains("__diag") {
                let len: String
                switch reply.body { case .data(let d): len = "\(d.count)"; case .file(_, let off, let n): len = "\(off)+\(n)" }
                print("[scheme] \(request.httpMethod ?? "GET") \(url.absoluteString) Range=\(request.value(forHTTPHeaderField: "Range") ?? "-") → \(reply.status) \(len) \(request.allHTTPHeaderFields ?? [:])")
                fflush(stdout)
            }
            self.send(reply, to: task, id: id)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        live.remove(ObjectIdentifier(task))
    }

    // MARK: respuestas

    private enum Body { case data(Data), file(URL, offset: UInt64, length: UInt64) }
    private struct Reply { var status: Int; var headers: [String: String]; var body: Body }

    private static func text(_ status: Int, _ s: String) -> Reply {
        Reply(status: status, headers: ["Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store"], body: .data(Data(s.utf8)))
    }

    private static func route(_ request: URLRequest) -> Reply {
        guard let url = request.url, let scheme = url.scheme?.lowercased() else { return text(400, "URL inválida") }
        let path = url.path
        let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if scheme == "oaproj" {
            // /p/<id>/__oa/<resto> → runtime de la app; /p/<id>/<resto> → archivo del proyecto
            if parts.count >= 3, parts[0] == "p" {
                let id = parts[1]
                if parts[2] == "__oa" {
                    return file(Storage.app, "app/runtime/" + parts.dropFirst(3).joined(separator: "/"), request, appFile: true)
                }
                return file(Storage.data, "projects/\(id)/" + parts.dropFirst(2).joined(separator: "/"), request, runtimeFor: id)
            }
            if parts.count >= 2, parts[0] == "ut" { return file(Storage.data, "templates/" + parts.dropFirst().joined(separator: "/"), request) }
            if parts.first == "__diag" { return diag(Array(parts.dropFirst()), request) }
            return text(404, "No existe: \(path)")
        }
        // oa://
        if parts.first == "fs" { return file(Storage.data, parts.dropFirst().joined(separator: "/"), request) }
        if parts.first == "cc" {
            let rel = parts.dropFirst().joined(separator: "/")
            // Los trozos de Claude Code son módulos de JavaScript ("cli" no tiene extensión).
            let isCode = parts.last == "cli" || rel.hasSuffix(".js") || rel.hasSuffix(".mjs")
            var r = file(Storage.claude, rel, request, appFile: true)
            if isCode && r.status < 300 { r.headers["Content-Type"] = "text/javascript; charset=utf-8" }
            return r
        }
        if parts.first == "__diag" { return diag(Array(parts.dropFirst()), request) }
        let rel = parts.isEmpty ? "index.html" : parts.joined(separator: "/")
        let r = file(Storage.app, rel, request, appFile: true)
        // Una ruta de la interfaz que no es un archivo: la página principal.
        if r.status == 404 && !rel.contains(".") { return file(Storage.app, "index.html", request, appFile: true) }
        return r
    }

    /// Un archivo de `root`, entero o el tramo pedido (Range). A las escenas HTML de un proyecto se les agrega el runtime.
    private static func file(_ root: URL, _ rel: String, _ request: URLRequest, runtimeFor projectId: String? = nil, appFile: Bool = false) -> Reply {
        guard let url = Storage.resolve(root, rel) else { return text(403, "Ruta fuera de la carpeta") }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue else { return text(404, "No existe: \(rel)") }
        let type = Storage.mimeType(rel)
        var headers = ["Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": appFile ? "no-cache" : "no-store"]
        if let projectId, type.hasPrefix("text/html") {
            guard let data = try? Data(contentsOf: url) else { return text(500, "No se pudo leer \(rel)") }
            let html = injectRuntime(String(decoding: data, as: UTF8.self), projectId: projectId)
            return Reply(status: 200, headers: headers, body: .data(Data(html.utf8)))
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.uint64Value ?? 0
        if let range = request.value(forHTTPHeaderField: "Range"), let (start, end) = parseRange(range, size: size) {
            if start > end || start >= size {
                return Reply(status: 416, headers: ["Content-Range": "bytes */\(size)"], body: .data(Data()))
            }
            headers["Content-Range"] = "bytes \(start)-\(end)/\(size)"
            headers["Content-Length"] = String(end - start + 1)
            return Reply(status: 206, headers: headers, body: .file(url, offset: start, length: end - start + 1))
        }
        headers["Content-Length"] = String(size)
        return Reply(status: 200, headers: headers, body: .file(url, offset: 0, length: size))
    }

    private static func parseRange(_ header: String, size: UInt64) -> (UInt64, UInt64)? {
        guard header.hasPrefix("bytes="), size > 0 else { return nil }
        let spec = header.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
        let ab = spec.split(separator: "-", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
        guard ab.count == 2 else { return nil }
        if ab[0].isEmpty, let suffix = UInt64(ab[1]) { return (size - min(size, suffix), size - 1) } // los últimos N bytes
        guard let start = UInt64(ab[0]) else { return nil }
        let end = ab[1].isEmpty ? size - 1 : min(UInt64(ab[1]) ?? size - 1, size - 1)
        return (start, end)
    }

    /// El runtime de escenas, del mismo origen que la escena (como en la PC y en Android).
    private static func injectRuntime(_ html: String, projectId: String) -> String {
        if html.contains("oa-runtime.js") { return html }
        let id = projectId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? projectId
        let tag = "<script src=\"/p/\(id)/__oa/oa-runtime.js\"></script>"
        for pattern in ["<head[^>]*>", "<!doctype[^>]*>"] {
            if let r = html.range(of: pattern, options: [.regularExpression, .caseInsensitive]) {
                return html.replacingCharacters(in: r, with: html[r] + tag)
            }
        }
        return tag + html
    }

    /// Diagnóstico (sólo con -OADiag): los archivos de prueba y un eco del cuerpo de los PUT/POST.
    private static func diag(_ parts: [String], _ request: URLRequest) -> Reply {
        if parts == ["put"] {
            var count = request.httpBody?.count ?? -1
            if count < 0, let stream = request.httpBodyStream {
                stream.open()
                var buf = [UInt8](repeating: 0, count: 1 << 16)
                count = 0
                while stream.hasBytesAvailable {
                    let n = stream.read(&buf, maxLength: buf.count)
                    if n <= 0 { break }
                    count += n
                }
                stream.close()
                return text(200, "cuerpo por stream: \(count) bytes")
            }
            return text(200, count >= 0 ? "cuerpo: \(count) bytes" : "sin cuerpo")
        }
        return file(Storage.diag, parts.joined(separator: "/"), request, appFile: true)
    }

    // MARK: envío (por partes, en el hilo principal; nada después de stop)

    private func send(_ reply: Reply, to task: WKURLSchemeTask, id: ObjectIdentifier) {
        let response = HTTPURLResponse(url: task.request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        switch reply.body {
        case .data(let data):
            DispatchQueue.main.async {
                guard self.live.contains(id) else { return }
                task.didReceive(response)
                task.didReceive(data)
                task.didFinish()
                self.live.remove(id)
            }
        case .file(let url, let offset, let length):
            DispatchQueue.main.async {
                guard self.live.contains(id) else { return }
                task.didReceive(response)
                self.io.async { self.stream(url, offset: offset, left: length, task: task, id: id) }
            }
        }
    }

    private func stream(_ url: URL, offset: UInt64, left: UInt64, task: WKURLSchemeTask, id: ObjectIdentifier) {
        guard let fh = try? FileHandle(forReadingFrom: url) else {
            DispatchQueue.main.async {
                guard self.live.contains(id) else { return }
                task.didFailWithError(NSError(domain: "oa", code: 1, userInfo: [NSLocalizedDescriptionKey: "No se pudo abrir el archivo"]))
                self.live.remove(id)
            }
            return
        }
        defer { try? fh.close() }
        var pos = offset, remaining = left
        try? fh.seek(toOffset: pos)
        while remaining > 0 {
            let n = Int(min(UInt64(Self.chunk), remaining))
            guard let data = try? fh.read(upToCount: n), !data.isEmpty else { break }
            pos += UInt64(data.count)
            remaining -= UInt64(data.count)
            var stopped = false
            DispatchQueue.main.sync {
                if self.live.contains(id) { task.didReceive(data) } else { stopped = true }
            }
            if stopped { return }
        }
        DispatchQueue.main.async {
            guard self.live.contains(id) else { return }
            task.didFinish()
            self.live.remove(id)
        }
    }
}
