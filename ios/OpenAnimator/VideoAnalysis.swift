import AVFoundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

/// Medir un video para «Crear plantilla desde un video» (src/android/backend/analyzer.ts; en la PC lo hace FFmpeg en
/// electron/analyzer.ts), con AVFoundation y sin pasar el video por la página:
///   vana.info      duración, tamaño en pantalla (con la rotación), fps y si tiene audio
///   vana.scan      el puntaje de cambio de escena de cada cuadro a 5 por segundo (como el `scene` de FFmpeg, sobre la
///                  imagen achicada a 192 de ancho en YUV) y los píxeles para la paleta
///   vana.frames    fotogramas clave en JPEG, la hoja de contactos y las tiras de movimiento (6 cuadros cada 0,25 s)
///   vana.audio     silencios (-32 dB durante 0,35 s, como silencedetect) y sonoridad integrada (ITU-R BS.1770)
///   vana.download  un video o audio de YouTube (googlevideo.com) a disco, por tramos
/// El avance va como evento "vana" ({job, phase, p}); vana.cancel corta lo que esté haciendo ese trabajo.
enum VideoAnalysis {
    struct Failure: LocalizedError { let errorDescription: String? }
    /// Para mandar eventos a la página (lo pone el puente).
    static var emit: (String, [String: Any]) -> Void = { _, _ in }
    private static let lock = NSLock()
    private static var cancelled: Set<String> = []

    static func handle(_ op: String, _ a: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        let job = a["job"] as? String ?? ""
        if op == "vana.cancel" {
            lock.lock(); cancelled.insert(job); lock.unlock()
            reply(true, nil)
            return
        }
        Task.detached(priority: .userInitiated) {
            do {
                let r: [String: Any]
                if op == "vana.download" {
                    r = try await download(a, job: job)
                } else {
                    guard let rel = a["path"] as? String, let url = Storage.resolve(Storage.data, rel), FileManager.default.fileExists(atPath: url.path)
                    else { throw Failure(errorDescription: "No existe el video") }
                    let maxSec = (a["maxSec"] as? NSNumber)?.doubleValue ?? 0
                    switch op {
                    case "vana.info": r = try await info(url)
                    case "vana.scan": r = try await scan(url, maxSec: maxSec, job: job)
                    case "vana.frames": r = try await frames(url, a, job: job)
                    case "vana.audio": r = try await audio(url, maxSec: maxSec, job: job)
                    default: throw Failure(errorDescription: "Operación desconocida: \(op)")
                    }
                }
                DispatchQueue.main.async { reply(r, nil) }
            } catch {
                let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                DispatchQueue.main.async { reply(nil, msg) }
            }
        }
    }

    private static func check(_ job: String) throws {
        lock.lock()
        let stop = cancelled.contains(job)
        lock.unlock()
        if stop { throw Failure(errorDescription: "cancelado") }
    }

    /// El avance de una fase (0-1), de a 2 % como mucho.
    private static func progress(_ job: String, _ phase: String, _ p: Double, _ last: inout Double) {
        guard p - last >= 0.02 || (p >= 1 && last < 1) else { return }
        last = p
        emit("vana", ["job": job, "phase": phase, "p": min(1, max(0, p))])
    }

    /// El tamaño en pantalla de la pista (con su rotación: los videos verticales del iPhone vienen apaisados y girados).
    private static func display(_ track: AVAssetTrack) async throws -> (size: CGSize, transform: CGAffineTransform, rect: CGRect) {
        let (natural, t) = try await track.load(.naturalSize, .preferredTransform)
        let r = CGRect(origin: .zero, size: natural).applying(t)
        return (CGSize(width: abs(r.width).rounded(), height: abs(r.height).rounded()), t, r)
    }

    // MARK: formato

    private static func info(_ url: URL) async throws -> [String: Any] {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        guard let video = try await asset.loadTracks(withMediaType: .video).first else { throw Failure(errorDescription: "El archivo no tiene video") }
        let d = try await display(video)
        let fps = try await video.load(.nominalFrameRate)
        let audio = try await asset.loadTracks(withMediaType: .audio)
        return ["duration": duration.isFinite ? duration : 0, "w": d.size.width, "h": d.size.height, "fps": Double(fps), "audio": !audio.isEmpty]
    }

    // MARK: cortes, movimiento y paleta

