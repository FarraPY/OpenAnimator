import Foundation

/// Dónde vive cada cosa:
///   app     la interfaz y los recursos (dentro de la app, sólo lectura)
///   data    la carpeta de datos (proyectos, plantillas, exportaciones, ajustes): Documentos, se ve en la app Archivos
///   claude  Claude Code instalado (lo baja la app de npm), por versión; no se respalda en iCloud
enum Storage {
    static let app: URL = Bundle.main.resourceURL!.appendingPathComponent("www", isDirectory: true)
    static let diag: URL = Bundle.main.resourceURL!.appendingPathComponent("diag", isDirectory: true)
    static let data: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    static let claude: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("claude-code", isDirectory: true)

    static func prepare() {
        let fm = FileManager.default
        try? fm.createDirectory(at: data, withIntermediateDirectories: true)
        try? fm.createDirectory(at: claude, withIntermediateDirectories: true)
        var c = claude
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? c.setResourceValues(values)
    }

    /// `rel` ("projects/abc/scenes/x.html") dentro de `root`, o nil si intenta salir de la carpeta.
    static func resolve(_ root: URL, _ rel: String) -> URL? {
        var url = root
        for part in rel.split(separator: "/") where !part.isEmpty && part != "." {
            if part == ".." { return nil }
            url.appendPathComponent(String(part))
        }
        return url
    }

    /// Ruta relativa a la carpeta de datos (para responderle a la interfaz).
    static func relative(_ url: URL, to root: URL = data) -> String {
        let base = root.standardizedFileURL.path
        let full = url.standardizedFileURL.path
        guard full.hasPrefix(base) else { return url.lastPathComponent }
        return String(full.dropFirst(base.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    static let mime: [String: String] = [
        "html": "text/html; charset=utf-8", "htm": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8", "json": "application/json; charset=utf-8", "map": "application/json; charset=utf-8", "svg": "image/svg+xml",
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif", "heic": "image/heic", "ico": "image/x-icon",
        "mp4": "video/mp4", "m4v": "video/mp4", "mov": "video/quicktime", "webm": "video/webm", "mkv": "video/x-matroska",
        "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg", "m4a": "audio/mp4", "aac": "audio/aac", "flac": "audio/flac",
        "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf", "glb": "model/gltf-binary", "gltf": "model/gltf+json",
        "txt": "text/plain; charset=utf-8", "md": "text/markdown; charset=utf-8", "srt": "text/plain; charset=utf-8", "vtt": "text/vtt; charset=utf-8",
        "csv": "text/csv; charset=utf-8", "xml": "application/xml; charset=utf-8", "wasm": "application/wasm", "pdf": "application/pdf", "zip": "application/zip",
        "webmanifest": "application/manifest+json",
    ]
    static func mimeType(_ path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        return mime[ext] ?? "application/octet-stream"
    }
}
