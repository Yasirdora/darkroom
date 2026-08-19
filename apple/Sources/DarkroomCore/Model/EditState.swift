import Foundation

/// Geometry applied to an image: orientation, mirroring and crop.
public struct Transform: Sendable, Equatable, Hashable, Codable {

    /// Quarter-turn rotations only. Free rotation is a resampling operation and
    /// belongs to the render layer, not to a lossless orientation flag.
    public enum Rotation: Int, Sendable, Codable, CaseIterable {
        case none = 0, quarter = 90, half = 180, threeQuarter = 270

        /// Whether this rotation swaps the image's width and height.
        public var swapsAxes: Bool { self == .quarter || self == .threeQuarter }

        public var rotatedClockwise: Rotation {
            switch self {
            case .none: .quarter
            case .quarter: .half
            case .half: .threeQuarter
            case .threeQuarter: .none
            }
        }

        public var rotatedCounterclockwise: Rotation {
            switch self {
            case .none: .threeQuarter
            case .quarter: .none
            case .half: .quarter
            case .threeQuarter: .half
            }
        }
    }

    /// A crop rectangle in normalised coordinates, `0...1` relative to the
    /// image. Normalised so a crop survives the source being reopened at a
    /// different resolution — a preview crop is a full-resolution crop.
    public struct CropRect: Sendable, Equatable, Hashable, Codable {
        public var x: Double
        public var y: Double
        public var width: Double
        public var height: Double

        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }

        /// The whole frame.
        public static let full = CropRect(x: 0, y: 0, width: 1, height: 1)

        public var isFullFrame: Bool { self == .full }
    }

    /// Aspect constraints offered by the crop tool.
    public enum AspectRatio: String, Sendable, Codable, CaseIterable, Identifiable {
        case free
        case square = "1:1"
        case fourThree = "4:3"
        case threeTwo = "3:2"
        case sixteenNine = "16:9"
        case nineSixteen = "9:16"

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .free: "Free"
            case .square: "1∶1"
            case .fourThree: "4∶3"
            case .threeTwo: "3∶2"
            case .sixteenNine: "16∶9"
            case .nineSixteen: "9∶16"
            }
        }

        /// Width divided by height, or `nil` when unconstrained.
        public var ratio: Double? {
            switch self {
            case .free: nil
            case .square: 1
            case .fourThree: 4.0 / 3.0
            case .threeTwo: 3.0 / 2.0
            case .sixteenNine: 16.0 / 9.0
            case .nineSixteen: 9.0 / 16.0
            }
        }
    }

    public var rotation: Rotation = .none
    public var isFlippedHorizontally = false
    public var isFlippedVertically = false

    /// The pending crop, or `nil` when the whole frame is used.
    public var crop: CropRect?
    public var aspectRatio: AspectRatio = .free

    public init() {}

    public static let identity = Transform()

    /// Whether this transform would change the image.
    public var isIdentity: Bool {
        rotation == .none
            && !isFlippedHorizontally
            && !isFlippedVertically
            && (crop == nil || crop?.isFullFrame == true)
    }
}

/// How a look is applied on top of the tonal grade.
public enum Look: Sendable, Equatable, Hashable, Codable {

    /// No look.
    case none

    /// One of the built-in film stocks, by ``FilmStock/id``.
    case filmStock(id: String)

    /// A LUT the user imported from a `.cube` file.
    ///
    /// The cube travels inside the state rather than as a file reference, so a
    /// document stays self-contained: reopening a grade next year does not
    /// depend on a `.cube` still sitting where it was.
    case importedLUT(title: String, cube: ColorCube)

    public var isNone: Bool { self == .none }

    /// A name for the look, for the UI and for `.cube` export titles.
    public var title: String {
        switch self {
        case .none: "None"
        case let .filmStock(id): FilmStock.stock(id: id)?.name ?? id
        case let .importedLUT(title, _): title
        }
    }
}

// ColorCube is Codable only in the service of Look — a cube is 786 KB of bytes
// and there is no reason to spend that on the wire unless it is a user's own
// imported LUT, which cannot be reconstructed from an identifier.
extension ColorCube: Codable {
    private enum CodingKeys: String, CodingKey { case size, entries }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let size = try container.decode(Int.self, forKey: .size)
        let entries = try container.decode(Data.self, forKey: .entries)
        guard let cube = ColorCube(size: size, entries: [UInt8](entries)) else {
            throw DecodingError.dataCorruptedError(
                forKey: .entries,
                in: container,
                debugDescription: "A \(size)³ cube needs \(size * size * size * 3) bytes, found \(entries.count)."
            )
        }
        self = cube
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(size, forKey: .size)
        // As Data, so JSON gets base64 rather than 262,144 comma-separated
        // integers.
        try container.encode(Data(entries), forKey: .entries)
    }
}

/// Everything that defines a grade.
///
/// A value type, deliberately. Undo becomes a stack of snapshots, autosave
/// becomes `Codable`, and comparing two grades is `==` — none of which needs
/// bespoke machinery. It also means the render layer can be handed a state and
/// trusted not to mutate it, which is what allows preview and export to run
/// concurrently against the same grade.
///
/// Note what is *absent*: no image, no pixels, no file reference. A grade is a
/// recipe, which is why it can be shared as a URL and exported as a `.cube`.
public struct EditState: Sendable, Equatable, Hashable, Codable {

    public var adjustments = Adjustments()
    public var curves = ChannelCurves()
    public var transform = Transform()

    /// How the source file's values are interpreted.
    public var inputProfile: InputProfile = .standard

    /// Exposure compensation in stops, applied in scene-linear.
    ///
    /// Separate from `adjustments.exposure` on purpose: this corrects the
    /// *input*, matching a shooting EI that differs from the profile's
    /// reference, and belongs before the grade rather than inside it.
    public var inputExposureStops: Double = 0

    /// Bypasses the profile's filmic shoulder and works in scene-linear.
    public var isLinearWorkflow = false

    public var look: Look = .none

    /// Look strength as a percentage, `0...100`.
    public var lookIntensity: Double = 100

    public init() {}

    /// An untouched grade.
    public static let neutral = EditState()

    /// Whether this grade would change the image at all.
    public var isNeutral: Bool { self == .neutral }

    /// The film stock currently selected, if the look is a built-in one.
    public var filmStock: FilmStock? {
        guard case let .filmStock(id) = look else { return nil }
        return FilmStock.stock(id: id)
    }
}
