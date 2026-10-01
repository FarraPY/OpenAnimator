import AVFoundation
import CryptoKit
import UIKit
import WhisperKit

/// Whisper en el iPhone, sin internet (salvo para bajar el modelo una vez): WhisperKit (Argmax, licencia MIT) corre los
/// modelos de Core ML en el Neural Engine. Medido por Argmax en un iPhone 17 Pro, 10 minutos de audio: large-v3-turbo
/// (626 MB) 38 s, small 22 s; whisper.cpp con la GPU (lo de la tablet) era varias veces más lento y en el iPhone la GPU no
/// puede trabajar con la app en segundo plano.
///
/// Los modelos (whisper-models.json, de scripts/whisperkit-models.py) están fijados a una revisión de Hugging Face y cada
/// archivo se verifica con SHA-256 antes de usarlo. Van a Application Support/whisper/<modelo>, sin respaldo en iCloud.
/// La primera vez que se carga un modelo, Core ML lo prepara para este chip (~1 min con turbo); iOS guarda eso y lo
/// borra con cada actualización del sistema.
///
/// Operaciones del puente: whisper.status, whisper.install {model}, whisper.remove {model},
/// whisper.transcribe {path, model, lang?, maxSec?} y whisper.test {model}. El avance va como evento "whisper".
final class LocalWhisper {
    static let shared = LocalWhisper()
    /// Para mandar eventos a la página (lo pone el puente).
    var emit: (String, [String: Any]) -> Void = { _, _ in }

    struct Failure: LocalizedError { let errorDescription: String? }
    private struct Entry: Decodable { let url: String; let path: String; let size: Int64; let sha256: String }
    private struct Model: Decodable { let id: String; let label: String; let files: [Entry]; let bytes: Int64 }
    private struct Manifest: Decodable { let models: [Model] }

    private let models: [Model] = {
        guard let url = Bundle.main.url(forResource: "whisper-models", withExtension: "json"),
              let data = try? Data(contentsOf: url), let m = try? JSONDecoder().decode(Manifest.self, from: data) else { return [] }
        return m.models
    }()
    private let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("whisper", isDirectory: true)
    // Todo lo de abajo se toca sólo en el hilo principal.
    private var kit: WhisperKit?
    private var kitModel: String?
    private var installing: Set<String> = []
    private var busy = false
    /// Las transcripciones van de a una (WhisperKit ya reparte cada audio en varios trabajadores).
    private var queue: Task<Void, Never> = Task {}

