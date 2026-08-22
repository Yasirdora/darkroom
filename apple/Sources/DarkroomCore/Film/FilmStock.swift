import Foundation

/// How a lab scanner colours a negative.
///
/// Two labs scanning the same frame produce visibly different files, and the
/// difference is characteristic enough that photographers choose a lab for it.
/// Modelling the scanner separately from the emulsion is what lets one stock
/// read as a Frontier scan rather than a Noritsu one.
public enum ScannerProfile: String, Sendable, Codable, CaseIterable {
    /// Fuji Frontier. Cool shadows, clean highlights.
    case frontier
    /// Noritsu. Warm across the range, lifted shadows.
    case noritsu
    /// No scanner character.
    case neutral
    /// Kodak ECN-2 motion picture negative process.
    case ecn2
    /// Kodak ECP motion picture print process.
    case ecp
}

/// One channel's Hurter–Driffield characteristic curve.
///
/// The shape that distinguishes film from a digital tone curve: a lifted toe
/// that never reaches true black, a straight-line midsection whose slope is the
/// contrast, and a shoulder that compresses highlights instead of clipping them.
public struct ChannelCurve: Sendable, Equatable, Hashable, Codable {

    /// Length of the shadow toe, `0...0.25`.
    public var toe: Double
    /// How far the toe lifts off black, `0...0.12`. Why film shadows are never
    /// truly black.
    public var toeLift: Double
    /// Midtone gamma. Higher is flatter.
    public var gamma: Double
    /// Where the highlight shoulder begins, `0.65...0.92`.
    public var shoulder: Double
    /// How hard the shoulder compresses, `0...1`.
    public var shoulderStrength: Double
    /// Per-channel gain, applied before the curve.
    public var gain: Double

    /// Creates a curve, defaulting every parameter but gamma.
    ///
    /// Mirrors the `curve()` helper the stock profiles are written against, so
    /// a profile that specifies only a gamma gets exactly the same shape here.
    public init(
        gamma: Double,
        toe: Double = 0.08,
        toeLift: Double = 0.03,
        shoulder: Double = 0.82,
        shoulderStrength: Double = 0.35,
        gain: Double = 1
    ) {
        self.gamma = gamma
        self.toe = toe
        self.toeLift = toeLift
        self.shoulder = shoulder
        self.shoulderStrength = shoulderStrength
        self.gain = gain
    }
}

/// Grain characteristics of a stock.
///
/// Spatial, so it is not baked into the colour cube — the render layer applies
/// it as a separate pass.
public struct FilmGrainSpec: Sendable, Equatable, Hashable, Codable {
    /// Strength, in 8-bit code values.
    public var amount: Double
    /// How much warmer the red grain is than the blue, `0...1`.
    public var warmth: Double
    /// Relative grain size, `0...1`.
    public var size: Double

    public init(amount: Double, warmth: Double, size: Double) {
        self.amount = amount
        self.warmth = warmth
        self.size = size
    }
}

/// The category a look is filed under in the picker.
public enum FilmCategory: String, Sendable, Codable, CaseIterable, Identifiable {
    case classic, social, portrait, kodak, fuji, cinema, instant, blackAndWhite

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .portrait: "Portrait"
        case .kodak: "Kodak Film"
        case .fuji: "Fuji Film"
        case .cinema: "Cinema & Colorist"
        case .instant: "Instant Film"
        case .social: "Social"
        case .classic: "Classic"
        case .blackAndWhite: "Black & White"
        }
    }

    /// Display order in the picker.
    public static let ordered: [FilmCategory] = [
        .portrait, .kodak, .fuji, .cinema, .instant, .social, .classic, .blackAndWhite,
    ]
}

/// A complete emulsion and scanning model for one film stock.
///
/// Everything here is colour-only and therefore bakeable into a ``ColorCube``.
/// ``grain`` is the exception: it is spatial, carried alongside as metadata for
/// the render layer rather than folded into the cube.
/// The print stage: exposing the developed negative through a positive stock.
///
/// This is where a film look gets its contrast, and leaving it out is why a
/// faithful negative simulation reads as flat. A colour negative scanned neutral
/// is *supposed* to look washed — that is what the orange-masked original is, a
/// low-contrast recording with the shape still to come. Printing it through a
/// positive stock is the step that puts the shape in, and it is the step
/// everyone means when they say "the Portra look".
///
/// Measured before this existed: 48 of 52 colour looks had a neutral-axis slope
/// between 0.95 and 1.10, so Velvia and Portra were separated by less than one
/// notch of the contrast slider.
public struct PrintProfile: Sendable, Equatable, Hashable, Codable {

