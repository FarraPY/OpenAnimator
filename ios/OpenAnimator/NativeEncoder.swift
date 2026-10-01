import AVFoundation
import CoreGraphics
import ImageIO

/// Exportación con AVFoundation (el codificador de hardware de iOS), la de la app: los fotogramas llegan de la captura de
/// iOS (NativeCapture, appendCaptured: sin pasar por la página) o, con el método compatible, como JPEG; el audio, como PCM. El video (AVAssetWriter) y el audio (AVAudioFile, AAC) van a dos
/// archivos temporales y al final se juntan sin recodificar (AVAssetExportSession, passthrough): ninguno espera al otro.
final class NativeEncoder {
    struct Failure: LocalizedError { let errorDescription: String? }
    private static func fail(_ s: String) -> Failure { Failure(errorDescription: s) }

    private static var current: NativeEncoder?
    private static let video = DispatchQueue(label: "oa.venc", qos: .userInitiated)
    private static let sound = DispatchQueue(label: "oa.aenc", qos: .userInitiated)

    /// venc.start / frame / audio / finish / cancel. El video y el cierre van en una cola; el audio, en otra.
    static func handle(_ op: String, _ a: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        let respond: (Result<Any, Error>) -> Void = { r in
            DispatchQueue.main.async {
                switch r {
                case .success(let v): reply(v, nil)
                case .failure(let e): reply(nil, (e as? LocalizedError)?.errorDescription ?? e.localizedDescription)
                }
            }
        }
        if op == "venc.audio" {
            sound.async {
                do {
                    guard let job = NativeEncoder.current else { throw NativeEncoder.fail("No hay una exportación en curso") }
                    try job.appendAudio(a)
                    respond(.success(true))
                } catch { respond(.failure(error)) }
            }
            return
        }
        video.async {
            do {
                switch op {
                case "venc.start":
                    NativeEncoder.current?.discard()
                    NativeEncoder.current = nil
                    NativeEncoder.current = try NativeEncoder(a)
                    respond(.success(["codec": (a["codec"] as? String) == "hevc" ? "HEVC" : "H.264", "native": true] as [String: Any]))
                case "venc.frame":
                    guard let job = NativeEncoder.current else { throw NativeEncoder.fail("No hay una exportación en curso") }
                    try job.appendFrame(a)
                    respond(.success(Double(job.frames)))
                case "venc.frames":
                    respond(.success(Double(NativeEncoder.current?.frames ?? 0)))
                case "venc.finish":
                    guard let job = NativeEncoder.current else { throw NativeEncoder.fail("No hay una exportación en curso") }
                    NativeEncoder.current = nil
                    job.finish(respond)
                case "venc.cancel":
                    NativeEncoder.current?.discard()
                    NativeEncoder.current = nil
                    respond(.success(true))
                default:
                    throw NativeEncoder.fail("Operación desconocida: \(op)")
                }
            } catch { respond(.failure(error)) }
        }
    }

    private let out: URL, dir: URL, videoURL: URL, audioURL: URL
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let width: Int, height: Int, fps: Int32
    private let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    private var frames: Int64 = 0
    /// Sólo se toca desde la cola del audio.
    private var audio: AVAudioFile?

    private init(_ a: [String: Any]) throws {
        let num = { (k: String, d: Double) -> Double in (a[k] as? NSNumber)?.doubleValue ?? d }
        guard let rel = a["out"] as? String, let out = Storage.resolve(Storage.data, rel) else { throw NativeEncoder.fail("Ruta inválida") }
        let w = Int(num("width", 1080)), h = Int(num("height", 1920))
        let f = Int32(max(1, min(240, num("fps", 30))))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("oa-export-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let videoURL = dir.appendingPathComponent("video.mp4")
        let writer = try AVAssetWriter(outputURL: videoURL, fileType: .mp4)
        let hevc = (a["codec"] as? String) == "hevc"
        var props: [String: Any] = [
            AVVideoAverageBitRateKey: Int(num("bitrate", 8_000_000)),
            AVVideoMaxKeyFrameIntervalKey: max(1, Int(Double(f) * num("keyframeSec", 2))),
            AVVideoExpectedSourceFrameRateKey: Int(f),
        ]
        if !hevc { props[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
            AVVideoWidthKey: w, AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: props,
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
        ])
        guard writer.canAdd(input) else { throw NativeEncoder.fail("AVAssetWriter no acepta ese video") }
        writer.add(input)
        self.out = out; self.dir = dir; self.videoURL = videoURL; self.audioURL = dir.appendingPathComponent("audio.m4a")
        self.writer = writer; self.input = input; self.adaptor = adaptor
        width = w; height = h; fps = f
        guard writer.startWriting() else { throw NativeEncoder.fail(writer.error?.localizedDescription ?? "AVAssetWriter no arrancó") }
        writer.startSession(atSourceTime: .zero)
        if let au = a["audio"] as? [String: Any] {
            let file = try AVAudioFile(forWriting: audioURL, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: (au["sampleRate"] as? NSNumber)?.doubleValue ?? 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: (au["bitrate"] as? NSNumber)?.intValue ?? 192_000,
            ], commonFormat: .pcmFormatFloat32, interleaved: false)
            NativeEncoder.sound.sync { audio = file }
        }
    }

