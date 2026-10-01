import AVFoundation
import Foundation
import Photos
import PhotosUI
import QuickLook
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Lo nativo que la interfaz le pide a la app (window.webkit.messageHandlers.oa.postMessage({op, …}) → promesa con la
/// respuesta). Es el equivalente del Bridge de Java en Android, pero chico: la interfaz guarda y lee casi todo por su
/// cuenta (ver src/iphone/host); acá van los archivos en disco, Claude Code instalado y lo que sólo hace iOS
/// (elegir fotos y archivos, compartir, guardar en Fotos, la pantalla encendida).
///
/// Las rutas son relativas a la carpeta de datos (Documentos). Los datos binarios viajan en base64.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    private weak var controller: WebViewController?
    private let io = DispatchQueue(label: "oa.bridge", qos: .userInitiated)
    private var pickerDone: (([[String: Any]]) -> Void)?
    private var pickerAccept: [String] = []
    private var preview: URL?
    private var background: UIBackgroundTaskIdentifier = .invalid

    private func endBackground() {
        guard background != .invalid else { return }
        UIApplication.shared.endBackgroundTask(background)
        background = .invalid
    }

    init(controller: WebViewController) { self.controller = controller }

    typealias Reply = (Any?, String?) -> Void

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping Reply) {
        guard let a = message.body as? [String: Any], let op = a["op"] as? String else { replyHandler(nil, "Mensaje inválido"); return }
        switch op {
        case "diag.result":
            print("OA-DIAG-RESULT " + (a["json"] as? String ?? "{}"))
            fflush(stdout)
            replyHandler(true, nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
        case "log":
            print("[web] " + (a["text"] as? String ?? ""))
            replyHandler(true, nil)
        case "info": replyHandler(info(), nil)
        case "awake":
            // Pantalla encendida mientras Claude trabaja o se exporta; y si el usuario sale de la app, iOS da un rato
            // más antes de congelarla (beginBackgroundTask: no corta el turno o la exportación al instante).
            let on = (a["on"] as? Bool) ?? false
            UIApplication.shared.isIdleTimerDisabled = on
            if on, background == .invalid {
                background = UIApplication.shared.beginBackgroundTask(withName: "OpenAnimator") { [weak self] in self?.endBackground() }
            } else if !on { endBackground() }
            replyHandler(true, nil)
        case "openUrl":
            if let s = a["url"] as? String, let url = URL(string: s), ["http", "https"].contains(url.scheme?.lowercased() ?? "") { UIApplication.shared.open(url) }
            replyHandler(true, nil)
        case "clipboard.text":
            UIPasteboard.general.string = a["text"] as? String ?? ""
            replyHandler(true, nil)
        case "share": share(a, replyHandler)
        case "photos.save": saveToPhotos(a, replyHandler)
        case "pick": pick(a, replyHandler)
        case "open": open(a, replyHandler)
        case "probe": probe(a, replyHandler)
        case "venc.start", "venc.frame", "venc.audio", "venc.finish", "venc.cancel": NativeEncoder.handle(op, a, replyHandler)
        case "keychain.load": replyHandler(Keychain.load(), nil)
        case "keychain.save":
            Keychain.save(a["json"] as? String ?? "{}") ? replyHandler(true, nil) : replyHandler(nil, "No se pudieron guardar las claves en el Llavero")
        default:
            // Archivos: en otro hilo (pueden ser grandes); la respuesta vuelve al principal.
            io.async {
                let result: Result<Any, Error>
                do { result = .success(try Files.run(op, a)) } catch { result = .failure(error) }
                DispatchQueue.main.async {
                    switch result {
                    case .success(let v): replyHandler(v, nil)
                    case .failure(let e): replyHandler(nil, (e as? LocalizedError)?.errorDescription ?? e.localizedDescription)
                    }
                }
            }
        }
    }

    private func info() -> [String: Any] {
        var u = utsname()
        uname(&u)
        let machine = withUnsafePointer(to: &u.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) } }
        let values = try? Storage.data.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey])
        return [
            "model": machine, "name": UIDevice.current.model, "system": UIDevice.current.systemVersion,
            "app": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
            "memory": Double(ProcessInfo.processInfo.physicalMemory),
            "free": Double(values?.volumeAvailableCapacityForImportantUsage ?? 0), "total": Double(values?.volumeTotalCapacity ?? 0),
            "scale": Double(UIScreen.main.scale),
        ]
    }

    // MARK: compartir, Fotos, vista previa

    private func fileURL(_ a: [String: Any]) -> URL? {
        guard let rel = a["path"] as? String, let url = Storage.resolve(Storage.data, rel), FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    /// La hoja de Compartir de iOS con el archivo (Guardar en Archivos, AirDrop, WhatsApp…).
    private func share(_ a: [String: Any], _ reply: @escaping Reply) {
        guard let vc = controller, let url = fileURL(a) else { reply(nil, "No existe el archivo"); return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, done, _, error in reply(["completed": done], error.map { $0.localizedDescription }) }
        // En iPad la hoja necesita de dónde salir.
        sheet.popoverPresentationController?.sourceView = vc.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 80, width: 1, height: 1)
        vc.present(sheet, animated: true)
    }

    private func saveToPhotos(_ a: [String: Any], _ reply: @escaping Reply) {
        guard let url = fileURL(a) else { reply(nil, "No existe el archivo"); return }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async { reply(nil, "OpenAnimator no tiene permiso para guardar en Fotos (Ajustes › OpenAnimator › Fotos).") }
                return
            }
            let isImage = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) ?? false
            PHPhotoLibrary.shared().performChanges({
                if isImage { _ = PHAssetCreationRequest.creationRequestForAssetFromImage(atFileURL: url) } else { _ = PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: url) }
            }) { ok, error in
                DispatchQueue.main.async { ok ? reply(["folder": "Fotos"], nil) : reply(nil, error?.localizedDescription ?? "No se pudo guardar en Fotos") }
            }
        }
    }

    private func open(_ a: [String: Any], _ reply: @escaping Reply) {
        guard let vc = controller, let url = fileURL(a) else { reply(nil, "No existe el archivo"); return }
        preview = url
        let ql = QLPreviewController()
        ql.dataSource = self
        vc.present(ql, animated: true)
        reply(true, nil)
    }

    /// Qué tiene un video según iOS (AVFoundation): duración y pistas. Lo usa la prueba de la exportación.
    private func probe(_ a: [String: Any], _ reply: @escaping Reply) {
        guard let url = fileURL(a) else { reply(nil, "No existe el archivo"); return }
        let asset = AVURLAsset(url: url)
        asset.loadValuesAsynchronously(forKeys: ["duration", "tracks", "playable"]) {
            let video = asset.tracks(withMediaType: .video).first
            let result: [String: Any] = [
                "duration": CMTimeGetSeconds(asset.duration),
                "video": video.map { ["w": Double($0.naturalSize.width), "h": Double($0.naturalSize.height), "fps": Double($0.nominalFrameRate)] } ?? NSNull(),
                "audio": asset.tracks(withMediaType: .audio).count,
                "playable": asset.isPlayable,
            ]
            DispatchQueue.main.async { reply(result, nil) }
        }
    }

    // MARK: elegir archivos (Fotos o Archivos) → .incoming/<id>/

    private func pick(_ a: [String: Any], _ reply: @escaping Reply) {
        guard let vc = controller else { reply([], nil); return }
        let accept = a["accept"] as? [String] ?? []
        let multiple = a["multiple"] as? Bool ?? true
        pickerAccept = accept
        pickerDone = { files in reply(files, nil) }
        let wantsMedia = accept.isEmpty || accept.contains { $0.hasPrefix("image/") || $0.hasPrefix("video/") }
        let onlyMedia = !accept.isEmpty && accept.allSatisfy { $0.hasPrefix("image/") || $0.hasPrefix("video/") }
        if onlyMedia { presentPhotos(multiple, from: vc); return }
        if !wantsMedia { presentFiles(multiple, from: vc); return }
        let menu = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        menu.addAction(UIAlertAction(title: "Fotos y videos", style: .default) { _ in self.presentPhotos(multiple, from: vc) })
        menu.addAction(UIAlertAction(title: "Archivos", style: .default) { _ in self.presentFiles(multiple, from: vc) })
        menu.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in self.finishPick([]) })
        menu.popoverPresentationController?.sourceView = vc.view
        menu.popoverPresentationController?.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 80, width: 1, height: 1)
        vc.present(menu, animated: true)
    }

    private func finishPick(_ files: [[String: Any]]) {
        let done = pickerDone
        pickerDone = nil
        done?(files)
    }

    private func presentPhotos(_ multiple: Bool, from vc: UIViewController) {
        var config = PHPickerConfiguration()
        config.selectionLimit = multiple ? 0 : 1
        config.filter = .any(of: [.images, .videos])
        config.preferredAssetRepresentationMode = .current // sin convertir: un video de 4K no se recodifica
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        vc.present(picker, animated: true)
    }

    private func presentFiles(_ multiple: Bool, from vc: UIViewController) {
        let types: [UTType] = pickerAccept.contains { $0.contains("zip") } ? [.zip, .data] : [.item]
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.allowsMultipleSelection = multiple
        picker.delegate = self
        vc.present(picker, animated: true)
    }

    fileprivate static func incomingDir() -> URL {
        let dir = Storage.data.appendingPathComponent(".incoming", isDirectory: true).appendingPathComponent(UUID().uuidString.prefix(8).lowercased(), isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Mueve (o copia) un archivo elegido a .incoming y lo describe para la interfaz.
    fileprivate static func stage(_ src: URL, name: String, into dir: URL, move: Bool) -> [String: Any]? {
        let clean = name.replacingOccurrences(of: "[\\\\/:*?\"<>|]+", with: "-", options: .regularExpression)
        var dst = dir.appendingPathComponent(clean.isEmpty ? "archivo" : clean)
        var n = 2
        while FileManager.default.fileExists(atPath: dst.path) {
            let base = (clean as NSString).deletingPathExtension, ext = (clean as NSString).pathExtension
            dst = dir.appendingPathComponent(ext.isEmpty ? "\(base)-\(n)" : "\(base)-\(n).\(ext)")
            n += 1
        }
        do {
            if move { try FileManager.default.moveItem(at: src, to: dst) } else { try FileManager.default.copyItem(at: src, to: dst) }
        } catch { return nil }
        let size = (try? FileManager.default.attributesOfItem(atPath: dst.path)[.size] as? NSNumber)?.doubleValue ?? 0
        return ["path": Storage.relative(dst), "name": dst.lastPathComponent, "size": size, "mime": Storage.mimeType(dst.path)]
    }
}

extension Bridge: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        if results.isEmpty { finishPick([]); return }
        let dir = Bridge.incomingDir()
        let group = DispatchGroup()
        let lock = NSLock()
        var out: [Int: [String: Any]] = [:]
        for (i, r) in results.enumerated() {
            let p = r.itemProvider
            let base = p.suggestedName ?? "archivo-\(i + 1)"
            // PNG tal cual (transparencias); el resto de las fotos a JPEG (HEIC no lo lee Claude); videos sin tocar.
            let type: UTType? = p.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? .movie
                : p.hasItemConformingToTypeIdentifier(UTType.png.identifier) ? .png
                : p.hasItemConformingToTypeIdentifier(UTType.image.identifier) ? .image : nil
            guard let type else { continue }
            group.enter()
            if type == .image {
                p.loadObject(ofClass: UIImage.self) { obj, _ in
                    defer { group.leave() }
                    guard let img = obj as? UIImage, let data = img.jpegData(compressionQuality: 0.92) else { return }
                    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".jpg")
                    guard (try? data.write(to: tmp)) != nil, let f = Bridge.stage(tmp, name: base + ".jpg", into: dir, move: true) else { return }
                    lock.lock(); out[i] = f; lock.unlock()
                }
            } else {
                p.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                    defer { group.leave() }
                    // El archivo temporal sólo existe durante esta llamada: se copia ya.
                    guard let url, let f = Bridge.stage(url, name: url.pathExtension.isEmpty ? base : "\(base).\(url.pathExtension.lowercased())", into: dir, move: false) else { return }
                    lock.lock(); out[i] = f; lock.unlock()
                }
            }
        }
        group.notify(queue: .main) { self.finishPick(out.keys.sorted().compactMap { out[$0] }) }
    }
}

