import Foundation

/// La red de iOS para lo que Claude Code manda a Anthropic (el chat, la prueba, la cuenta). Desde la página no se puede:
/// con una cuenta del plan, la API rechaza los pedidos que salen de un navegador («CORS requests are not allowed for
/// this Organization»). La respuesta vuelve por partes a la página (evento "net": head, chunk, end, error), así el
/// streaming de Claude sigue andando.
final class NetStream: NSObject, URLSessionDataDelegate {
    private let emit: (String, [String: Any]) -> Void
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "oa.net"
        return q
    }()
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 600 // Claude puede pensar un buen rato entre una parte y la siguiente
        c.timeoutIntervalForResource = 3 * 3600
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c, delegate: self, delegateQueue: queue)
    }()
    private var ids: [Int: String] = [:]
    private var tasks: [String: URLSessionDataTask] = [:]

    init(emit: @escaping (String, [String: Any]) -> Void) { self.emit = emit }

    /// Sólo Anthropic (https) o la propia máquina (http: la API de mentira de las pruebas).
    static func allowed(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased(), let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "https" { return ["api.anthropic.com", "platform.claude.com", "claude.ai", "console.anthropic.com"].contains(host) }
        return scheme == "http" && (host == "127.0.0.1" || host == "localhost")
    }

    func start(_ a: [String: Any]) throws {
        guard let id = a["id"] as? String, let s = a["url"] as? String, let url = URL(string: s), NetStream.allowed(url) else { throw Files.fail("Dirección no permitida") }
        var req = URLRequest(url: url)
        req.httpMethod = a["method"] as? String ?? "GET"
        // Lo de la conexión y la compresión lo pone iOS (y así descomprime solo).
        let skip: Set<String> = ["accept-encoding", "content-length", "host", "connection"]
        for (k, v) in a["headers"] as? [String: Any] ?? [:] where !skip.contains(k.lowercased()) { if let v = v as? String { req.setValue(v, forHTTPHeaderField: k) } }
        if let b = a["body"] as? String, !b.isEmpty { req.httpBody = Data(base64Encoded: b) }
        queue.addOperation {
            let task = self.session.dataTask(with: req)
            self.ids[task.taskIdentifier] = id
            self.tasks[id] = task
            task.resume()
        }
    }

    func cancel(_ id: String) { queue.addOperation { self.tasks[id]?.cancel() } }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let id = ids[dataTask.taskIdentifier] {
            let r = response as? HTTPURLResponse
            var headers: [String: String] = [:]
            // El cuerpo llega ya descomprimido: sin content-encoding ni content-length.
            for (k, v) in r?.allHeaderFields ?? [:] {
                let key = String(describing: k).lowercased()
                if key != "content-encoding" && key != "content-length" { headers[key] = String(describing: v) }
            }
            emit("net", ["id": id, "type": "head", "status": r?.statusCode ?? 200, "headers": headers])
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let id = ids[dataTask.taskIdentifier] else { return }
        emit("net", ["id": id, "type": "chunk", "data": data.base64EncodedString()])
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = ids.removeValue(forKey: task.taskIdentifier) else { return }
        tasks[id] = nil
        if let error {
            let canceled = (error as NSError).code == NSURLErrorCancelled
            emit("net", ["id": id, "type": "error", "message": canceled ? "cancelado" : error.localizedDescription])
        } else {
            emit("net", ["id": id, "type": "end"])
        }
    }
}
