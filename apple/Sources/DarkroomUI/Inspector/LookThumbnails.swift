public import SwiftUI
public import CoreImage
import Foundation
import DarkroomCore
import DarkroomRender

/// Renders the picker's per-stock previews.
///
/// A look chosen by name is a look chosen blind: "moodyDesat" says less than
/// forty pixels of the photograph under that grade. Every stock is rendered
/// over the same small copy of the open image — or over a test strip when
/// nothing is open — so the rows show the difference between stocks rather
/// than the difference between their descriptions.
///
/// Rendering goes through the shared cube cache (``LookFilter/cube(for:)`),
/// so a thumbnail never bakes a cube the canvas has not already baked or
/// will not reuse.
@MainActor
final class LookThumbnails {

    /// Thumbnail longest edge, in pixels. Small enough that seventy renders
    /// cost less than one frame of the full image, large enough that a
    /// curve's toe lift is visible.
    static let thumbnailSize: Double = 96

    /// The small image every stock is rendered over.
    ///
    /// A downscaled copy of the open photograph when there is one, and a
    /// synthetic strip otherwise — the strip carries a neutral ramp and four
    /// memory colours (skin, sky, foliage, a warm accent), which is what a
    /// test image has to contain for a curve and a hue response to read.
    static func baseImage(source: CIImage?) -> CIImage {
        if let source, !source.extent.isInfinite, !source.extent.isEmpty {
            let extent = source.extent
            let scale = thumbnailSize / max(extent.width, extent.height)
            guard scale < 1 else { return source }
            return source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        return CIImage(cgImage: testStrip())
    }

    /// Renders one stock over the base image.
    static func render(
        _ stock: FilmStock,
        over base: CIImage,
        context: RenderContext
    ) -> CGImage? {
        let graded = LookFilter.apply(LookFilter.cube(for: stock), to: base)
        guard !graded.extent.isInfinite, !graded.extent.isEmpty else { return nil }
        return context.makeCGImage(graded, in: graded.extent)
    }

    /// The fallback strip: a black-to-white ramp over memory colours.
    ///
    /// Built as bytes rather than filters so it is identical on every machine
    /// and costs nothing — this image exists so the picker is never empty,
    /// not to be looked at for long.
    private static func testStrip() -> CGImage {
        let width = 96, height = 64
        var bytes = [UInt8](repeating: 0, count: width * height * 4)

        // Memory colours, left to right: skin, sky, foliage, warm accent.
        let patches: [(r: UInt8, g: UInt8, b: UInt8)] = [
            (190, 140, 110), (110, 150, 205), (95, 140, 80), (205, 120, 75),
        ]

        for y in 0..<height {
            for x in 0..<width {
                let offset = (y * width + x) * 4
                if y < height / 2 {
                    // Neutral ramp across the top half.
                    let v = UInt8((x * 255) / (width - 1))
                    bytes[offset] = v
                    bytes[offset + 1] = v
                    bytes[offset + 2] = v
                } else {
                    let patch = patches[min(x * patches.count / width, patches.count - 1)]
                    bytes[offset] = patch.r
                    bytes[offset + 1] = patch.g
                    bytes[offset + 2] = patch.b
                }
                bytes[offset + 3] = 255
            }
        }

        let data = Data(bytes)
        let provider = CGDataProvider(data: data as CFData)!
        return CGImage(
            width: width, height: height,
            bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider,
            decode: nil, shouldInterpolate: false,
            intent: .defaultIntent
        )!
    }
}
