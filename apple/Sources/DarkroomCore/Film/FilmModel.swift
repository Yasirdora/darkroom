import Foundation

/// Renders pixels through a film stock's emulsion and scanning model.
///
/// The chain runs in the order a real negative does, and the order matters:
///
/// 1. **Characteristic curve** — per channel, shifted by the pixel's own
///    exposure zone, which is what latitude means.
/// 2. **Dye cross-talk** — each layer absorbing a little of its neighbours' light.
/// 3. **Scanner** — the lab's own colour signature.
/// 4. **Timing** — split-toning shadows and highlights in density space.
/// 5. **Saturation and vibrance**.
/// 6. **Halation** — light scattering back off the film base into bright edges.
///
/// The print stage sits between the scan and the timing; see ``applyPrint``.
///
/// Every stage is colour-only, so the whole chain bakes into a ``ColorCube``
/// once per stock and the render layer samples a texture per pixel.
public enum FilmModel {

    /// Blend factor for skin protection. Applied to the timing and saturation
    /// stages, so a strong look still reads on skin — just at 40% strength.
    static let skinPreserveBlend = 0.4

    // MARK: - Public entry point

    /// Renders one 8-bit pixel through a stock's full chain.
    public static func render(
        r: Double, g: Double, b: Double,
        through stock: FilmStock
    ) -> (r: Double, g: Double, b: Double) {
        let lum = filmLuma(r, g, b)
        let zones = exposureZones(lum)

        // Latitude scales how far a pixel's exposure is allowed to reshape its
        // own curve. At zero the stock behaves like a slide: one fixed
        // response, no forgiveness at either end.
        let under = zones.under * stock.latitude
        let over = zones.over * stock.latitude

        var cr = applyCurve(r, stock.redCurve, under: under, over: over) * 255
        var cg = applyCurve(g, stock.greenCurve, under: under, over: over) * 255
        var cb = applyCurve(b, stock.blueCurve, under: under, over: over) * 255

        (cr, cg, cb) = stock.dyeMatrix.apply(cr, cg, cb, clampingNegatives: false)
        (cr, cg, cb) = applyScanner(cr, cg, cb, stock.scanner, luminance: lum)

        // Printed after the scan of the negative and before the lab's colour
        // timing, which is the order the darkroom works in: the print
        // establishes the tonal shape, then timing decides the balance printed
        // into it.
        if stock.print.contrast > 1e-6 {
            cr = applyPrint(cr / 255, stock.print) * 255
            cg = applyPrint(cg / 255, stock.print) * 255
            cb = applyPrint(cb / 255, stock.print) * 255
        }

        // Skin protection tests the *original* pixel here, before the chain has
        // moved it — but tests the *processed* pixel inside the saturation
        // stage below. That asymmetry is deliberate in the original and is
        // preserved; see Docs/PortingNotes.md.
        let preserveSkin = stock.preservesSkinTones && isSkinTone(r, g, b)

        let beforeTiming = (r: cr, g: cg, b: cb)
        (cr, cg, cb) = applyTiming(cr, cg, cb, stock)
        if preserveSkin {
            cr = JSMath.lerp(beforeTiming.r, cr, skinPreserveBlend)
            cg = JSMath.lerp(beforeTiming.g, cg, skinPreserveBlend)
            cb = JSMath.lerp(beforeTiming.b, cb, skinPreserveBlend)
        }

        (cr, cg, cb) = applySaturation(
            cr, cg, cb,
            saturation: stock.saturation,
            vibrance: stock.vibrance,
            preserveSkin: stock.preservesSkinTones
        )
        (cr, cg, cb) = applyHalation(
            cr, cg, cb,
            amount: stock.halation,
            warmth: stock.halationWarmth
        )

        return (JSMath.clampByte(cr), JSMath.clampByte(cg), JSMath.clampByte(cb))
    }

    /// Bakes a stock into a colour cube.
    ///
    /// Called once per look, then cached — the cube is what the render layer
    /// actually samples.
    public static func bake(_ stock: FilmStock, size: Int = ColorCube.defaultSize) -> ColorCube {
        ColorCube(size: size) { r, g, b in render(r: r, g: g, b: b, through: stock) }
    }

