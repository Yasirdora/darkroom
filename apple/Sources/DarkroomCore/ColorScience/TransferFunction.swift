import Foundation

/// The electro-optical transfer characteristics Darkroom can decode.
///
/// Every case converts an encoded value in `[0, 1]` to **scene-linear
/// reflectance**, where 18% grey is `0.18`. That shared destination is what
/// lets a Sony S-Log3 still and an sRGB JPEG be graded by the same controls.
///
/// The constants come from the manufacturers' published specifications rather
/// than from curve fitting, so each decoder can be verified against a stated
/// grey point — see ``sceneLinearGreyEncoding``.
public enum TransferFunction: String, Sendable, Codable, CaseIterable {

    /// IEC 61966-2-1. Ordinary photographs and screenshots.
    case sRGB

    /// ITU-R BT.1886 / Rec.709. Video stills and broadcast exports.
    case bt1886

    /// ARRI LogC3 at EI 800. Alexa and AMIRA.
    case arriLogC3

    /// RED Log3G10. Komodo and V-Raptor.
    case redLog3G10

    /// Sony S-Log3. FX-series and Venice.
    case sonySLog3

    /// Blackmagic Film Generation 4. Pocket 4K, original Pocket 6K.
    case blackmagicFilmGen4

    /// Blackmagic Film Generation 5. URSA Mini Pro 12K, Pocket 6K G2, PYXIS.
    case blackmagicFilmGen5

    /// DaVinci Intermediate. Resolve's own working encoding.
    case daVinciIntermediate

    /// Canon Log 3. C-series cinema cameras.
    case canonLog3

    /// Panasonic V-Log. Varicam, GH-series, S-series.
    case panasonicVLog

    /// A mild low-contrast picture profile, as produced by "flat" camera
    /// styles and Lightroom's flat export. Not a standardised encoding —
    /// an approximate inverse anchored so that 18% grey is preserved.
    case flat

    // MARK: - Decoding

    /// Converts an encoded value to scene-linear reflectance.
    ///
    /// - Parameter encoded: A code value normalised to `[0, 1]`. Values
    ///   outside that range are meaningful for log encodings, which carry
    ///   super-white and sub-black information, and are not clamped.
    /// - Returns: Scene-linear reflectance, where `0.18` is an 18% grey card.
    public func sceneLinear(from encoded: Double) -> Double {
        switch self {
        case .sRGB: Self.sRGBToLinear(encoded)
        case .bt1886: Self.bt1886ToLinear(encoded)
        case .arriLogC3: Self.arriLogC3ToLinear(encoded)
        case .redLog3G10: Self.redLog3G10ToLinear(encoded)
        case .sonySLog3: Self.sLog3ToLinear(encoded)
        case .blackmagicFilmGen4: Self.blackmagicFilmGen4ToLinear(encoded)
        case .blackmagicFilmGen5: Self.blackmagicFilmGen5ToLinear(encoded)
        case .daVinciIntermediate: Self.daVinciIntermediateToLinear(encoded)
        case .canonLog3: Self.canonLog3ToLinear(encoded)
        case .panasonicVLog: Self.panasonicVLogToLinear(encoded)
        case .flat: Self.flatToLinear(encoded)
        }
    }

    /// The code value at which this encoding places 18% scene grey, where the
    /// manufacturer publishes one.
    ///
    /// This is the single most useful invariant for validating a decoder: a
    /// curve can track plausibly across its whole range and still be wrong
    /// here, which would bias every exposure decision made downstream.
    public var sceneLinearGreyEncoding: Double? {
        switch self {
        case .arriLogC3: 0.391
        case .redLog3G10: 1.0 / 3.0
        case .sonySLog3: 420.0 / 1023.0
        case .blackmagicFilmGen5: 0.383562
        case .daVinciIntermediate: 0.336043
        // 0.330958, not the 0.327953 quoted in the TypeScript source comment.
        // Canon's C-Log3 OETF puts 18% grey at
        //   0.36726845·log₁₀(14.98325 × 0.18 + 1) + 0.12240537 = 0.3309579…
        // The TypeScript *implementation* is correct and round-trips exactly;
        // only its comment was wrong, so nothing downstream was affected. See
        // Docs/PortingNotes.md.
        case .canonLog3: 0.3309579103868913
        case .panasonicVLog: 0.423287
        case .sRGB, .bt1886, .blackmagicFilmGen4, .flat: nil
        }
    }

    /// Whether this encoding carries a camera's full scene dynamic range and
    /// therefore needs a display rendering transform rather than a direct
    /// linear-to-sRGB encode.
    public var isLogarithmic: Bool {
        switch self {
        case .arriLogC3, .redLog3G10, .sonySLog3, .blackmagicFilmGen4,
             .blackmagicFilmGen5, .daVinciIntermediate, .canonLog3, .panasonicVLog:
            true
        case .sRGB, .bt1886, .flat:
            false
        }
    }
}

// MARK: - Implementations

extension TransferFunction {

    /// IEC 61966-2-1 sRGB EOTF.
    static func sRGBToLinear(_ value: Double) -> Double {
        value <= 0.04045
            ? value / 12.92
            : pow((value + 0.055) / 1.055, 2.4)
    }

