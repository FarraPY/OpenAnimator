import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers
import Vision

/// Quitar el fondo de una imagen (oa_quitar_fondo): Vision separa las figuras (personas, animales, objetos), el mismo
/// recorte que hace Fotos al levantar el sujeto. Corre en el teléfono, gratis y sin bajar modelos (iOS 17+).
/// img.cutout {path, out, crop?} → PNG con transparencia en `out` y una vista previa sobre un damero para Claude.
enum Cutout {
    private struct Failure: LocalizedError { let errorDescription: String? }

    static func handle(_ a: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        Task.detached(priority: .userInitiated) {
            do {
                let r = try run(a)
                DispatchQueue.main.async { reply(r, nil) }
            } catch {
                let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                DispatchQueue.main.async { reply(nil, msg) }
            }
        }
    }

    private static func run(_ a: [String: Any]) throws -> [String: Any] {
        guard let src = a["path"] as? String, let inURL = Storage.resolve(Storage.data, src), FileManager.default.fileExists(atPath: inURL.path),
              let out = a["out"] as? String, let outURL = Storage.resolve(Storage.data, out) else { throw Failure(errorDescription: "No existe la imagen") }
        // Derecha (la orientación de la foto aplicada), así el recorte sale como se ve.
        guard let ui = UIImage(contentsOfFile: inURL.path) else { throw Failure(errorDescription: "No se pudo leer la imagen") }
        let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1
        guard let cg = UIGraphicsImageRenderer(size: ui.size, format: fmt).image(actions: { _ in ui.draw(at: .zero) }).cgImage else { throw Failure(errorDescription: "No se pudo leer la imagen") }

        let req = VNGenerateForegroundInstanceMaskRequest()
        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        try handler.perform([req])
        guard let obs = req.results?.first, !obs.allInstances.isEmpty else { throw Failure(errorDescription: "No encontré una figura para recortar (persona, animal u objeto)") }
        let buf = try obs.generateMaskedImage(ofInstances: obs.allInstances, from: handler, croppedToInstancesExtent: a["crop"] as? Bool ?? false)
        let ci = CIImage(cvPixelBuffer: buf)
        guard let cut = CIContext().createCGImage(ci, from: ci.extent) else { throw Failure(errorDescription: "No se pudo armar el recorte") }

        try FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let dest = CGImageDestinationCreateWithURL(outURL as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw Failure(errorDescription: "No se pudo guardar") }
        CGImageDestinationAddImage(dest, cut, nil)
        guard CGImageDestinationFinalize(dest) else { throw Failure(errorDescription: "No se pudo guardar") }
        let size = ((try? FileManager.default.attributesOfItem(atPath: outURL.path))?[.size] as? NSNumber)?.intValue ?? 0

        // Vista previa chica sobre un damero: así Claude ve qué quedó y qué se fue.
        let s = min(1, 512 / Double(max(cut.width, cut.height)))
        let pw = max(1, Int(Double(cut.width) * s)), ph = max(1, Int(Double(cut.height) * s))
        let pfmt = UIGraphicsImageRendererFormat(); pfmt.scale = 1; pfmt.opaque = true
        let jpg = UIGraphicsImageRenderer(size: CGSize(width: pw, height: ph), format: pfmt).jpegData(withCompressionQuality: 0.8) { c in
            let cell = 16
            for y in stride(from: 0, to: ph, by: cell) {
                for x in stride(from: 0, to: pw, by: cell) {
                    UIColor(white: (x / cell + y / cell) % 2 == 0 ? 0.82 : 0.62, alpha: 1).setFill()
                    c.fill(CGRect(x: x, y: y, width: cell, height: cell))
                }
            }
            UIImage(cgImage: cut).draw(in: CGRect(x: 0, y: 0, width: pw, height: ph))
        }
        return ["file": out, "size": size, "width": cut.width, "height": cut.height, "instances": obs.allInstances.count, "preview": jpg.base64EncodedString()]
    }
}
