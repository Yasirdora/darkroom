import Foundation

/// Numeric helpers whose exact semantics the film model depends on.
///
/// The emulsion model was authored and tuned in JavaScript, and its output is
/// quantised to 8 bits at several points. Reproducing it byte-for-byte means
/// matching JavaScript's arithmetic where it differs from Swift's — which it
/// does, in one place that matters.
public enum JSMath {

    /// `Math.round` as ECMAScript defines it: nearest integer, **ties toward
    /// positive infinity**.
    ///
    /// Swift's `rounded()` breaks ties *away from zero*, so the two disagree on
    /// every negative half — `-2.5` rounds to `-2` here and to `-3` there. The
    /// film model reaches negative values routinely, because the dye matrix and
    /// scanner stages both subtract before anything clamps.
    ///
    /// Computed as `floor(x)` plus a fractional test rather than
    /// `floor(x + 0.5)`: adding first loses a bit for inputs just below `0.5`,
    /// where `0.49999999999999994 + 0.5` rounds up to exactly `1.0` and yields
    /// the wrong answer.
    @inlinable
    public static func round(_ x: Double) -> Double {
        guard x.isFinite else { return x }
        let floor = x.rounded(.down)
        return (x - floor >= 0.5) ? floor + 1 : floor
    }

    /// Rounds to an integer and clamps to a byte, matching `clampByte`.
    @inlinable
    public static func clampByte(_ x: Double) -> Double {
        Swift.min(255, Swift.max(0, round(x)))
    }

    /// Linear interpolation, matching `lerp`.
    @inlinable
    public static func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double {
        a + (b - a) * t
    }

    /// Hermite smoothstep, matching the film model's own helper — including its
    /// guard against a zero-width edge range.
    @inlinable
    public static func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
        let t = ((x - edge0) / Swift.max(edge1 - edge0, 0.001)).clamped(to: 0...1)
        return t * t * (3 - 2 * t)
    }
}

/// Rec.709 luma of an 8-bit RGB triplet.
///
/// The film model weights luma by Rec.709 coefficients but applies them to
/// *display-encoded* values rather than linear light. That is not
/// photometrically correct, and it is also what every one of the stock profiles
/// was tuned against — so it is preserved exactly.
@inlinable
public func filmLuma(_ r: Double, _ g: Double, _ b: Double) -> Double {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// A colour in hue, saturation and lightness.
public struct HSL: Sendable, Equatable, Hashable {
    /// Hue in degrees, `0..<360`.
    public var hue: Double
    /// Saturation, `0...1`.
    public var saturation: Double
    /// Lightness, `0...1`.
    public var lightness: Double

    public init(hue: Double, saturation: Double, lightness: Double) {
        self.hue = hue
        self.saturation = saturation
        self.lightness = lightness
    }
}

/// Converts an 8-bit RGB triplet to HSL.
///
/// - Parameters: Values nominally in `0...255`, but **not** clamped. Mid-chain
///   the film model passes values well outside that range, and clamping here
///   would change the result rather than tidy it.
public func rgbToHSL(_ r: Double, _ g: Double, _ b: Double) -> HSL {
    let rn = r / 255, gn = g / 255, bn = b / 255
    let maxComponent = max(rn, gn, bn)
    let minComponent = min(rn, gn, bn)
    let delta = maxComponent - minComponent

    let lightness = (maxComponent + minComponent) / 2

    // Float rounding can produce saturation marginally above 1.0 on fully
    // saturated colours, which downstream `pow(1 - s, 1.5)` turns into NaN and
    // then into black pixels.
    let saturation = delta == 0
        ? 0
        : min(1, delta / (1 - abs(2 * lightness - 1)))

    var hue = 0.0
    if delta != 0 {
        // Ties matter: when two channels share the maximum, JavaScript's
        // `switch (max)` takes the first matching case, so red wins over green
        // and green over blue. This chain preserves that order.
        if maxComponent == rn {
            hue = ((gn - bn) / delta).truncatingRemainder(dividingBy: 6)
        } else if maxComponent == gn {
            hue = (bn - rn) / delta + 2
        } else {
            hue = (rn - gn) / delta + 4
        }
        hue *= 60
        if hue < 0 { hue += 360 }
    }

    return HSL(hue: hue, saturation: saturation, lightness: lightness)
}

/// Converts HSL back to an 8-bit RGB triplet.
///
/// Output is rounded and clamped to `0...255`; input is not validated, since
/// the film model legitimately supplies lightness outside `0...1`.
public func hslToRGB(_ h: Double, _ s: Double, _ l: Double) -> (r: Double, g: Double, b: Double) {
    let c = (1 - abs(2 * l - 1)) * s
    let x = c * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1))
    let m = l - c / 2

    let (rp, gp, bp): (Double, Double, Double)
    switch h {
    case ..<60: (rp, gp, bp) = (c, x, 0)
    case ..<120: (rp, gp, bp) = (x, c, 0)
    case ..<180: (rp, gp, bp) = (0, c, x)
    case ..<240: (rp, gp, bp) = (0, x, c)
    case ..<300: (rp, gp, bp) = (x, 0, c)
    default: (rp, gp, bp) = (c, 0, x)
    }

    return (
        JSMath.clampByte((rp + m) * 255),
        JSMath.clampByte((gp + m) * 255),
        JSMath.clampByte((bp + m) * 255)
    )
}

/// Whether a colour plausibly belongs to skin.
///
/// A coarse hue-band test, deliberately widened at the dark end so brown and
/// black skin are protected as readily as pale skin — a narrower window is a
/// common and consequential failure in film emulation.
///
/// - Note: Phase 3 should drive skin protection from Vision's face and person
///   segmentation instead. This test cannot distinguish a cheek from a wooden
///   floor, and on Apple platforms it does not have to.
public func isSkinTone(_ r: Double, _ g: Double, _ b: Double) -> Bool {
    let hsl = rgbToHSL(r, g, b)
    if hsl.saturation < 0.05 || hsl.saturation > 0.75
        || hsl.lightness < 0.05 || hsl.lightness > 0.85 {
        return false
    }
    return (hsl.hue >= 0 && hsl.hue <= 50) || hsl.hue >= 335
}