extension Bridge: UIDocumentPickerDelegate {
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let dir = Bridge.incomingDir()
        finishPick(urls.compactMap { Bridge.stage($0, name: $0.lastPathComponent, into: dir, move: true) })
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishPick([]) }
}

extension Bridge: QLPreviewControllerDataSource {
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { preview == nil ? 0 : 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { preview! as NSURL }
}

/// Operaciones de archivos (en un hilo aparte). Rutas relativas a la carpeta de datos, salvo las de Claude Code.
enum Files {
    struct Failure: LocalizedError { let errorDescription: String? }
    static func fail(_ s: String) -> Failure { Failure(errorDescription: s) }

    private static func path(_ a: [String: Any], _ key: String = "path") throws -> URL {
        guard let rel = a[key] as? String, let url = Storage.resolve(Storage.data, rel), url.path != Storage.data.path else { throw fail("Ruta inválida") }
        return url
    }
    private static func bytes(_ a: [String: Any]) throws -> Data {
        guard let b64 = a["data"] as? String else { return Data() }
        guard let d = Data(base64Encoded: b64) else { throw fail("Datos inválidos") }
        return d
    }
    private static func parent(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    /// Lo que se carga en memoria al arrancar (como el índice de WebFS sobre OPFS): textos chicos y archivos chicos.
    private static let textExt: Set<String> = ["json", "html", "htm", "css", "js", "mjs", "md", "txt", "srt", "vtt", "svg", "csv", "xml", "yaml", "yml", "toml"]
    private static func keepInMemory(_ rel: String, _ size: Int) -> Bool {
        let ext = (rel as NSString).pathExtension.lowercased()
        return size <= 4 << 20 && (textExt.contains(ext) || size <= 256 << 10)
    }

    static func run(_ op: String, _ a: [String: Any]) throws -> Any {
        let fm = FileManager.default
        switch op {
        case "fs.scan":
            // Todo el árbol: [ruta, carpeta, tamaño, fecha en ms] y el contenido (base64) de los archivos chicos.
            var entries: [[Any]] = []
            var texts: [[Any]] = []
            let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
            if let walker = fm.enumerator(at: Storage.data, includingPropertiesForKeys: keys, options: []) {
                for case let url as URL in walker {
                    let v = try? url.resourceValues(forKeys: Set(keys))
                    let rel = Storage.relative(url)
                    if rel.isEmpty { continue }
                    let isDir = v?.isDirectory ?? false
                    let size = v?.fileSize ?? 0
                    let mtime = (v?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
                    entries.append([rel, isDir ? 1 : 0, size, mtime])
                    if !isDir, keepInMemory(rel, size), let d = try? Data(contentsOf: url) { texts.append([rel, d.base64EncodedString()]) }
                }
            }
            return ["entries": entries, "texts": texts]
        case "fs.stat":
            let url = try path(a)
            guard let attrs = try? fm.attributesOfItem(atPath: url.path) else { return NSNull() }
            let isDir = (attrs[.type] as? FileAttributeType) == .typeDirectory
            return ["dir": isDir, "size": (attrs[.size] as? NSNumber)?.doubleValue ?? 0, "mtime": ((attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000]
        case "fs.write":
            // Archivo completo (o agregado al final con append).
            let url = try path(a), data = try bytes(a)
            try parent(url)
            if (a["append"] as? Bool) == true, fm.fileExists(atPath: url.path) {
                let fh = try FileHandle(forWritingTo: url)
                defer { try? fh.close() }
                try fh.seekToEnd()
                try fh.write(contentsOf: data)
            } else {
                try data.write(to: url, options: .atomic)
            }
            return true
        case "fs.writeAt":
            // Por partes, en una posición (el MP4 que se va exportando, un .zip).
            let url = try path(a), data = try bytes(a)
            let pos = (a["pos"] as? NSNumber)?.uint64Value ?? 0
            try parent(url)
            if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
            let fh = try FileHandle(forWritingTo: url)
            defer { try? fh.close() }
            if (a["truncate"] as? Bool) == true { try fh.truncate(atOffset: 0) }
            try fh.seek(toOffset: pos)
            try fh.write(contentsOf: data)
            return true
        case "fs.truncate":
            let url = try path(a)
            let fh = try FileHandle(forWritingTo: url)
            defer { try? fh.close() }
            try fh.truncate(atOffset: (a["size"] as? NSNumber)?.uint64Value ?? 0)
            return true
        case "fs.mkdir":
            try fm.createDirectory(at: try path(a), withIntermediateDirectories: true)
            return true
        case "fs.delete":
            let url = try path(a)
            if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
            return true
        case "fs.rename", "fs.copy":
            let from = try path(a, "from"), to = try path(a, "to")
            guard fm.fileExists(atPath: from.path) else { throw fail("No existe: \(a["from"] ?? "")") }
            try parent(to)
            if fm.fileExists(atPath: to.path) { try fm.removeItem(at: to) }
            if op == "fs.rename" { try fm.moveItem(at: from, to: to) } else { try fm.copyItem(at: from, to: to) }
            return true
        case "cc.write":
            // Claude Code instalado por la app: varios archivos por mensaje ([ruta, base64]).
            guard let version = a["version"] as? String, !version.contains("/"), !version.contains(".."), let files = a["files"] as? [[Any]] else { throw fail("Datos inválidos") }
            let root = Storage.claude.appendingPathComponent(version, isDirectory: true)
            for f in files {
                guard f.count == 2, let rel = f[0] as? String, let b64 = f[1] as? String, let url = Storage.resolve(root, rel), let d = Data(base64Encoded: b64) else { throw fail("Archivo inválido") }
                try parent(url)
                try d.write(to: url)
            }
            return true
        case "cc.list":
            let dirs = (try? fm.contentsOfDirectory(atPath: Storage.claude.path)) ?? []
            return dirs.filter { fm.fileExists(atPath: Storage.claude.appendingPathComponent($0).appendingPathComponent("manifest.json").path) }
        case "cc.delete":
            // Borra las versiones que no sean `keep` (o una en particular con `version`).
            let keep = a["keep"] as? String
            for d in (try? fm.contentsOfDirectory(atPath: Storage.claude.path)) ?? [] where d != keep && (a["version"] as? String ?? d) == d {
                try? fm.removeItem(at: Storage.claude.appendingPathComponent(d))
            }
            return true
        default:
            throw fail("Operación desconocida: \(op)")
        }
    }
}
