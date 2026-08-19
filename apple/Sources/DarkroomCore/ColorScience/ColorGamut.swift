import Foundation

/// The camera and display colour gamuts Darkroom can convert from.
///
/// Every case knows how to reach sRGB linear, which is the working space the
/// grading pipeline is defined in. Matrices are derived from each vendor's
/// published primaries and a D65 white point.
public enum ColorGamut: String, Sendable, Codable, CaseIterable {

    /// IEC 61966-2-1 primaries. The working space; no conversion needed.
    case sRGB

    /// Display P3 (D65). Apple's wide-gamut display and capture space.
    case displayP3

    /// ARRI Alexa Wide Gamut 3.
    /// Primaries R(0.6840, 0.3130) G(0.2210, 0.8480) B(0.0861, −0.1020).
    case arriWideGamut3

    /// RED WideGamutRGB.
    /// Primaries R(0.780308, 0.304253) G(0.121595, 1.493994) B(0.095612, −0.084589).
    case redWideGamutRGB

    /// Sony S-Gamut3.Cine.
    /// Primaries R(0.766, 0.275) G(0.225, 0.800) B(0.089, −0.087).
    case sonySGamut3Cine

    /// Panasonic V-Gamut.
    /// Primaries R(0.730, 0.280) G(0.165, 0.840) B(0.100, −0.030).
    case panasonicVGamut

    /// Canon Cinema Gamut.
    /// Primaries R(0.740, 0.270) G(0.170, 1.140) B(0.080, −0.100).
    case canonCinemaGamut

    /// DaVinci Wide Gamut.
    /// Primaries R(0.8000, 0.3130) G(0.1682, 0.9877) B(0.0790, −0.1155).
    case daVinciWideGamut

    /// Blackmagic Wide Gamut, shared by Film Gen 4 and Gen 5.
    /// Primaries R(0.7177215, 0.3171181) G(0.2280410, 0.8615690) B(0.1005841, −0.0820452).
    case blackmagicWideGamut

    /// The matrix taking this gamut's linear values into sRGB linear.
    public var matrixToSRGBLinear: ColorMatrix3x3 {
        switch self {
        case .sRGB:
            .identity

        case .displayP3:
            ColorMatrix3x3(
                 1.22494, -0.22494,   0.0,
                -0.042057, 1.042057,  0.0,
                -0.019637, -0.078636, 1.098273
            )

        case .arriWideGamut3:
            ColorMatrix3x3(
                 1.617523, -0.537287, -0.080237,
                -0.070573,  1.334613, -0.264040,
                -0.021102, -0.226954,  1.248056
            )

        case .redWideGamutRGB:
            ColorMatrix3x3(
                 1.981976, -0.900432, -0.081544,
                -0.178143,  1.500468, -0.322325,
                -0.101796, -0.535263,  1.637059
            )

        case .sonySGamut3Cine:
            ColorMatrix3x3(
                 1.626947, -0.540139, -0.086809,
                -0.178516,  1.417941, -0.239425,
                -0.044436, -0.195920,  1.240356
            )

        case .panasonicVGamut:
            ColorMatrix3x3(
                 1.806576, -0.695697, -0.110879,
                -0.170090,  1.305955, -0.135865,
                -0.025206, -0.154468,  1.179674
            )

        case .canonCinemaGamut:
            ColorMatrix3x3(
                 1.923861, -0.798761, -0.125101,
                -0.204311,  1.495899, -0.291588,
                -0.023685, -0.420127,  1.443812
            )

        case .daVinciWideGamut:
            ColorMatrix3x3(
                 1.898615, -0.792176, -0.106439,
                -0.168949,  1.488976, -0.320027,
                -0.121539, -0.315676,  1.437215
            )

        case .blackmagicWideGamut:
            ColorMatrix3x3(
                 1.568445, -0.522716, -0.045729,
                -0.086361,  1.344976, -0.258615,
                -0.052043, -0.249147,  1.301189
            )
        }
    }

    /// Whether the conversion to sRGB clamps negative components.
    ///
    /// - Note: This reproduces an inconsistency in the TypeScript engine,
    ///   where Display P3 returns unclamped results while every camera gamut
    ///   clamps. Preserved deliberately so the Swift port can be proven
    ///   equivalent before any behaviour is changed; see
    ///   `Docs/PortingNotes.md` for the disposition.
    public var clampsNegativesToSRGB: Bool {
        switch self {
        case .displayP3, .sRGB: false
        default: true
        }
    }

    /// Converts a linear triplet in this gamut to sRGB linear.
    public func convertedToSRGBLinear(
        _ r: Double, _ g: Double, _ b: Double
    ) -> (r: Double, g: Double, b: Double) {
        matrixToSRGBLinear.apply(r, g, b, clampingNegatives: clampsNegativesToSRGB)
    }
}