    // MARK: - Stages

    /// How strongly a pixel reads as under-, correctly, or over-exposed.
    ///
    /// Thresholds are in 8-bit code values and overlap deliberately, so a pixel
    /// crossing a boundary is never reshaped abruptly.
    static func exposureZones(_ lum: Double) -> (under: Double, mid: Double, over: Double) {
        (
            under: 1 - JSMath.smoothstep(45, 100, lum),
            mid: JSMath.smoothstep(70, 110, lum) * (1 - JSMath.smoothstep(175, 215, lum)),
            over: JSMath.smoothstep(195, 240, lum)
        )
    }

    /// One channel's characteristic curve, shifted by exposure zone.
    ///
    /// Under-exposure lengthens and lifts the toe — shadows go milky rather
    /// than black. Over-exposure flattens gamma and pulls the shoulder earlier
    /// and harder, which is why film highlights roll off instead of clipping.
    static func applyCurve(
        _ value: Double,
        _ curve: ChannelCurve,
        under: Double,
        over: Double
    ) -> Double {
        var x = ((value / 255) * curve.gain).clamped(to: 0...1)

        let toeLength = curve.toe + under * 0.04
        let toeLift = curve.toeLift + under * 0.03
        let gamma = curve.gamma - over * 0.08
        let shoulder = curve.shoulder - over * 0.06
        let shoulderStrength = curve.shoulderStrength + over * 0.15

        if x < toeLength {
            // Quadratic through the toe: the response accelerates out of black
            // rather than starting at full slope.
            let t = x / max(toeLength, 0.001)
            x = toeLift + t * t * (toeLength - toeLift)
        } else {
            let normalized = (x - toeLength) / max(1 - toeLength, 0.001)
            x = toeLift + pow(normalized, 1 / max(gamma, 0.55)) * (1 - toeLift)
        }

        if x > shoulder {
            // Exponential approach to the ceiling — asymptotic, so highlights
            // compress without ever hard-clipping.
            let excess = (x - shoulder) / max(1 - shoulder, 0.001)
            x = shoulder + (1 - shoulder) * (1 - exp(-excess * (1.6 + shoulderStrength * 2.8)))
        }

        return x.clamped(to: 0...1)
    }

    /// The lab scanner's colour signature, weighted toward shadows or highlights.
    static func applyScanner(
        _ r: Double, _ g: Double, _ b: Double,
        _ scanner: ScannerProfile,
        luminance lum: Double
    ) -> (r: Double, g: Double, b: Double) {
        let shadowWeight = 1 - JSMath.smoothstep(55, 150, lum)
        let highlightWeight = JSMath.smoothstep(150, 230, lum)

        switch scanner {
        case .frontier:
            // Cool, lifted shadows and slightly warm highlights.
            return (
                r - shadowWeight * 4 + highlightWeight * 3,
                g + shadowWeight * 1,
                b + shadowWeight * 8 - highlightWeight * 2
            )
        case .noritsu:
            // Warm throughout, strongest in the shadows.
            return (
                r + shadowWeight * 6 + highlightWeight * 4,
                g + shadowWeight * 4 + highlightWeight * 2,
                b + shadowWeight * 2
            )
        case .ecn2:
            // Heavy cyan-blue shadow bias, as the print stage expects.
            return (
                r - shadowWeight * 6,
                g + shadowWeight * 2,
                b + shadowWeight * 12 - highlightWeight * 3
            )
        case .ecp:
            return (
                r + highlightWeight * 2,
                g + highlightWeight * 1,
                b - shadowWeight * 2 + highlightWeight * 1
            )
        case .neutral:
            return (r, g, b)
        }
    }