    /// Una imagen de la captura de iOS al codificador, en orden (en la cola del video). done: nil o el error.
    static func appendCaptured(_ image: CGImage, _ done: @escaping (String?) -> Void) {
        video.async {
            guard let job = current else { done("No hay una exportación en curso"); return }
            do { try job.appendImage(image); done(nil) } catch { done((error as? LocalizedError)?.errorDescription ?? error.localizedDescription) }
        }
    }

    /// Un fotograma (JPEG en base64) al codificador, en orden.
    private func appendFrame(_ a: [String: Any]) throws {
        guard let b64 = a["data"] as? String, let jpeg = Data(base64Encoded: b64),
              let src = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { throw NativeEncoder.fail("Fotograma inválido") }
        try appendImage(image)
    }

    private func appendImage(_ image: CGImage) throws {
        guard let pool = adaptor.pixelBufferPool else { throw NativeEncoder.fail(writer.error?.localizedDescription ?? "El codificador de iOS no arrancó") }
        var buffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let pb = buffer else { throw NativeEncoder.fail("Sin memoria para el fotograma") }
        CVPixelBufferLockBaseAddress(pb, [])
        let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: width, height: height, bitsPerComponent: 8,
                            bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: space,
                            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        ctx?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        CVPixelBufferUnlockBaseAddress(pb, [])
        guard ctx != nil else { throw NativeEncoder.fail("No se pudo preparar el fotograma") }
        // No es en tiempo real: se espera a que el codificador pueda tomar otro (con un límite, por si se traba).
        let limit = Date().addingTimeInterval(30)
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed { throw NativeEncoder.fail(writer.error?.localizedDescription ?? "El codificador de iOS falló") }
            if Date() > limit { throw NativeEncoder.fail("El codificador de video de iOS dejó de responder.") }
            usleep(2_000)
        }
        guard adaptor.append(pb, withPresentationTime: CMTime(value: frames, timescale: fps)) else {
            throw NativeEncoder.fail(writer.error?.localizedDescription ?? "No se pudo agregar el fotograma")
        }
        frames += 1
    }

    /// PCM float32 planar en base64 (todo el canal izquierdo y después el derecho), en orden.
    private func appendAudio(_ a: [String: Any]) throws {
        guard let file = audio else { return }
        guard let b64 = a["data"] as? String, let data = Data(base64Encoded: b64) else { throw NativeEncoder.fail("Audio inválido") }
        let n = data.count / 8
        let format = file.processingFormat
        guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)), let ch = buf.floatChannelData else { return }
        buf.frameLength = AVAudioFrameCount(n)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            for c in 0..<Int(format.channelCount) { memcpy(ch[c], base + min(c, 1) * n * 4, n * 4) }
        }
        try file.write(from: buf)
    }

    private func finish(_ done: @escaping (Result<Any, Error>) -> Void) {
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(value: frames, timescale: fps))
        writer.finishWriting { [self] in
            guard writer.status == .completed else {
                let message = writer.error?.localizedDescription ?? "No se pudo cerrar el video"
                discard()
                done(.failure(NativeEncoder.fail(message)))
                return
            }
            // El .m4a se cierra al soltar el AVAudioFile (en su cola: después de lo último que se escribió).
            let hasAudio: Bool = NativeEncoder.sound.sync { let had = audio != nil; audio = nil; return had }
            let fm = FileManager.default
            do {
                try fm.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
                if fm.fileExists(atPath: out.path) { try fm.removeItem(at: out) }
                if !hasAudio {
                    try fm.moveItem(at: videoURL, to: out)
                    try? fm.removeItem(at: dir)
                    done(.success(result()))
                    return
                }
            } catch {
                discard()
                done(.failure(error))
                return
            }
            mux { error in
                try? fm.removeItem(at: self.dir)
                if let error { done(.failure(error)) } else { done(.success(self.result())) }
            }
        }
    }

    /// Video + audio en el MP4 final, sin recodificar.
    private func mux(_ done: @escaping (Error?) -> Void) {
        let comp = AVMutableComposition()
        let v = AVURLAsset(url: videoURL), s = AVURLAsset(url: audioURL)
        let duration = v.duration
        do {
            if let t = v.tracks(withMediaType: .video).first, let c = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) {
                try c.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: t, at: .zero)
            }
            if let t = s.tracks(withMediaType: .audio).first, let c = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                try c.insertTimeRange(CMTimeRange(start: .zero, duration: CMTimeMinimum(s.duration, duration)), of: t, at: .zero)
            }
        } catch { done(error); return }
        guard let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough) else { done(NativeEncoder.fail("No se pudo juntar el audio")); return }
        ex.outputURL = out
        ex.outputFileType = .mp4
        ex.exportAsynchronously {
            if ex.status == .completed { done(nil); return }
            let error: Error = ex.error ?? NativeEncoder.fail("No se pudo juntar el audio")
            done(error)
        }
    }

    private func result() -> [String: Any] {
        let attrs = try? FileManager.default.attributesOfItem(atPath: out.path)
        let size = (attrs?[.size] as? NSNumber)?.doubleValue ?? 0
        return ["path": Storage.relative(out), "size": size, "frames": Double(frames), "duration": Double(frames) / Double(fps)]
    }

    /// Cancelada o fallida: se cierra todo y se borran los temporales.
    private func discard() {
        if writer.status == .writing { writer.cancelWriting() }
        NativeEncoder.sound.sync { audio = nil }
        try? FileManager.default.removeItem(at: dir)
    }
}
