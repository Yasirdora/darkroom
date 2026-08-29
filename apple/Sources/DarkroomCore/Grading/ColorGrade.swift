import Foundation

/// The colour grade, on the CPU.
///
/// The Metal kernel in `DarkroomRender` is the production path — this exists
/// for the two jobs a GPU kernel cannot do. Baking a grade into a `.cube` file
/// needs the transform evaluated across a lattice, not applied to an image. And
/// the conformance suite needs something to hold the kernel against; a kernel
/// checked only against itself is not checked.
///
/// It mirrors the TypeScript engine's formulas in one respect and departs in
/// another. Same constants, same stage ordering; but no rounding to bytes
/// between stages, because the pipeline carries 16-bit float throughout and
/// quantising here would build the web engine's precision loss into the native
/// one.
public enum ColorGrade {

    /// Applies the colour stage to one pixel, in 8-bit sRGB code values.
    ///
    /// Spatial adjustments — clarity, sharpening, vignette, grain — are absent
    /// by construction: each depends on a pixel's neighbours, and this function
    /// sees one pixel.
    public static func apply(
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
            // Faded out as chroma does. Hue is undefined at zero chroma and
            // unreliable near it, so a boost that survives to zero paints
            // rounding noise as colour.
            boost *= chromaConfidence(c.x, c.y, c.z)
            saturation = (saturation + boost).clamped(to: 0...1)
        }
        hsl.saturation = saturation

        let converted = hslToRGB(hsl.hue, hsl.saturation, hsl.lightness)
        c = SIMD3(converted.r, converted.g, converted.b)

        if vibrance > 0 {
            let weight = skinToneWeight(preColor.x, preColor.y, preColor.z)
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

    /// Hermite smoothstep, **without** a guard on the denominator.
    ///
    /// The guard matters, by its absence. The shadow and black controls call
    /// this with the edges reversed — `smoothstep(0.5, 0, lum)` — so the
    /// denominator is legitimately negative, and clamping it to a small
    /// positive number inverts the ramp: shadows would lift where they should
    /// hold and hold where they should lift.
    ///
    /// The film model's ``JSMath/smoothstep(_:_:_:)`` *does* guard, because its
    /// edges are always increasing and a zero-width range there is a genuine
    /// degenerate case. Same function, different call sites, different correct
    /// answer — which is why they are not shared.
    ///
    /// Equal edges divide by zero and produce an infinity, which the clamp
    /// resolves to 0 or 1. That is what the reference does too.
    private static func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
        let t = ((x - e0) / (e1 - e0)).clamped(to: 0...1)
        return t * t * (3 - 2 * t)
    }

}

