import Foundation

/// How Darkroom interprets the pixel values in an opened file.
///
/// An input profile is the composition of three decisions — which transfer
/// function decodes the code values, which gamut the resulting linear light
/// sits in, and how that scene-linear image is rendered back to a display.
/// Naming them together is what lets the UI offer "Sony S-Log3" as a single
/// choice while the pipeline still does a full colour space transform.
///
/// The pipeline is the same one a colourist would run in Resolve:
///
/// ```
/// encoded → scene-linear (transfer function)
///         → sRGB linear  (gamut matrix)
///         → display      (render transform)
/// ```
public enum InputProfile: String, Sendable, Codable, CaseIterable, Identifiable {

    case standard
    case rec709
    case displayP3
    case arriLogC3
    case redLog3G10
    case sonySLog3
    case blackmagicFilmGen4
    case blackmagicFilmGen5
    case daVinciIntermediate
    case canonLog3
    case panasonicVLog
    case flat

    public var id: String { rawValue }

    // MARK: - Composition

    /// The transfer function that decodes this profile's code values.
    public var transferFunction: TransferFunction {
        switch self {
        case .standard, .displayP3: .sRGB
        case .rec709: .bt1886
        case .arriLogC3: .arriLogC3
        case .redLog3G10: .redLog3G10
        case .sonySLog3: .sonySLog3
        case .blackmagicFilmGen4: .blackmagicFilmGen4
        case .blackmagicFilmGen5: .blackmagicFilmGen5
        case .daVinciIntermediate: .daVinciIntermediate
        case .canonLog3: .canonLog3
        case .panasonicVLog: .panasonicVLog
        case .flat: .flat
        }
    }

    /// The gamut the decoded linear values sit in.
    public var gamut: ColorGamut {
        switch self {
        case .standard, .rec709, .flat: .sRGB
        case .displayP3: .displayP3
        case .arriLogC3: .arriWideGamut3
        case .redLog3G10: .redWideGamutRGB
        case .sonySLog3: .sonySGamut3Cine
        case .blackmagicFilmGen4, .blackmagicFilmGen5: .blackmagicWideGamut
        case .daVinciIntermediate: .daVinciWideGamut
        case .canonLog3: .canonCinemaGamut
        case .panasonicVLog: .panasonicVGamut
        }
    }

    /// How scene-linear light is rendered back to a display for this profile.
    public var renderTransform: DisplayRenderTransform {
        switch self {
        case .standard, .rec709, .displayP3:
            .direct
        case .flat:
            .filmic(exposureStops: 0.2, shoulder: 0.09)
        case .arriLogC3:
            .filmic(exposureStops: 0, shoulder: 0.12)
        case .redLog3G10:
            .filmic(exposureStops: 0, shoulder: 0.115)
        case .sonySLog3:
            .filmic(exposureStops: 0, shoulder: 0.11)
        case .blackmagicFilmGen4:
            .filmic(exposureStops: 0, shoulder: 0.13)
        case .blackmagicFilmGen5:
            .filmic(exposureStops: 0, shoulder: 0.12)
        case .daVinciIntermediate:
            .filmic(exposureStops: 0, shoulder: 0.105)
        case .canonLog3:
            .filmic(exposureStops: 0, shoulder: 0.12)
        case .panasonicVLog:
            .filmic(exposureStops: 0, shoulder: 0.115)
        }
    }

    // MARK: - Presentation