    /// ITU-R BT.1886 / Rec.709 EOTF.
    static func bt1886ToLinear(_ value: Double) -> Double {
        value < 0.081
            ? value / 4.5
            : pow((value + 0.099) / 1.099, 1.0 / 0.45)
    }

    /// ARRI LogC3 at EI 800, from ARRI's published conversion constants.
    static func arriLogC3ToLinear(_ value: Double) -> Double {
        let cut = 0.010591
        let a = 5.555556, b = 0.052272, c = 0.24719
        let d = 0.385537, e = 5.367655, f = 0.092809
        let threshold = e * cut + f

        return value > threshold
            ? (pow(10.0, (value - d) / c) - b) / a
            : (value - f) / e
    }

    /// RED Log3G10, from the REDWideGamutRGB / Log3G10 white paper.
    /// Encoding is `y = a·log10((x + c)·b + 1)`; 18% grey encodes to exactly 1/3.
    static func redLog3G10ToLinear(_ value: Double) -> Double {
        let a = 0.224282, b = 155.975327, c = 0.01, g = 15.1927
        let x = value < 0
            ? value / g
            : (pow(10.0, value / a) - 1.0) / b
        return x - c
    }

    /// Sony S-Log3, from Sony's technical summary.
    /// 18% grey encodes to 420/1023 and decodes back to exactly 0.18.
    static func sLog3ToLinear(_ value: Double) -> Double {
        value >= 171.2102946929 / 1023.0
            ? pow(10.0, (value * 1023.0 - 420.0) / 261.5) * (0.18 + 0.01) - 0.01
            : (value * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0)
    }

    /// Blackmagic Film Generation 5 (2021 colour science).
    static func blackmagicFilmGen5ToLinear(_ value: Double) -> Double {
        let logA = 0.08692876065491224
        let logB = 0.005494072432257808
        let logC = 0.5300133392291939
        let linSlope = 8.283605932402494
        let linOffset = 0.09246575342465753
        let logCut = linSlope * 0.005 + linOffset

        return value < logCut
            ? (value - linOffset) / linSlope
            : exp((value - logC) / logA) - logB
    }

    /// Blackmagic Film Generation 4. Pocket 4K and original Pocket 6K.
    static func blackmagicFilmGen4ToLinear(_ value: Double) -> Double {
        let linSlope = 4.724515510884684
        let linOffset = 0.07305940816299691
        let logB = 0.027941380463157067
        let logA = 0.15545874964938466
        let logC = 0.6272665887366995
        let logCut = 0.09650867241866573

        return value <= logCut
            ? (value - linOffset) / linSlope
            : exp((value - logC) / logA) - logB
    }

    /// DaVinci Intermediate, from Blackmagic's DaVinci Wide Gamut white paper.
    static func daVinciIntermediateToLinear(_ value: Double) -> Double {
        value > 0.02740668
            ? pow(2.0, value / 0.07329248 - 7.0) - 0.0075
            : value / 10.44426855
    }

    /// Canon Log 3, from Canon's published transfer characteristics.
    /// Three segments: a negative-exposure branch, a short linear region, and
    /// the logarithmic body.
    static func canonLog3ToLinear(_ value: Double) -> Double {
        if value < 0.097465473 {
            return -(pow(10.0, (0.12783901 - value) / 0.36726845) - 1.0) / 14.98325
        }
        if value <= 0.15277891 {
            return (value - 0.12512219) / 1.9754798
        }
        return (pow(10.0, (value - 0.12240537) / 0.36726845) - 1.0) / 14.98325
    }

    /// Panasonic V-Log, from the V-Log/V-Gamut reference manual.
    static func panasonicVLogToLinear(_ value: Double) -> Double {
        value < 0.181
            ? (value - 0.125) / 5.6
            : pow(10.0, (value - 0.598206) / 0.241514) - 0.00873
    }

    /// Approximate inverse of a mild flat picture profile.
    ///
    /// Flat styles *compress* contrast around mid-grey, so decoding must
    /// expand it. Anchored so that 18% grey and black both survive unchanged.
    static func flatToLinear(_ value: Double) -> Double {
        let x = max(0.0, sRGBToLinear(value))
        return 0.18 * pow(x / 0.18, 1.25)
    }
}

// MARK: - Display encoding

/// The opto-electronic transfer functions used on the way back out to a
/// display. Separate from ``TransferFunction`` because decoding a camera
/// original and encoding for a screen are different jobs with different
/// invertibility requirements.
public enum DisplayEncoding: String, Sendable, Codable, CaseIterable {

    /// IEC 61966-2-1 sRGB OETF.
    case sRGB

    /// ITU-R BT.1886 OETF.
    case bt1886

    /// Converts scene-linear reflectance to an encoded display value.
    ///
    /// - Parameter sceneLinear: Linear light. Negative input is treated as
    ///   black; the result is otherwise unclamped so callers can decide how to
    ///   handle values above 1.0.
    public func encoded(from sceneLinear: Double) -> Double {
        let x = max(0.0, sceneLinear)
        switch self {
        case .sRGB:
            return x <= 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055
        case .bt1886:
            return x < 0.018 ? x * 4.5 : 1.099 * pow(x, 0.45) - 0.099
        }
    }
}
