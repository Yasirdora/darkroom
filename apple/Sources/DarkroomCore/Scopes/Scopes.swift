import Foundation

/// A tonal distribution: one count per code value, per channel.
///
/// The counts are what a colourist reads to see clipping, crushed blacks and
/// where the tonal weight of an image actually sits — things the eye judges
/// unreliably on a screen of unknown calibration.
public struct Histogram: Sendable, Equatable {

    /// Code values per channel. Always 256: the histogram describes the
    /// *displayed* image, and a display is 8-bit however the pipeline computes.
    public static let binCount = 256

    public let red: [UInt32]
    public let green: [UInt32]
    public let blue: [UInt32]
    public let luminance: [UInt32]

    /// The largest count in any bin of any channel.
    ///
    /// Carried rather than recomputed because the display needs it to scale
    /// the plot, and finding it again means another pass over 1,024 bins on
    /// every frame of a slider drag.
    public let peak: UInt32

    public init(red: [UInt32], green: [UInt32], blue: [UInt32], luminance: [UInt32], peak: UInt32) {
        self.red = red
        self.green = green
        self.blue = blue
        self.luminance = luminance
        self.peak = peak
    }

    /// An empty histogram, for when no image is open.
    public static let empty = Histogram(
        red: Array(repeating: 0, count: binCount),
        green: Array(repeating: 0, count: binCount),
        blue: Array(repeating: 0, count: binCount),
        luminance: Array(repeating: 0, count: binCount),
        peak: 0
    )

    /// Computes a histogram from 8-bit RGBA pixels.
    ///
    /// The CPU path. The GPU one in `DarkroomRender` is what runs during
    /// editing; this exists to check it against, and to serve callers that have
    /// pixels but no Metal device.
    public static func compute(rgba: [UInt8]) -> Histogram {
        var red = [UInt32](repeating: 0, count: binCount)
        var green = [UInt32](repeating: 0, count: binCount)
        var blue = [UInt32](repeating: 0, count: binCount)
        var luminance = [UInt32](repeating: 0, count: binCount)
        var peak: UInt32 = 0

        var index = 0
        while index + 3 < rgba.count {
            let r = Int(rgba[index])
            let g = Int(rgba[index + 1])
            let b = Int(rgba[index + 2])

            red[r] += 1
            green[g] += 1
            blue[b] += 1

            let lum = Int(JSMath.round(
                Double(r) * 0.2126 + Double(g) * 0.7152 + Double(b) * 0.0722
            ))
            luminance[lum] += 1

            peak = max(peak, red[r], green[g], blue[b], luminance[lum])
            index += 4
        }

        return Histogram(red: red, green: green, blue: blue, luminance: luminance, peak: peak)
    }
}

/// A chroma distribution, plotted on the Cb/Cr plane.
///
/// Where a histogram shows how much light an image carries, a vectorscope shows
/// what colour it is and how far from neutral — which is how a colourist spots
/// a cast that the eye has already adapted away from.
public struct Vectorscope: Sendable, Equatable {

    /// Bins per axis.
    public static let defaultSize = 96

    /// The chroma offset that reaches the edge of the plot.
    ///
    /// Chosen so the Rec.709 primaries land near the graticule targets, the
    /// same convention Resolve's square scope uses. A wider range would leave
    /// ordinary footage huddled in the middle, unreadable.
    public static let chromaRange = 0.34

    /// Counts, row-major, `size × size`.
    public let bins: [UInt32]
    public let size: Int
    public let peak: UInt32

    public init(bins: [UInt32], size: Int, peak: UInt32) {
        self.bins = bins
        self.size = size
        self.peak = peak
    }

    public static let empty = Vectorscope(
        bins: Array(repeating: 0, count: defaultSize * defaultSize),
        size: defaultSize,
        peak: 0
    )

    /// The Rec.709 skin-tone line.
    ///
    /// Skin of every complexion falls along one line on this plane — the
    /// difference between light and dark skin is mostly luminance, not hue.
    /// Drawing it lets a colourist check faces against a reference instead of
    /// against memory.
    public enum SkinToneLine {
        public static let light = (cb: -0.091, cr: 0.109)
        public static let dark = (cb: -0.044, cr: 0.058)
    }

    /// Rec.709 full-range RGB to Cb/Cr offsets from neutral.
    public static func chromaOffset(r: Double, g: Double, b: Double) -> (cb: Double, cr: Double) {
        let rn = r / 255, gn = g / 255, bn = b / 255
        let y = 0.2126 * rn + 0.7152 * gn + 0.0722 * bn
        return (cb: (bn - y) / 1.8556, cr: (rn - y) / 1.5748)
    }

    /// How many pixels to skip between samples.
    ///
    /// A vectorscope shows a distribution, and a distribution does not need
    /// every pixel — sampling a fraction gives the same picture for a fraction
    /// of the work. Matches the TypeScript engine's thresholds so both produce
    /// the same plot from the same image.
    public static func sampleStep(forByteCount count: Int) -> Int {
        if count > 4_000_000 { return 16 }
        if count > 1_500_000 { return 8 }
        return 4
    }

    /// Computes a vectorscope from 8-bit RGBA pixels.
    public static func compute(
        rgba: [UInt8],
        size: Int = defaultSize,
        step: Int? = nil
    ) -> Vectorscope {
        var bins = [UInt32](repeating: 0, count: size * size)
        var peak: UInt32 = 0

        let step = step ?? sampleStep(forByteCount: rgba.count)
        let half = Double(size - 1)
        let stride = 4 * step

        var index = 0
        while index + 3 < rgba.count {
            // Transparent pixels carry no colour worth plotting, and including
            // them would pile a spike on neutral that is not in the image.
            guard rgba[index + 3] >= 8 else {
                index += stride
                continue
            }

            let offset = chromaOffset(
                r: Double(rgba[index]),
                g: Double(rgba[index + 1]),
                b: Double(rgba[index + 2])
            )
            let x = Int(JSMath.round((offset.cb / chromaRange + 1) * 0.5 * half))
            let y = Int(JSMath.round((-offset.cr / chromaRange + 1) * 0.5 * half))

            guard x >= 0, x < size, y >= 0, y < size else {
                index += stride
                continue
            }

            let bin = y * size + x
            bins[bin] += 1
            peak = max(peak, bins[bin])
            index += stride
        }

        return Vectorscope(bins: bins, size: size, peak: peak)
    }
}
