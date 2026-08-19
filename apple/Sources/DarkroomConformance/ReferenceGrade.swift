import Foundation
import DarkroomCore

/// An independent CPU implementation of the colour grade, used to check the
/// Metal kernel.
///
/// Deliberately *not* shared code. If the kernel and its expectation came from
/// one source, agreement would prove only that the source was consistent with
/// itself. Written separately from the same specification, agreement means both
/// are right — the standard argument for an independent implementation, which
/// matters most on exactly this kind of arithmetic.
///
/// It mirrors the TypeScript engine's formulas in one respect and departs in
/// another. Same constants, same stage ordering; but no rounding to bytes
/// between stages, because the Metal pipeline carries 16-bit float throughout
/// and quantising here would build the CPU engine's precision loss into the
/// thing meant to detect it.
enum ReferenceGrade {

    /// Applies the colour stage to one pixel, in 8-bit sRGB code values.
    static func apply(
        _ adjustments: Adjustments,
        r: Double, g: Double, b: Double
    ) -> (r: Double, g: Double, b: Double) {
        guard !adjustments.isNeutral else { return (r, g, b) }

        var c = SIMD3(r, g, b)

        // Exposure, in stops. The /50 scaling makes the slider's ±100 span
        // ±2 stops.
        c *= pow(2.0, adjustments.exposure / 50)

        // White balance as multiplicative gains.
        let temperature = adjustments.temperature / 100
        let tint = adjustments.tint / 100
        c *= SIMD3(
            pow(1.35, temperature) * pow(1.25, -tint / 2),
            pow(1.25, tint),
            pow(1.35, -temperature) * pow(1.25, -tint / 2)
        )

        // Contrast about mid-grey, then brightness.
        let contrast = adjustments.contrast
        let contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast))
        c = (c - 128) * contrastFactor + 128 + adjustments.brightness * 1.2

        c = toneRegions(c, adjustments)

        let preColor = c

        var hsl = rgbToHSL(c.x, c.y, c.z)
        hsl.hue = (hsl.hue + adjustments.hue + 360).truncatingRemainder(dividingBy: 360)

        let baseSaturation = hsl.saturation.clamped(to: 0...1)
        var saturation = (hsl.saturation * (100 + adjustments.saturation) / 100).clamped(to: 0...1)

        let vibrance = adjustments.vibrance / 100
        if vibrance != 0 {
            var boost = vibrance > 0
                ? vibrance * 0.7 * pow(1 - baseSaturation, 1.5)
                : vibrance * 0.7 * pow(baseSaturation, 0.7)
            let luminance = filmLuma(c.x, c.y, c.z) / 255
            boost *= ((luminance - 0.03) / 0.35).clamped(to: 0...1)
            saturation = (saturation + boost).clamped(to: 0...1)
        }
        hsl.saturation = saturation

        let converted = hslToRGB(hsl.hue, hsl.saturation, hsl.lightness)
        c = SIMD3(converted.r, converted.g, converted.b)

        if vibrance > 0 {
            let weight = skinWeight(preColor)
            if weight > 0 {
                let blend = 1 - 0.45 * weight
                c = preColor + (c - preColor) * blend
            }
        }

        let sepia = adjustments.sepia / 100
        if sepia > 0 {
            let toned = SIMD3(
                (c.x * 0.393 + c.y * 0.769 + c.z * 0.189).clamped(to: 0...255),
                (c.x * 0.349 + c.y * 0.686 + c.z * 0.168).clamped(to: 0...255),
                (c.x * 0.272 + c.y * 0.534 + c.z * 0.131).clamped(to: 0...255)
            )
            c += (toned - c) * sepia
        }

        return (
            c.x.clamped(to: 0...255),
            c.y.clamped(to: 0...255),
            c.z.clamped(to: 0...255)
        )
    }

    /// Highlights, shadows, whites and blacks, as one luminance-weighted offset.
    private static func toneRegions(_ c: SIMD3<Double>, _ adjustments: Adjustments) -> SIMD3<Double> {
        let lum = filmLuma(c.x, c.y, c.z) / 255
        var weight = 0.0

        let highlights = adjustments.highlights / 100
        if highlights != 0, lum > 0.5 {
            weight += smoothstep(0.5, 1.0, lum) * highlights * 45
        }
        let shadows = adjustments.shadows / 100
        if shadows != 0, lum < 0.5 {
            weight += smoothstep(0.5, 0.0, lum) * shadows * 45
        }
        let whites = adjustments.whites / 100
        if whites != 0, lum > 0.7 {
            weight += smoothstep(0.7, 1.0, lum) * whites * 25
        }
        let blacks = adjustments.blacks / 100
        if blacks != 0, lum < 0.3 {
            weight += smoothstep(0.3, 0.0, lum) * blacks * 25
        }

        return SIMD3(
            (c.x + weight).clamped(to: 0...255),
            (c.y + weight).clamped(to: 0...255),
            (c.z + weight).clamped(to: 0...255)
        )
    }

    private static func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
        let t = ((x - e0) / max(e1 - e0, 1e-6)).clamped(to: 0...1)
        return t * t * (3 - 2 * t)
    }

    /// Feathered skin likelihood, matching the kernel's trapezoid windows.
    private static func skinWeight(_ c: SIMD3<Double>) -> Double {
        let hsl = rgbToHSL(c.x, c.y, c.z)

        func trapezoid(_ v: Double, _ lo: Double, _ hi: Double, _ soft: Double) -> Double {
            if v >= lo && v <= hi { return 1 }
            let distance = v < lo ? lo - v : v - hi
            return max(0, 1 - distance / soft)
        }

        let hue = hsl.hue
        let hueWeight: Double = (hue <= 50 || hue >= 335)
            ? 1
            : max(0, 1 - min(hue - 50, 335 - hue) / 14)

        return hueWeight
            * trapezoid(hsl.saturation, 0.05, 0.75, 0.1)
            * trapezoid(hsl.lightness, 0.05, 0.85, 0.1)
    }
}

private extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double {
        Swift.min(range.upperBound, Swift.max(range.lowerBound, self))
    }
}