    private init() {
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, !self.busy, self.kit != nil else { return }
            AppLog.write("whisper", "INFO", "Memoria baja: se descarga el modelo de Whisper (se vuelve a cargar al usarlo)")
            self.kit = nil; self.kitModel = nil
        }
    }

    func handle(_ op: String, _ a: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        Task { @MainActor in
            do {
                switch op {
                case "whisper.status": reply(self.status(), nil)
                case "whisper.install": try await self.install(self.model(a["model"])); reply(self.status(), nil)
                case "whisper.remove": try self.remove(self.model(a["model"])); reply(self.status(), nil)
                case "whisper.transcribe":
                    guard let rel = a["path"] as? String, let url = Storage.resolve(Storage.data, rel), FileManager.default.fileExists(atPath: url.path)
                    else { throw Failure(errorDescription: "No existe el archivo de audio") }
                    let m = try self.model(a["model"])
                    let lang = (a["lang"] as? String).flatMap { $0.isEmpty ? nil : $0.lowercased() }
                    let maxSec = (a["maxSec"] as? NSNumber)?.doubleValue
                    reply(try await self.serial { try await self.transcribe(url, m, lang: lang, maxSec: maxSec) }, nil)
                case "whisper.test":
                    let m = try self.model(a["model"])
                    reply(try await self.serial { try await self.test(m) }, nil)
                default: throw Failure(errorDescription: "Operación desconocida: \(op)")
                }
            } catch {
                reply(nil, (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
        }
    }

    // MARK: modelos

    private func model(_ id: Any?) throws -> Model {
        guard let m = models.first(where: { $0.id == (id as? String) }) ?? (id == nil ? models.first : nil) else {
            throw Failure(errorDescription: "Modelo de Whisper desconocido: \(id ?? "")")
        }
        return m
    }

    private func folder(_ m: Model) -> URL { root.appendingPathComponent(m.id, isDirectory: true) }
    /// Completo y verificado (la marca se escribe después de comprobar todos los archivos).
    private func installed(_ m: Model) -> Bool { FileManager.default.fileExists(atPath: folder(m).appendingPathComponent(".ok").path) }

    @MainActor private func status() -> [String: Any] {
        [
            "models": models.map { m in
                ["id": m.id, "label": m.label, "mb": Int((Double(m.bytes) / 1e6).rounded()), "installed": installed(m), "downloading": installing.contains(m.id)] as [String: Any]
            },
            "loaded": kitModel.map { $0 as Any } ?? NSNull(),
            "busy": busy,
        ]
    }

    @MainActor private func install(_ m: Model) async throws {
        guard !installing.contains(m.id) else { throw Failure(errorDescription: "\(m.label) ya se está descargando") }
        installing.insert(m.id)
        defer { installing.remove(m.id) }
        let fm = FileManager.default
        let dir = folder(m)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var noBackup = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? noBackup.setResourceValues(values)
        try? fm.removeItem(at: dir.appendingPathComponent(".ok"))
        AppLog.write("whisper", "INFO", "Descargando \(m.label) (\(m.files.count) archivos, \(m.bytes / 1_000_000) MB)")
        let t0 = Date()
        var done: Int64 = 0
        for f in m.files {
            let dest = dir.appendingPathComponent(f.path)
            // Lo que ya estaba bien (una descarga cortada a mitad) no se vuelve a bajar.
            if (try? fm.attributesOfItem(atPath: dest.path)[.size] as? Int64) == f.size, (try? await Self.sha256(dest)) == f.sha256 {
                done += f.size
                continue
            }
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            let base = done
            try await Self.download(f.url, to: dest) { [weak self] got in
                self?.emit("whisper", ["type": "download", "model": m.id, "done": base + got, "total": m.bytes])
            }
            guard try await Self.sha256(dest) == f.sha256 else {
                try? fm.removeItem(at: dest)
                throw Failure(errorDescription: "\(f.path) llegó dañado (no coincide su SHA-256): probá de nuevo.")
            }
            done += f.size
            emit("whisper", ["type": "download", "model": m.id, "done": done, "total": m.bytes])
        }
        fm.createFile(atPath: dir.appendingPathComponent(".ok").path, contents: Data())
        AppLog.write("whisper", "INFO", "\(m.label) descargado y verificado en \(Int(Date().timeIntervalSince(t0))) s")
    }

    @MainActor private func remove(_ m: Model) throws {
        guard !installing.contains(m.id) else { throw Failure(errorDescription: "\(m.label) se está descargando") }
        guard !(busy && kitModel == m.id) else { throw Failure(errorDescription: "Whisper está transcribiendo con \(m.label)") }
        if kitModel == m.id { kit = nil; kitModel = nil }
        try? FileManager.default.removeItem(at: folder(m))
    }

    /// Un archivo de Hugging Face (redirige a su CDN). El avance se informa cada medio segundo.
    private static func download(_ s: String, to dest: URL, progress: @escaping (Int64) -> Void) async throws {
        guard let url = URL(string: s) else { throw Failure(errorDescription: "Dirección inválida: \(s)") }
        final class Box: @unchecked Sendable { var task: URLSessionDownloadTask? }
        let box = Box()
        let watch = Task { @MainActor in
            while !Task.isCancelled {
                if let t = box.task { progress(t.countOfBytesReceived) }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
        defer { watch.cancel() }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            let t = URLSession.shared.downloadTask(with: url) { tmp, response, error in
                if let error { c.resume(throwing: Failure(errorDescription: "No se pudo bajar el modelo: \(error.localizedDescription)")); return }
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard let tmp, code == 200 else { c.resume(throwing: Failure(errorDescription: "Hugging Face respondió \(code) al bajar el modelo")); return }
                do {
                    try? FileManager.default.removeItem(at: dest)
                    try FileManager.default.moveItem(at: tmp, to: dest)
                    c.resume()
                } catch { c.resume(throwing: error) }
            }
            DispatchQueue.main.async { box.task = t }
            t.resume()
        }
    }

    private static func sha256(_ url: URL) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            let h = try FileHandle(forReadingFrom: url)
            defer { try? h.close() }
            var hasher = SHA256()
            while let d = try h.read(upToCount: 8 << 20), !d.isEmpty { hasher.update(data: d) }
            return hasher.finalize().map { String(format: "%02x", $0) }.joined()
        }.value
    }

    // MARK: transcribir

    @MainActor private func serial<T>(_ work: @escaping @MainActor () async throws -> T) async throws -> T {
        let prev = queue
        let job = Task { @MainActor () async throws -> T in
            await prev.value
            return try await work()
        }
        queue = Task { _ = try? await job.value }
        return try await job.value
    }

    @MainActor private func load(_ m: Model) async throws -> WhisperKit {
        if let kit, kitModel == m.id { return kit }
        kit = nil; kitModel = nil
        guard installed(m) else { throw Failure(errorDescription: "El modelo \(m.label) de Whisper no está descargado: bajalo en Ajustes › Plugins › Whisper.") }
        emit("whisper", ["type": "load", "model": m.id])
        let t0 = Date()
        // prewarm: los modelos se preparan de a uno (con el de 626 MB, el pico de memoria es la mitad).
        let k = try await WhisperKit(WhisperKitConfig(modelFolder: folder(m).path, verbose: false, prewarm: true, load: true, download: false))
        AppLog.write("whisper", "INFO", "\(m.label) cargado en \(String(format: "%.1f", Date().timeIntervalSince(t0))) s")
        kit = k; kitModel = m.id
        return k
    }

    @MainActor private func transcribe(_ url: URL, _ m: Model, lang: String?, maxSec: Double?) async throws -> [String: Any] {
        busy = true
        defer { busy = false }
        let t0 = Date()
        let kit = try await load(m)
        let loadMs = Date().timeIntervalSince(t0) * 1000
        let samples = try await Self.decode(url, maxSec: maxSec)
        guard samples.count > 1600 else { throw Failure(errorDescription: "El archivo no tiene audio (o dura menos de 0,1 s)") }
        let audioSec = Double(samples.count) / 16000
        let opts = DecodingOptions(
            verbose: false, task: .transcribe, language: lang, temperatureFallbackCount: 3, usePrefillPrompt: true,
            detectLanguage: lang == nil, skipSpecialTokens: true, wordTimestamps: true, chunkingStrategy: .vad
        )
        let watch = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.emit("whisper", ["type": "transcribe", "model": m.id, "p": kit.progress.fractionCompleted])
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
        defer { watch.cancel() }
        let t1 = Date()
        let results = try await kit.transcribe(audioArray: samples, decodeOptions: opts)
        let ms = Date().timeIntervalSince(t1) * 1000
        let segments = results.flatMap(\.segments).sorted { $0.start < $1.start }
        let round3 = { (x: Float) -> Double in (Double(x) * 1000).rounded() / 1000 }
        let words: [[String: Any]] = segments.flatMap { $0.words ?? [] }.compactMap { w -> [String: Any]? in
            let t = w.word.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : ["w": t, "start": round3(w.start), "end": round3(max(w.end, w.start))]
        }
        let text = segments.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: " ")
        // El idioma de la mayoría de los tramos (cada uno lo detecta por su cuenta).
        let langs = Dictionary(grouping: results.map(\.language), by: { $0 }).max { $0.value.count < $1.value.count }?.key
        AppLog.write("whisper", "INFO", "\(m.label): \(String(format: "%.1f", audioSec)) s de audio en \(String(format: "%.1f", ms / 1000)) s (carga \(String(format: "%.1f", loadMs / 1000)) s), \(results.count) tramos, idioma \(lang ?? langs ?? "?")")
        return ["text": text, "words": words, "lang": (lang ?? langs).map { $0 as Any } ?? NSNull(), "ms": Int(ms), "loadMs": Int(loadMs), "audioSec": audioSec]
    }

    /// Cualquier audio o video que lea iOS, como PCM float mono a 16 kHz (lo que espera Whisper).
    private static func decode(_ url: URL, maxSec: Double?) async throws -> [Float] {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw Failure(errorDescription: "El archivo no tiene audio") }
        return try await Task.detached(priority: .userInitiated) {
            let reader = try AVAssetReader(asset: asset)
            if let maxSec, maxSec > 0 { reader.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: maxSec, preferredTimescale: 600)) }
            let out = AVAssetReaderAudioMixOutput(audioTracks: [track], audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
            ])
            out.alwaysCopiesSampleData = false
            reader.add(out)
            guard reader.startReading() else { throw Failure(errorDescription: "iOS no pudo leer el audio: \(reader.error?.localizedDescription ?? "")") }
            var samples: [Float] = []
            while let sb = out.copyNextSampleBuffer() {
                guard let bb = CMSampleBufferGetDataBuffer(sb) else { continue }
                let n = CMBlockBufferGetDataLength(bb) / 4
                let start = samples.count
                samples.append(contentsOf: repeatElement(0, count: n))
                samples.withUnsafeMutableBytes { p in _ = CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: n * 4, destination: p.baseAddress! + start * 4) }
            }
            if reader.status == .failed { throw Failure(errorDescription: "iOS no pudo leer el audio: \(reader.error?.localizedDescription ?? "")") }
            return samples
        }.value
    }

    // MARK: prueba

    /// Una frase dicha por la voz de iOS, transcripta: comprueba el modelo y mide la velocidad sin necesitar un archivo.
    @MainActor private func test(_ m: Model) async throws -> [String: Any] {
        let phrase = "Hola. Esta es una prueba de Whisper en el iPhone: si se lee bien, ya podés transcribir sin internet."
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("whisper-prueba.caf")
        try await Self.speak(phrase, to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        var r = try await transcribe(url, m, lang: "es", maxSec: nil)
        r["expected"] = phrase
        return r
    }

    private static var synth: AVSpeechSynthesizer?
    @MainActor private static func speak(_ text: String, to url: URL) async throws {
        let s = AVSpeechSynthesizer()
        synth = s
        defer { synth = nil }
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "es-MX") ?? AVSpeechSynthesisVoice(language: "es-ES")
        try? FileManager.default.removeItem(at: url)
        final class State: @unchecked Sendable { var file: AVAudioFile?; var failure: Error?; var finished = false }
        let st = State()
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            s.write(u) { buffer in
                guard !st.finished else { return }
                guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else { st.finished = true; c.resume(); return }
                do {
                    if st.file == nil { st.file = try AVAudioFile(forWriting: url, settings: pcm.format.settings, commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved) }
                    try st.file?.write(from: pcm)
                } catch { st.failure = error; st.finished = true; c.resume() }
            }
        }
        st.file = nil // cierra el archivo
        if let failure = st.failure { throw failure }
        guard FileManager.default.fileExists(atPath: url.path) else { throw Failure(errorDescription: "La voz de iOS no generó audio para la prueba") }
    }
}