    /// Groupings used to organise the profile picker.
    public enum Group: String, Sendable, Codable, CaseIterable, Identifiable {
        case standard, wideGamut, cinemaLog, flatStill

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .standard: "Standard"
            case .wideGamut: "Wide Gamut"
            case .cinemaLog: "Cinema Log"
            case .flatStill: "Flat Still"
            }
        }
    }

    public var group: Group {
        switch self {
        case .standard, .rec709: .standard
        case .displayP3: .wideGamut
        case .flat: .flatStill
        default: .cinemaLog
        }
    }

    /// Short name shown in the picker.
    public var title: String {
        switch self {
        case .standard: "sRGB"
        case .rec709: "Rec.709 / BT.1886"
        case .displayP3: "Display P3"
        case .arriLogC3: "ARRI LogC3"
        case .redLog3G10: "RED Log3G10"
        case .sonySLog3: "Sony S-Log3"
        case .blackmagicFilmGen4: "Blackmagic Film Gen 4"
        case .blackmagicFilmGen5: "Blackmagic Film Gen 5"
        case .daVinciIntermediate: "DaVinci Intermediate"
        case .canonLog3: "Canon C-Log3"
        case .panasonicVLog: "Panasonic V-Log"
        case .flat: "Flat Profile"
        }
    }

    /// The cameras or workflows this profile is for, written for someone
    /// choosing from the menu rather than reading a specification.
    public var summary: String {
        switch self {
        case .standard: "Photos and social exports"
        case .rec709: "Video stills and broadcast exports"
        case .displayP3: "iPhone and Mac wide-gamut captures"
        case .arriLogC3: "Alexa and AMIRA, EI 800"
        case .redLog3G10: "RED Komodo and V-Raptor"
        case .sonySLog3: "Sony FX-series and Venice"
        case .blackmagicFilmGen4: "Pocket 4K and original Pocket 6K"
        case .blackmagicFilmGen5: "URSA 12K, Pocket 6K G2, PYXIS"
        case .daVinciIntermediate: "Resolve intermediate renders"
        case .canonLog3: "Canon C-series cinema cameras"
        case .panasonicVLog: "Varicam, GH and S-series"
        case .flat: "Flat picture styles and log-ish JPEGs"
        }
    }

    /// The exposure index this profile is normally shot at, where that is a
    /// meaningful thing to state.
    public var typicalExposureIndex: String? {
        switch self {
        case .arriLogC3, .redLog3G10, .sonySLog3, .canonLog3: "EI 800"
        case .blackmagicFilmGen4, .blackmagicFilmGen5: "ISO 800 / 3200"
        case .panasonicVLog: "ISO 800"
        case .daVinciIntermediate: "Resolve intermediate"
        case .standard, .rec709, .displayP3, .flat: nil
        }
    }

    /// Display order in the picker, lowest first.
    public var sortPriority: Int {
        switch self {
        case .standard: 1
        case .rec709: 2
        case .displayP3: 3
        case .arriLogC3: 10
        case .redLog3G10: 11
        case .sonySLog3: 12
        case .blackmagicFilmGen4: 13
        case .blackmagicFilmGen5: 14
        case .daVinciIntermediate: 15
        case .canonLog3: 16
        case .panasonicVLog: 17
        case .flat: 30
        }
    }

    /// Every profile in picker order.
    public static var ordered: [InputProfile] {
        allCases.sorted { $0.sortPriority < $1.sortPriority }
    }

    // MARK: - Decoding

    /// Decodes an 8-bit code value to scene-linear reflectance.
    ///
    /// - Parameter code: A channel value in `0...255`, as stored in an
    ///   8-bit-per-channel image.
    public func sceneLinear(fromCode code: Double) -> Double {
        transferFunction.sceneLinear(from: code / 255.0)
    }

    /// Scene-linear luminance of an 8-bit pixel under this profile.
    ///
    /// Rec.709 luma weights only describe sRGB-family primaries. For a
    /// wide-gamut or log source the channels are still in the camera's native
    /// gamut at this point, so weighting them by 709 coefficients would be
    /// measuring the wrong thing — an equal-weight average is the honest
    /// approximation until the gamut conversion has run.
    public func sceneLinearLuminance(r: Double, g: Double, b: Double) -> Double {
        let lr = sceneLinear(fromCode: r)
        let lg = sceneLinear(fromCode: g)
        let lb = sceneLinear(fromCode: b)

        switch self {
        case .standard, .rec709, .displayP3:
            return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
        default:
            return (lr + lg + lb) / 3.0
        }
    }

    // MARK: - Full transform

    /// Normalises one 8-bit pixel into grading-ready sRGB.
    ///
    /// - Parameters:
    ///   - exposureStops: Exposure compensation applied in scene-linear, the
    ///     standard place to correct for a shooting EI that differs from the
    ///     profile's reference.
    ///   - linearMode: Bypasses the profile's filmic shoulder and encodes
    ///     scene-linear directly, for when a downstream tool owns the look.
    /// - Returns: Channel values in `0...255`, rounded.
    public func normalizedPixel(
        r: Double, g: Double, b: Double,
        exposureStops: Double = 0,
        linearMode: Bool = false
    ) -> (r: Double, g: Double, b: Double) {
        var lr = sceneLinear(fromCode: r)
        var lg = sceneLinear(fromCode: g)
        var lb = sceneLinear(fromCode: b)

        if exposureStops != 0 {
            let gain = pow(2.0, exposureStops)
            lr *= gain
            lg *= gain
            lb *= gain
        }

        let converted = gamut.convertedToSRGBLinear(lr, lg, lb)

        let transform = linearMode ? .direct : renderTransform
        return (
            r: (transform.encoded(fromSceneLinear: converted.r) * 255).rounded().clamped(to: 0...255),
            g: (transform.encoded(fromSceneLinear: converted.g) * 255).rounded().clamped(to: 0...255),
            b: (transform.encoded(fromSceneLinear: converted.b) * 255).rounded().clamped(to: 0...255)
        )
    }
}

/// How scene-linear light is rendered to a display-referred image.
public enum DisplayRenderTransform: Sendable, Equatable, Hashable {

    /// Straight sRGB encode. Correct for sources that were already
    /// display-referred before decoding.
    case direct

    /// A gentle highlight roll-off before the sRGB encode, comparable to a
    /// log-to-Rec.709 conversion. Keeps a camera's full range presentable
    /// without imposing a look — creative decisions belong to the grade.
    case filmic(exposureStops: Double, shoulder: Double)

    /// Encodes scene-linear light to a display value in `0...1`.
    public func encoded(fromSceneLinear linear: Double) -> Double {
        switch self {
        case .direct:
            return DisplayEncoding.sRGB.encoded(from: max(0, linear)).clamped(to: 0...1)

        case let .filmic(exposureStops, shoulder):
            var x = max(0, linear) * pow(2.0, exposureStops)
            if shoulder > 0 {
                x = x / (1 + x * shoulder)
            }
            return DisplayEncoding.sRGB.encoded(from: x).clamped(to: 0...1)
        }
    }
}

extension Double {
    /// Constrains the value to a closed range.
    @inlinable
    func clamped(to range: ClosedRange<Double>) -> Double {
        Swift.min(range.upperBound, Swift.max(range.lowerBound, self))
    }
}
