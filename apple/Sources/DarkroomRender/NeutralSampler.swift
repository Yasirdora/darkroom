public import CoreImage
import DarkroomCore

/// Estimates what a photograph's neutral ought to be.
///
/// Grey-world — average everything and call it neutral — is the textbook
/// answer and it is wrong on exactly the pictures people shoot. A plate of
/// salmon averages orange, so grey-world drives the whole frame cyan trying to
/// neutralise the food. The failure is confident and total, and it is why
/// automatic white balance has a reputation.
///
/// What is measured here instead is only the part of the image that is already
/// plausibly neutral: mid-tone pixels of low saturation, which is where a cast
/// actually shows. A grey card, a white wall, concrete, skin under a mixed
/// source. Strongly coloured subjects are excluded rather than averaged in, so
/// the salmon is ignored and the plate under it is not.
///
/// When a frame genuinely has no neutral content the threshold widens in
/// stages, and at the last stage this is grey-world again — because at that
/// point grey-world is the only information there is, and saying so is better
/// than refusing to act.
public enum NeutralSampler {

    /// The result of a measurement, and how much to trust it.
    public struct Estimate: Sendable, Equatable {
        /// The average colour of the neutral candidates, 0…255.
        public var colour: SIMD3<Double>

        /// Fraction of the sampled pixels that qualified.
        ///
        /// Surfaced so the interface can say when a reading rests on very
        /// little. A correction derived from 0.3% of the frame is a guess
        /// wearing a number's clothes.
        public var coverage: Double

        /// Whether the estimate had to fall back to averaging everything.
        public var isGreyWorld: Bool
    }

    /// Side length the image is reduced to before measuring.
    ///
    /// A white balance estimate is a statistic over large areas; it does not
    /// improve past a couple of hundred pixels, and reading a full frame back
    /// from the GPU for it would stall the interface for no gain.
    static let sampleSize = 160

    /// Saturation ceilings, tried in order.
    ///
    /// Each stage admits more of the frame. The first is tight enough that only
    /// genuinely near-neutral surfaces qualify; the last admits everything and
    /// is grey-world by another name.
    static let saturationStages: [Double] = [0.12, 0.22, 0.35, 1.0]

    /// The smallest share of the frame an estimate may rest on before the
    /// threshold widens.
    static let minimumCoverage = 0.02

    /// Measures an image's neutral.
    ///
    /// - Parameter image: The photograph *before* the grade, in the display
    ///   space the white balance gains are applied in. Measuring the graded
    ///   result instead would fold in contrast and saturation, which are not
    ///   invertible, and the correction would only ever be approximate.
    public static func estimate(_ image: CIImage, in context: CIContext) -> Estimate? {
        guard let pixels = sample(image, in: context) else { return nil }
        return estimate(pixels: pixels)
    }

    /// The statistics, separated from the rendering so they can be checked
    /// against known inputs without a GPU.
    public static func estimate(pixels: [SIMD3<Double>]) -> Estimate? {
        guard !pixels.isEmpty else { return nil }

        // Very dark and very bright pixels are excluded at every stage. Near
        // black there is no ratio left to measure — quantisation dominates —
        // and near white a clipped channel has lost the very excess that
        // identifies the cast, so a blown highlight always measures neutral
        // however coloured the light was.
        let usable = pixels.filter { pixel in
            let luma = 0.2126 * pixel.x + 0.7152 * pixel.y + 0.0722 * pixel.z
            return luma >= 38 && luma <= 229
        }
        guard !usable.isEmpty else { return nil }

        for (stage, ceiling) in saturationStages.enumerated() {
            var total = SIMD3<Double>(repeating: 0)
            var count = 0

            for pixel in usable where saturation(pixel) <= ceiling {
                total += pixel
                count += 1
            }

            let coverage = Double(count) / Double(pixels.count)
            let isLast = stage == saturationStages.count - 1
            guard count > 0, coverage >= minimumCoverage || isLast else { continue }

            return Estimate(
                colour: total / Double(count),
                coverage: coverage,
                isGreyWorld: isLast
            )
        }

        return nil
    }

    /// How far a pixel is from neutral, independent of how bright it is.
    static func saturation(_ pixel: SIMD3<Double>) -> Double {
        let highest = Swift.max(pixel.x, Swift.max(pixel.y, pixel.z))
        let lowest = Swift.min(pixel.x, Swift.min(pixel.y, pixel.z))
        guard highest > 0 else { return 0 }
        return (highest - lowest) / highest
    }

    /// Reads a small version of the image back as pixels.
    static func sample(_ image: CIImage, in context: CIContext) -> [SIMD3<Double>]? {
        let extent = image.extent
        guard !extent.isInfinite, !extent.isEmpty else { return nil }

        let scale = Double(sampleSize) / Swift.max(extent.width, extent.height)
        let scaled = scale < 1
            ? image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            : image

        let bounds = scaled.extent.integral
        guard !bounds.isEmpty else { return nil }

        let width = Int(bounds.width)
        let height = Int(bounds.height)
        let rowBytes = width * 4
        var buffer = [UInt8](repeating: 0, count: rowBytes * height)

        buffer.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else { return }
            context.render(
                scaled,
                toBitmap: base,
                rowBytes: rowBytes,
                bounds: bounds,
                format: .RGBA8,
                // The same space the gains are applied in. Measuring in linear
                // and correcting in display space would give a correction that
                // is wrong by the transfer function.
                colorSpace: CGColorSpace(name: CGColorSpace.sRGB)
            )
        }

        var pixels: [SIMD3<Double>] = []
        pixels.reserveCapacity(width * height)
        for index in stride(from: 0, to: buffer.count, by: 4) {
            // Transparent pixels are not part of the photograph. A cutout's
            // surround would otherwise drag every reading toward whatever the
            // undefined area happens to hold.
            guard buffer[index + 3] > 127 else { continue }
            pixels.append(SIMD3(
                Double(buffer[index]),
                Double(buffer[index + 1]),
                Double(buffer[index + 2])
            ))
        }

        return pixels.isEmpty ? nil : pixels
    }
}
