import Foundation

/// The white balance model, and its exact inverse.
///
/// Temperature and tint are multiplicative channel gains, because a colour cast
/// *is* a gain error — a light source that emits more red puts proportionally
/// more red into every value, so correcting it has to be proportional too. Flat
/// offsets overcorrect shadows, undercorrect highlights, and can never fully
/// neutralise a cast.
///
/// Written exponentially, the two sliders stay symmetric in stops of cast:
///
///     temperature t →  r × 1.35ᵗ,          b × 1.35⁻ᵗ      (green anchored)
///     tint        v →  g × 1.25ᵛ,   r and b × 1.25⁻ᵛᐟ²     (≈ luminance neutral)
///
/// The important property is that the three gains always multiply to one. That
/// makes the model exactly two-dimensional in log space, so a measured cast
/// inverts to a temperature and a tint in closed form — no search, no
/// iteration, no approximation. Auto white balance is algebra here, not a
/// guess, and that is the difference between a button a professional will press
/// and one they will learn to avoid.
public enum WhiteBalance {

    /// How much red a full-scale temperature move adds.
    public static let temperatureBase = 1.35

    /// How much green a full-scale tint move adds.
    public static let tintBase = 1.25

    /// The channel gains a setting produces. The forward model, matching
    /// `ColorGrade` exactly.
    ///
    /// - Parameters:
    ///   - temperature: Slider units, ±100.
    ///   - tint: Slider units, ±100.
    public static func gains(
        temperature: Double,
        tint: Double
    ) -> (r: Double, g: Double, b: Double) {
        let t = temperature / 100
        let v = tint / 100
        return (
            r: pow(temperatureBase, t) * pow(tintBase, -v / 2),
            g: pow(tintBase, v),
            b: pow(temperatureBase, -t) * pow(tintBase, -v / 2)
        )
    }

    /// The temperature and tint that turn a measured colour neutral.
    ///
    /// The gains wanted are inversely proportional to the measurement, and the
    /// model's gains multiply to one, so scaling by the geometric mean lands
    /// exactly on a representable setting:
    ///
    ///     k = ∛(r·g·b),  gains = (k/r, k/g, k/b),  product = k³/rgb = 1
    ///
    /// Taking logs then separates the two axes cleanly. Green alone fixes tint;
    /// the red-to-blue ratio alone fixes temperature.
    ///
    /// - Parameter colour: What a neutral subject actually measured, in the
    ///   same 0…255 display space the gains are applied in.
    /// - Returns: Slider units, unclamped — see ``clamped(_:to:)``.
    public static func neutralising(
        _ colour: (r: Double, g: Double, b: Double)
    ) -> (temperature: Double, tint: Double) {
        // A channel that measured zero carries no ratio information, and its
        // logarithm carries none either. The floor keeps a black or clipped
        // sample from producing an infinite correction.
        let floor = 1e-4
        let r = Swift.max(colour.r, floor)
        let g = Swift.max(colour.g, floor)
        let b = Swift.max(colour.b, floor)

        let mean = pow(r * g * b, 1.0 / 3.0)
        let logR = log(mean / r)
        let logG = log(mean / g)
        let logB = log(mean / b)

        let temperature = (logR - logB) / (2 * log(temperatureBase))
        let tint = logG / log(tintBase)

        return (temperature: temperature * 100, tint: tint * 100)
    }

    /// The same, holding the result inside what the sliders can express.
    ///
    /// A cast beyond the sliders' reach is corrected as far as they go rather
    /// than refused. Half a correction is visibly better than none, and the
    /// remaining cast is then visible to be dealt with by other means.
    public static func neutralising(
        _ colour: (r: Double, g: Double, b: Double),
        limitedTo range: ClosedRange<Double>
    ) -> (temperature: Double, tint: Double) {
        let exact = neutralising(colour)
        return (
            temperature: exact.temperature.clamped(to: range),
            tint: exact.tint.clamped(to: range)
        )
    }

    /// Applies the gains for a setting to a colour.
    ///
    /// Used to check that a computed setting does what it claims.
    public static func applying(
        temperature: Double,
        tint: Double,
        to colour: (r: Double, g: Double, b: Double)
    ) -> (r: Double, g: Double, b: Double) {
        let gain = gains(temperature: temperature, tint: tint)
        return (colour.r * gain.r, colour.g * gain.g, colour.b * gain.b)
    }
}