    private static func scan(_ url: URL, maxSec: Double, job: String) async throws -> [String: Any] {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw Failure(errorDescription: "El archivo no tiene video") }
        let duration = try await asset.load(.duration)
        let d = try await display(track)
        let limit = maxSec > 0 ? min(duration.seconds, maxSec) : duration.seconds
        // Cinco cuadros por segundo a 192 de ancho (como `fps=5,scale=192:-2` en FFmpeg): la composición gira, achica y
        // elige los cuadros; el decodificador de iOS hace el resto.
        let W = 192, H = max(2, Int((192 * d.size.height / max(1, d.size.width) / 2).rounded()) * 2)
        let s = CGFloat(W) / max(1, d.size.width)
        let comp = AVMutableVideoComposition()
        comp.frameDuration = CMTime(value: 1, timescale: 5)
        comp.renderSize = CGSize(width: W, height: H)
        let ins = AVMutableVideoCompositionInstruction()
        ins.timeRange = CMTimeRange(start: .zero, duration: duration)
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: track)
        layer.setTransform(d.transform.concatenating(CGAffineTransform(translationX: -d.rect.minX, y: -d.rect.minY)).concatenating(CGAffineTransform(scaleX: s, y: s)), at: .zero)
        ins.layerInstructions = [layer]
        comp.instructions = [ins]
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: limit, preferredTimescale: 600))
        let out = AVAssetReaderVideoCompositionOutput(videoTracks: [track], videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        out.videoComposition = comp
        out.alwaysCopiesSampleData = false
        guard reader.canAdd(out) else { throw Failure(errorDescription: "iOS no puede leer este video") }
        reader.add(out)
        guard reader.startReading() else { throw Failure(errorDescription: "iOS no pudo leer el video: \(reader.error?.localizedDescription ?? "")") }
        defer { if reader.status == .reading { reader.cancelReading() } }

        // Cada cuadro como un yuv420p de 8 bits (BT.601): Y completo y U, V de a 2×2. El puntaje es el de FFmpeg: la
        // diferencia absoluta media con el cuadro anterior (mafd) y su cambio, el menor de los dos sobre 100.
        let cw = W / 2, ch = H / 2
        var cur = [UInt8](repeating: 0, count: W * H + 2 * cw * ch)
        var prev: [UInt8]? = nil
        var prevMafd = 0.0
        var scores: [[Double]] = []
        // La paleta: a 96 de ancho, hasta 4 cuadros por segundo y unos 60 en total (como en la PC).
        var pix: [UInt8] = []
        let palStep = max(0.25, limit / 60)
        var nextPal = 0.0, last = -1.0
        while let sb = out.copyNextSampleBuffer() {
            try check(job)
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
            let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
            CVPixelBufferLockBaseAddress(pb, .readOnly)
            guard let raw = CVPixelBufferGetBaseAddress(pb) else { CVPixelBufferUnlockBaseAddress(pb, .readOnly); continue }
            let base = raw.assumingMemoryBound(to: UInt8.self)
            let bpr = CVPixelBufferGetBytesPerRow(pb)
            let w = min(W, CVPixelBufferGetWidth(pb)), h = min(H, CVPixelBufferGetHeight(pb))
            let pal = t >= nextPal
            if pal { nextPal = t + palStep }
            for y in 0..<h {
                let row = base + y * bpr
                for x in 0..<w {
                    let p = row + x * 4
                    let b = Double(p[0]), g = Double(p[1]), r = Double(p[2])
                    cur[y * W + x] = UInt8(clamping: Int((16 + 0.257 * r + 0.504 * g + 0.098 * b).rounded()))
                }
            }
            for y in 0..<min(ch, h / 2) {
                for x in 0..<min(cw, w / 2) {
                    var r = 0.0, g = 0.0, b = 0.0
                    for dy in 0..<2 {
                        let row = base + (2 * y + dy) * bpr
                        for dx in 0..<2 { let p = row + (2 * x + dx) * 4; b += Double(p[0]); g += Double(p[1]); r += Double(p[2]) }
                    }
                    r /= 4; g /= 4; b /= 4
                    cur[W * H + y * cw + x] = UInt8(clamping: Int((128 - 0.148 * r - 0.291 * g + 0.439 * b).rounded()))
                    cur[W * H + cw * ch + y * cw + x] = UInt8(clamping: Int((128 + 0.439 * r - 0.368 * g - 0.071 * b).rounded()))
                    if pal { pix.append(UInt8(clamping: Int(r.rounded()))); pix.append(UInt8(clamping: Int(g.rounded()))); pix.append(UInt8(clamping: Int(b.rounded()))) }
                }
            }
            CVPixelBufferUnlockBaseAddress(pb, .readOnly)
            var score = 0.0
            if let p = prev {
                var sad = 0
                for i in 0..<cur.count { sad += abs(Int(cur[i]) - Int(p[i])) }
                let mafd = Double(sad) / Double(cur.count)
                score = min(1, max(0, min(mafd, abs(mafd - prevMafd)) / 100))
                prevMafd = mafd
            }
            prev = cur
            scores.append([(t * 1000).rounded() / 1000, (score * 10000).rounded() / 10000])
            progress(job, "scan", t / max(0.1, limit), &last)
        }
        if reader.status == .failed { throw Failure(errorDescription: "iOS no pudo leer el video: \(reader.error?.localizedDescription ?? "")") }
        return ["scores": scores, "pix": Data(pix).base64EncodedString(), "w": W, "h": H]
    }

    // MARK: fotogramas, hoja de contactos y tiras de movimiento

    /// {path, frames: [{t, file}], width, sheet, cols, strips: [{t, file}]}: los archivos van a la carpeta de datos.
    private static func frames(_ url: URL, _ a: [String: Any], job: String) async throws -> [String: Any] {
        let asset = AVURLAsset(url: url)
        let list = { (k: String) -> [(t: Double, file: String)] in
            (a[k] as? [[String: Any]] ?? []).compactMap { d in
                guard let t = (d["t"] as? NSNumber)?.doubleValue, let f = d["file"] as? String else { return nil }
                return (t: t, file: f)
            }
        }
        let items = list("frames"), strips = list("strips")
        let width = CGFloat((a["width"] as? NSNumber)?.doubleValue ?? 960)
        let cols = max(1, (a["cols"] as? NSNumber)?.intValue ?? 5)
        let total = Double(max(1, items.count + strips.count * 6))
        var n = 0.0, last = -1.0
        // Cuadros exactos (como -ss de FFmpeg), del ancho pedido y con la rotación del video.
        let gen = generator(asset, width: width)
        var done: [[String: Any]] = []
        var tiles: [CGImage] = []
        for (t, file) in items {
            try check(job)
            if let img = try? await gen.image(at: CMTime(seconds: t, preferredTimescale: 600)).image, let dest = Storage.resolve(Storage.data, file) {
                try writeJPEG(img, to: dest)
                done.append(["file": file, "t": t, "size": fileSize(dest)])
                tiles.append(img)
            }
            n += 1
            progress(job, "frames", n / total, &last)
        }
        var sheet: Any = NSNull()
        if let file = a["sheet"] as? String, !tiles.isEmpty, let dest = Storage.resolve(Storage.data, file) {
            try writeJPEG(try grid(tiles, tile: 384, cols: cols, pad: 6, margin: 6), to: dest)
            sheet = ["file": file, "size": fileSize(dest)]
        }
        tiles.removeAll()
        let small = generator(asset, width: 320)
        var made: [[String: Any]] = []
        for (t, file) in strips {
            var row: [CGImage] = []
            for k in 0..<6 {
                try check(job)
                if let img = try? await small.image(at: CMTime(seconds: t + Double(k) * 0.25, preferredTimescale: 600)).image { row.append(img) }
                n += 1
                progress(job, "frames", n / total, &last)
            }
            guard row.count == 6, let dest = Storage.resolve(Storage.data, file) else { continue }
            try writeJPEG(try grid(row, tile: 320, cols: 6, pad: 4, margin: 0), to: dest)
            made.append(["file": file, "t": t, "size": fileSize(dest)])
        }
        return ["frames": done, "sheet": sheet, "strips": made]
    }

    private static func generator(_ asset: AVAsset, width: CGFloat) -> AVAssetImageGenerator {
        let g = AVAssetImageGenerator(asset: asset)
        g.appliesPreferredTrackTransform = true
        g.requestedTimeToleranceBefore = .zero
        g.requestedTimeToleranceAfter = .zero
        g.maximumSize = CGSize(width: width, height: width * 8) // el ancho manda (uno vertical sale más alto)
        return g
    }

    /// Imágenes en una grilla (como `tile` de FFmpeg): `cols` columnas de `tile` de ancho, separadas por `pad`, con un
    /// borde `margin` y fondo #111111.
    private static func grid(_ imgs: [CGImage], tile: Int, cols: Int, pad: Int, margin: Int) throws -> CGImage {
        let aspect = Double(imgs[0].height) / Double(max(1, imgs[0].width))
        let th = max(2, Int((Double(tile) * aspect / 2).rounded()) * 2)
        let rows = (imgs.count + cols - 1) / cols
        let W = margin * 2 + cols * tile + (cols - 1) * pad, H = margin * 2 + rows * th + (rows - 1) * pad
        guard let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { throw Failure(errorDescription: "Sin memoria para la hoja de contactos") }
        ctx.setFillColor(CGColor(red: 17 / 255, green: 17 / 255, blue: 17 / 255, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        ctx.interpolationQuality = .high
        for (i, img) in imgs.enumerated() {
            let x = margin + (i % cols) * (tile + pad), top = margin + (i / cols) * (th + pad)
            ctx.draw(img, in: CGRect(x: x, y: H - top - th, width: tile, height: th))
        }
        guard let image = ctx.makeImage() else { throw Failure(errorDescription: "No se pudo armar la hoja de contactos") }
        return image
    }

    private static func writeJPEG(_ img: CGImage, to url: URL, quality: Double = 0.85) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let d = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { throw Failure(errorDescription: "No se pudo guardar \(url.lastPathComponent)") }
        CGImageDestinationAddImage(d, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(d) else { throw Failure(errorDescription: "No se pudo guardar \(url.lastPathComponent)") }
    }

    private static func fileSize(_ url: URL) -> Int { ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.intValue ?? 0 }

    // MARK: silencios y sonoridad

    /// Un filtro de segundo orden (forma directa II transpuesta).
    private struct Biquad {
        let b0, b1, b2, a1, a2: Double
        var z1 = 0.0, z2 = 0.0
        mutating func run(_ x: Double) -> Double {
            let y = b0 * x + z1
            z1 = b1 * x - a1 * y + z2
            z2 = b2 * x - a2 * y
            return y
        }
    }
    /// La ponderación K de la ITU-R BS.1770 a 48 kHz: un estante en los agudos y un paso alto.
    private struct KWeight {
        var shelf = Biquad(b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585)
        var high = Biquad(b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621)
        mutating func run(_ x: Double) -> Double { high.run(shelf.run(x)) }
    }

    /// Silencio = todos los canales por debajo de -32 dB durante 0,35 s (cuenta las pausas que terminan); sonoridad
    /// integrada con bloques de 400 ms cada 100 ms, compuerta absoluta de -70 LUFS y relativa de -10 LU (como ebur128).
    private static func audio(_ url: URL, maxSec: Double, job: String) async throws -> [String: Any] {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return ["audio": false] }
        var channels = 1
        if let fd = try await track.load(.formatDescriptions).first, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee, asbd.mChannelsPerFrame >= 2 { channels = 2 }
        let duration = try await asset.load(.duration).seconds
        let limit = maxSec > 0 ? min(duration, maxSec) : duration
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(start: .zero, duration: CMTime(seconds: limit, preferredTimescale: 600))
        let rate = 48000.0
        let out = AVAssetReaderAudioMixOutput(audioTracks: [track], audioSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
        ])
        out.alwaysCopiesSampleData = false
        guard reader.canAdd(out) else { throw Failure(errorDescription: "iOS no puede leer este audio") }
        reader.add(out)
        guard reader.startReading() else { throw Failure(errorDescription: "iOS no pudo leer el audio: \(reader.error?.localizedDescription ?? "")") }
        defer { if reader.status == .reading { reader.cancelReading() } }
        var k = [KWeight](repeating: KWeight(), count: channels)
        let thr = Float(pow(10.0, -32.0 / 20.0)), need = Int(0.35 * rate), sub = Int(rate / 10)
        var frame = 0, run = 0, inSilence = false, start = 0.0, silent = 0.0, pauses = 0
        var subSum = 0.0, subCount = 0, subs: [Double] = []
        var last = -1.0
        while let sb = out.copyNextSampleBuffer() {
            try check(job)
            guard let bb = CMSampleBufferGetDataBuffer(sb) else { continue }
            let count = CMBlockBufferGetDataLength(bb) / 4
            var buf = [Float](repeating: 0, count: count)
            buf.withUnsafeMutableBytes { p in _ = CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: count * 4, destination: p.baseAddress!) }
            for i in 0..<(count / channels) {
                var loud = false, e = 0.0
                for c in 0..<channels {
                    let x = buf[i * channels + c]
                    if abs(x) >= thr { loud = true }
                    let y = k[c].run(Double(x))
                    e += y * y
                }
                if !loud {
                    run += 1
                    if !inSilence && run >= need { inSilence = true; start = Double(frame + 1 - need) / rate }
                } else {
                    if inSilence { silent += Double(frame) / rate - start; pauses += 1; inSilence = false }
                    run = 0
                }
                subSum += e
                subCount += 1
                if subCount == sub { subs.append(subSum); subSum = 0; subCount = 0 }
                frame += 1
            }
            progress(job, "audio", Double(frame) / rate / max(0.1, limit), &last)
        }
        if reader.status == .failed { throw Failure(errorDescription: "iOS no pudo leer el audio: \(reader.error?.localizedDescription ?? "")") }
        let seconds = Double(frame) / rate
        if inSilence { silent += seconds - start }
        var blocks: [Double] = []
        if subs.count >= 4 { for j in 0...(subs.count - 4) { blocks.append((subs[j] + subs[j + 1] + subs[j + 2] + subs[j + 3]) / Double(4 * sub)) } }
        let loudness = { (z: Double) -> Double in -0.691 + 10 * log10(z) }
        let gated = blocks.filter { $0 > 0 && loudness($0) > -70 }
        var lufs: Any = NSNull()
        if !gated.isEmpty {
            let relative = loudness(gated.reduce(0, +) / Double(gated.count)) - 10
            let kept = gated.filter { loudness($0) > relative }
            if !kept.isEmpty { lufs = (loudness(kept.reduce(0, +) / Double(kept.count)) * 10).rounded() / 10 }
        }
        return ["audio": true, "silent": silent, "pauses": pauses, "lufs": lufs, "seconds": seconds]
    }

    // MARK: bajar de YouTube

    /// {url, path, size, phase}: de googlevideo.com (lo que da youtubei.js en la página, src/iphone/host/youtube.ts) a la
    /// carpeta de datos, en tramos de 10 MB con `&range=` (un pedido más largo YouTube lo frena a ~32 KB/s), con tres
    /// intentos por tramo. Sin cookies ni encabezados: las direcciones ya vienen firmadas (y atadas a esta red).
    private static func download(_ a: [String: Any], job: String) async throws -> [String: Any] {
        guard let s = a["url"] as? String, let u = URL(string: s), u.scheme == "https", let host = u.host?.lowercased(), host.hasSuffix(".googlevideo.com"),
              let rel = a["path"] as? String, let dest = Storage.resolve(Storage.data, rel) else { throw Failure(errorDescription: "Dirección no permitida") }
        let size = (a["size"] as? NSNumber)?.int64Value ?? 0
        let phase = a["phase"] as? String ?? "download"
        try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: dest.path, contents: nil)
        let file = try FileHandle(forWritingTo: dest)
        defer { try? file.close() }
        let chunk: Int64 = 10_000_000
        var got: Int64 = 0, last = -1.0
        while size <= 0 || got < size {
            try check(job)
            let end = size > 0 ? min(size, got + chunk) - 1 : got + chunk - 1
            guard let part = URL(string: s + (s.contains("?") ? "&" : "?") + "range=\(got)-\(end)") else { throw Failure(errorDescription: "Dirección inválida") }
            var data = Data(), tries = 0
            while true {
                do {
                    var req = URLRequest(url: part)
                    req.timeoutInterval = 60
                    let (d, resp) = try await URLSession.shared.data(for: req)
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    if code == 416 && size <= 0 { break } // sin tamaño: ya no queda nada
                    guard code == 200 || code == 206 else { throw Failure(errorDescription: "YouTube respondió \(code) al bajar el video") }
                    data = d
                    break
                } catch {
                    tries += 1
                    if tries >= 3 { throw error }
                    try await Task.sleep(nanoseconds: 1_500_000_000)
                }
            }
            if data.isEmpty { break }
            try file.write(contentsOf: data)
            got += Int64(data.count)
            if size > 0 { progress(job, phase, Double(got) / Double(size), &last) }
            else if Int64(data.count) < chunk { break } // sin tamaño: el último tramo vino corto
        }
        return ["size": got]
    }
}
