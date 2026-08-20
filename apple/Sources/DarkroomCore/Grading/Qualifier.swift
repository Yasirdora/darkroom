import Foundation

/// A selective correction: which pixels a look applies to.
///
/// This is what separates a grading tool from a filter app. A filter changes
/// every pixel; a qualifier changes the sky and leaves the faces, or warms the
/// skin and leaves the walls. Two independent selections combine:
///
/// - a **keyer**, selecting by hue, saturation and lightness
/// - a **power window**, selecting by position
///
/// Both feather at their edges, because a hard-edged selection is visible as a
/// hard edge and no amount of subtlety elsewhere hides it.
public struct Qualifier: Sendable, Equatable, Hashable, Codable {

    /// The shape of the positional selection.
    public enum WindowShape: String, Sendable, Codable, CaseIterable, Identifiable {
        /// No positional limit — the keyer alone decides.
        case none
        /// A linear gradient, for skies and horizons.
        case linear
        /// An ellipse, for faces and isolated subjects.
        case ellipse
        /// A radial falloff.
        ///
        /// - Note: Currently identical to ``ellipse``. The TypeScript engine
        ///   declares both and computes them the same way; the distinction is
        ///   kept because the UI offers it and removing it would break saved
        ///   grades, but it is recorded as unimplemented rather than presented
        ///   as a difference that exists.
        case radial

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .none: "None"
            case .linear: "Linear"
            case .ellipse: "Ellipse"
            case .radial: "Radial"
            }
        }
    }

    public var isEnabled = false

    // MARK: Keyer

    /// Hue range in degrees. `min > max` wraps through zero, which is how reds
    /// are selected — they straddle 0°.
    public var hueMin: Double = 0
    public var hueMax: Double = 360
    public var saturationMin: Double = 0
    public var saturationMax: Double = 1
    public var lightnessMin: Double = 0
    public var lightnessMax: Double = 1

    /// Feather widths, in the units of each axis.
    public var hueSoftness: Double = 8
    public var saturationSoftness: Double = 0.1
    public var lightnessSoftness: Double = 0.1

    // MARK: Power window

    public var windowShape: WindowShape = .none
    /// Centre, normalised to the image.
    public var windowX: Double = 0.5
    public var windowY: Double = 0.5
    public var windowWidth: Double = 1
    public var windowHeight: Double = 1
    public var windowRotation: Double = 0
    public var windowFeather: Double = 0.1

    /// Selects everything the qualifier would otherwise exclude.
    public var isInverted = false

    public init() {}

    /// The hue range applied the first time a qualifier is switched on.
    ///
    /// Not the full wheel: enabling a qualifier that selects everything looks
    /// broken, because nothing changes. Starting on the warm band means the
    /// control visibly does something on the first drag.
    public static let initialHueRange = (min: 0.0, max: 80.0)

    /// Whether the hue range covers the whole wheel, in which case the keyer
    /// selects everything and only the window matters.
    public var selectsAllHues: Bool { hueMin <= 0 && hueMax >= 360 }

    /// Whether this qualifier would actually restrict anything.
    public var isRestrictive: Bool {
        isEnabled && (!selectsAllHues || windowShape != .none || isInverted)
    }
}

/// Builds selection masks on the CPU.
///
/// The GPU path in `DarkroomRender` is what runs while editing; this is the
/// reference it is checked against, and the fallback for callers without a
/// Metal device.
public enum QualifierMask {

    /// A trapezoid window: 1 inside the range, feathering linearly outside.
    ///
    /// Linear rather than smooth on purpose — it matches the TypeScript engine,
    /// and a keyer's feather is easier to judge when it is proportional to how
    /// far outside the range a pixel sits.
    @inlinable
    public static func softStep(_ value: Double, _ low: Double, _ high: Double, _ softness: Double) -> Double {
        if value >= low && value <= high { return 1 }
        let distance = value < low ? low - value : value - high
        return max(0, 1 - distance / softness)
    }

    /// The keyer's contribution for one pixel.
    public static func keyValue(r: Double, g: Double, b: Double, _ qualifier: Qualifier) -> Double {
        let hsl = rgbToHSL(r, g, b)

        // Softness floors: a zero-width feather divides by zero, and the result
        // would be a hard edge in the one place a hard edge is most visible.
        let hueSoftness = max(0.1, qualifier.hueSoftness)
        let saturationSoftness = max(0.001, qualifier.saturationSoftness)
        let lightnessSoftness = max(0.001, qualifier.lightnessSoftness)

        let hue: Double
        if qualifier.hueMin > qualifier.hueMax {
            // A range that wraps through zero — how reds are selected, since
            // they straddle 0°. Inside means above the minimum *or* below the
            // maximum, and the distance outside is to whichever edge is nearer.
            if hsl.hue >= qualifier.hueMin || hsl.hue <= qualifier.hueMax {
                hue = 1
            } else {
                let distance = min(qualifier.hueMin - hsl.hue, hsl.hue - qualifier.hueMax)
                hue = max(0, 1 - distance / hueSoftness)
            }
        } else {
            hue = softStep(hsl.hue, qualifier.hueMin, qualifier.hueMax, hueSoftness)
        }

        let saturation = softStep(
            hsl.saturation, qualifier.saturationMin, qualifier.saturationMax, saturationSoftness
        )
        let lightness = softStep(
            hsl.lightness, qualifier.lightnessMin, qualifier.lightnessMax, lightnessSoftness
        )

        return (hue * saturation * lightness).clamped(to: 0...1)
    }