    /// Steepness of the print's characteristic curve. Zero bypasses the stage.
    ///
    /// A logistic rather than a gamma, because a print rolls off at *both* ends
    /// — paper has a maximum density and a base white, and neither is reached
    /// abruptly. A gamma only shapes one end and clips the other.
    public var contrast: Double

    /// The tone the curve pivots about. Below it goes down, above it goes up.
    public var pivot: Double

    public init(contrast: Double, pivot: Double) {
        self.contrast = contrast
        self.pivot = pivot
    }

    /// No print at all — the negative shown unprinted.
    public static let none = PrintProfile(contrast: 0, pivot: 0.5)
}

public struct FilmStock: Sendable, Equatable, Hashable, Codable, Identifiable {

    public var id: String
    public var name: String
    public var category: FilmCategory

    /// One line describing the stock's character, written for someone choosing
    /// a look rather than reading a datasheet.
    public var summary: String

    /// Per-channel characteristic curves. Differing gammas between channels are
    /// what produce a stock's colour crossover in shadows and highlights.
    public var redCurve: ChannelCurve
    public var greenCurve: ChannelCurve
    public var blueCurve: ChannelCurve

    /// Dye cross-talk. Near-identity, with small off-diagonal terms standing in
    /// for one dye layer's unwanted absorption of another's light.
    public var dyeMatrix: ColorMatrix3x3

    public var scanner: ScannerProfile

    /// Split-toning applied in density space: a hue and strength for the
    /// shadows and another for the highlights. The lab term is *timing*.
    public var shadowHue: Double
    public var shadowTint: Double
    public var highlightHue: Double
    public var highlightTint: Double

    /// How far a pixel's own exposure shifts its curve. Film's forgiveness of
    /// over- and under-exposure, and the main thing separating a negative stock
    /// from a slide.
    public var latitude: Double

    public var saturation: Double
    public var vibrance: Double

    /// Highlight bleed around bright edges, from light scattering off the film
    /// base and reflecting back into the emulsion.
    /// Print stage. See ``PrintProfile``.
    public var print: PrintProfile

    public var halation: Double
    /// How warm that bleed is, `0...1`.
    public var halationWarmth: Double

    public var grain: FilmGrainSpec?

    /// Holds hue and saturation shifts back on skin, so a strong look does not
    /// turn faces orange.
    public var preservesSkinTones: Bool

    /// Marks the lighter presets derived from the `stylized()` shorthand.
    ///
    /// - Note: Inert. The TypeScript model declares and sets this flag but
    ///   never reads it, so it changes no pixel. Carried so the data model
    ///   round-trips, and recorded in `Docs/PortingNotes.md`.
    public var isStylized: Bool

    public init(
        id: String,
        name: String,
        category: FilmCategory,
        summary: String,
        redCurve: ChannelCurve,
        greenCurve: ChannelCurve,
        blueCurve: ChannelCurve,
        dyeMatrix: ColorMatrix3x3,
        scanner: ScannerProfile,
        shadowHue: Double,
        shadowTint: Double,
        highlightHue: Double,
        highlightTint: Double,
        latitude: Double,
        saturation: Double,
        vibrance: Double,
        halation: Double,
        halationWarmth: Double,
        print: PrintProfile = .none,
        grain: FilmGrainSpec? = nil,
        preservesSkinTones: Bool = false,
        isStylized: Bool = false
    ) {
        self.id = id
        self.name = name
        self.category = category
        self.summary = summary
        self.redCurve = redCurve
        self.greenCurve = greenCurve
        self.blueCurve = blueCurve
        self.dyeMatrix = dyeMatrix
        self.scanner = scanner
        self.shadowHue = shadowHue
        self.shadowTint = shadowTint
        self.highlightHue = highlightHue
        self.highlightTint = highlightTint
        self.latitude = latitude
        self.saturation = saturation
        self.vibrance = vibrance
        self.halation = halation
        self.halationWarmth = halationWarmth
        self.print = print
        self.grain = grain
        self.preservesSkinTones = preservesSkinTones
        self.isStylized = isStylized
    }
}