    /// Split-tones shadows and highlights toward their timing hues.
    static func applyTiming(
        _ r: Double, _ g: Double, _ b: Double,
        _ stock: FilmStock
    ) -> (r: Double, g: Double, b: Double) {
        var (r, g, b) = (r, g, b)
        let lum = filmLuma(r, g, b)

        let shadowWeight = (1 - JSMath.smoothstep(50, 145, lum)) * stock.shadowTint
        let highlightWeight = JSMath.smoothstep(120, 225, lum) * stock.highlightTint

        if shadowWeight > 0.001 {
            // Tint carries the pixel's own lightness, so toning shifts hue
            // without shifting exposure.
            let tint = hslToRGB(stock.shadowHue, 0.3, lum / 255)
            r = JSMath.lerp(r, tint.r, shadowWeight)
            g = JSMath.lerp(g, tint.g, shadowWeight)
            b = JSMath.lerp(b, tint.b, shadowWeight)
        }
        if highlightWeight > 0.001 {
            let tint = hslToRGB(stock.highlightHue, 0.24, lum / 255)
            r = JSMath.lerp(r, tint.r, highlightWeight)
            g = JSMath.lerp(g, tint.g, highlightWeight)
            b = JSMath.lerp(b, tint.b, highlightWeight)
        }

        return (r, g, b)
    }

    /// Saturation and vibrance, with optional skin protection.
    ///
    /// Vibrance is weighted by `1 - saturation`, so muted colours move and
    /// already-saturated ones are left alone.
    static func applySaturation(
        _ r: Double, _ g: Double, _ b: Double,
        saturation: Double,
        vibrance: Double,
        preserveSkin: Bool
    ) -> (r: Double, g: Double, b: Double) {
        let original = rgbToHSL(r, g, b)
        var hsl = original

        let vibranceBoost = vibrance * (1 - hsl.saturation)
        hsl.saturation = (hsl.saturation * saturation + vibranceBoost).clamped(to: 0...1)

        // Note: this tests the pixel as the chain has already transformed it,
        // not the original. See render(r:g:b:through:).
        let isSkin = preserveSkin && isSkinTone(r, g, b)

        // A hue that has drifted more than 15° off skin is snapped back — the
        // shift that would read as an unnatural face.
        if isSkin, hueDistance(hsl.hue, original.hue) > 15 {
            hsl.hue = original.hue
        }

        let converted = hslToRGB(hsl.hue, hsl.saturation, hsl.lightness)
        var out = converted

        if isSkin {
            out = (
                JSMath.lerp(r, out.r, skinPreserveBlend),
                JSMath.lerp(g, out.g, skinPreserveBlend),
                JSMath.lerp(b, out.b, skinPreserveBlend)
            )
        }

        return out
    }

    /// Halation: light scattering off the film base back into bright edges.
    ///
    /// Colour-only here, keyed off luminance. The spatial bloom that makes
    /// halation recognisable belongs to the render layer.
    /// Exposes one channel through the print stock.
    ///
    /// A logistic curve, normalised so that 0 and 1 land exactly on themselves.
    /// That normalisation matters more than it looks: without it every print
    /// would also be an exposure change, and a stock's carefully placed toe lift
    /// would move every time its contrast was adjusted.
    ///
    /// Monotonic for any positive steepness, so it can never fold the tone scale
    /// back on itself — the failure that turns a highlight darker than the
    /// midtone beside it.
    static func applyPrint(_ value: Double, _ print: PrintProfile) -> Double {
        guard print.contrast > 1e-6 else { return value }
        let k = print.contrast
        let p = print.pivot
        func f(_ x: Double) -> Double { 1 / (1 + exp(-k * (x - p))) }
        let lo = f(0)
        let hi = f(1)
        let span = hi - lo
        guard span > 1e-9 else { return value }
        return (f(value) - lo) / span
    }

    static func applyHalation(
        _ r: Double, _ g: Double, _ b: Double,
        amount: Double,
        warmth: Double
    ) -> (r: Double, g: Double, b: Double) {
        let mask = JSMath.smoothstep(215, 250, filmLuma(r, g, b)) * amount
        guard mask >= 0.001 else { return (r, g, b) }
        return (
            r + mask * 16 * warmth,
            g + mask * 6 * warmth,
            b - mask * 3 * (1 - warmth)
        )
    }

    /// Shortest angular distance between two hues, in degrees.
    static func hueDistance(_ a: Double, _ b: Double) -> Double {
        let delta = abs(a - b)
        return delta > 180 ? 360 - delta : delta
    }
}