    /// The power window's contribution at one position, in pixels.
    public static func windowValue(
        x: Double, y: Double,
        width: Double, height: Double,
        _ qualifier: Qualifier
    ) -> Double {
        guard qualifier.windowShape != .none else { return 1 }

        let centreX = qualifier.windowX * width
        let centreY = qualifier.windowY * height
        let radiusX = (qualifier.windowWidth * width) / 2
        let radiusY = (qualifier.windowHeight * height) / 2
        let feather = max(1, qualifier.windowFeather * min(width, height) * 0.5)

        let radians = qualifier.windowRotation * .pi / 180
        let cosine = cos(radians), sine = sin(radians)

        let dx = x - centreX
        let dy = y - centreY
        let rotatedX = dx * cosine - dy * sine
        let rotatedY = dx * sine + dy * cosine

        var value = 0.0
        switch qualifier.windowShape {
        case .ellipse, .radial:
            let nx = rotatedX / max(radiusX, 1)
            let ny = rotatedY / max(radiusY, 1)
            value = 1 - (nx * nx + ny * ny).squareRoot().clamped(to: 0...1)
        case .linear:
            value = ((rotatedX / max(radiusX, 1)) + 1) * 0.5
            value = value.clamped(to: 0...1)
        case .none:
            return 1
        }

        let ramp = ((value * (radiusX + radiusY)) / max(feather, 1)).clamped(to: 0...1)
        return (value * ramp * 1.2).clamped(to: 0...1)
    }

    /// Builds the complete mask for an image.
    ///
    /// - Parameters:
    ///   - rgba: 8-bit pixels, row-major.
    ///   - width: Image width in pixels.
    /// - Returns: One value per pixel, `0...1`.
    public static func build(
        rgba: [UInt8],
        width: Int,
        height: Int,
        qualifier: Qualifier
    ) -> [Double] {
        guard qualifier.isEnabled else {
            return Array(repeating: 1, count: width * height)
        }

        var mask = [Double](repeating: 0, count: width * height)

        // The window is softened on its own before being combined, then the
        // combination is softened again. Doing it twice is what gives a power
        // window its characteristically gentle edge while leaving the keyer's
        // edge comparatively crisp.
        var window = [Double](repeating: 1, count: width * height)
        if qualifier.windowShape != .none {
            for y in 0..<height {
                for x in 0..<width {
                    window[y * width + x] = windowValue(
                        x: Double(x), y: Double(y),
                        width: Double(width), height: Double(height),
                        qualifier
                    )
                }
            }
            let feather = max(1, qualifier.windowFeather * Double(min(width, height)) * 0.5)
            window = soften(window, width: width, height: height, radius: Int((feather * 0.25).rounded()))
        }

        for pixel in 0..<(width * height) {
            let offset = pixel * 4
            guard offset + 2 < rgba.count else { break }
            let key = keyValue(
                r: Double(rgba[offset]),
                g: Double(rgba[offset + 1]),
                b: Double(rgba[offset + 2]),
                qualifier
            )
            mask[pixel] = (key * window[pixel]).clamped(to: 0...1)
        }

        mask = soften(
            mask, width: width, height: height,
            radius: featherRadius(qualifier, width: width, height: height)
        )

        if qualifier.isInverted {
            for index in mask.indices { mask[index] = 1 - mask[index] }
        }

        return mask
    }

    /// Softening radius, in pixels.
    ///
    /// A power window's feather scales with the image, because it describes a
    /// region of the frame. A keyer's does not — it derives from hue softness
    /// in degrees, which is a property of the colour, not of the resolution.
    /// Scaling it with the image would make the same grade soften differently
    /// on a preview and an export.
    public static func featherRadius(_ qualifier: Qualifier, width: Int, height: Int) -> Int {
        if qualifier.windowShape != .none {
            return max(1, Int((qualifier.windowFeather * Double(min(width, height)) * 0.15).rounded()))
        }
        return max(1, Int((qualifier.hueSoftness * 0.4).rounded()))
    }

    /// Separable box blur. Two passes of O(radius) rather than one of
    /// O(radius²), which is the difference between usable and not on a
    /// full-resolution mask.
    static func soften(_ mask: [Double], width: Int, height: Int, radius: Int) -> [Double] {
        guard radius >= 1 else { return mask }

        var horizontal = [Double](repeating: 0, count: mask.count)
        var output = [Double](repeating: 0, count: mask.count)

        for y in 0..<height {
            for x in 0..<width {
                var sum = 0.0
                var count = 0
                for dx in -radius...radius {
                    let sampleX = x + dx
                    // Samples past the edge are skipped rather than clamped, so
                    // the average shrinks to the pixels that exist. Clamping
                    // would weight the border pixel by the whole overhang and
                    // smear it inward.
                    if sampleX >= 0 && sampleX < width {
                        sum += mask[y * width + sampleX]
                        count += 1
                    }
                }
                horizontal[y * width + x] = count > 0 ? sum / Double(count) : 0
            }
        }

        for y in 0..<height {
            for x in 0..<width {
                var sum = 0.0
                var count = 0
                for dy in -radius...radius {
                    let sampleY = y + dy
                    if sampleY >= 0 && sampleY < height {
                        sum += horizontal[sampleY * width + x]
                        count += 1
                    }
                }
                output[y * width + x] = count > 0 ? sum / Double(count) : 0
            }
        }

        return output
    }
}
