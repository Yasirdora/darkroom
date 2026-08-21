import Foundation

/// The tonal and colour controls of a grade.
///
/// Every value is a UI-space number, not a physical one — `exposure` is
/// `-100...100` rather than stops, and the render layer converts. Keeping the
/// stored form identical to what the sliders emit means a grade shared from the
/// web app deserialises into exactly the same look, with no unit negotiation.
public struct Adjustments: Sendable, Equatable, Hashable, Codable {

    // Light
    public var exposure: Double = 0
    public var brightness: Double = 0
    public var contrast: Double = 0
    public var highlights: Double = 0
    public var shadows: Double = 0
    public var whites: Double = 0
    public var blacks: Double = 0

    // Colour
    public var saturation: Double = 0
    public var vibrance: Double = 0
    public var hue: Double = 0
    public var temperature: Double = 0
    public var tint: Double = 0

    // Detail
    public var clarity: Double = 0
    public var sharpen: Double = 0
    public var vignette: Double = 0
    public var grain: Double = 0
    public var sepia: Double = 0

    public init() {}

    /// The neutral grade: every control at rest.
    public static let neutral = Adjustments()

    /// Whether any control has moved off its default.
    public var isNeutral: Bool { self == .neutral }

    // MARK: - Keyed access

    /// Identifies one adjustment, so the UI can build controls from data rather
    /// than repeating seventeen near-identical property bindings.
    public enum Key: String, Sendable, Codable, CaseIterable, Identifiable {
        case exposure, brightness, contrast, highlights, shadows, whites, blacks
        case saturation, vibrance, hue, temperature, tint
        case clarity, sharpen, vignette, grain, sepia

        public var id: String { rawValue }
    }

    public subscript(key: Key) -> Double {
        get {
            switch key {
            case .exposure: exposure
            case .brightness: brightness
            case .contrast: contrast
            case .highlights: highlights
            case .shadows: shadows
            case .whites: whites
            case .blacks: blacks
            case .saturation: saturation
            case .vibrance: vibrance
            case .hue: hue
            case .temperature: temperature
            case .tint: tint
            case .clarity: clarity
            case .sharpen: sharpen
            case .vignette: vignette
            case .grain: grain
            case .sepia: sepia
            }
        }
        set {
            switch key {
            case .exposure: exposure = newValue
            case .brightness: brightness = newValue
            case .contrast: contrast = newValue
            case .highlights: highlights = newValue
            case .shadows: shadows = newValue
            case .whites: whites = newValue
            case .blacks: blacks = newValue
            case .saturation: saturation = newValue
            case .vibrance: vibrance = newValue
            case .hue: hue = newValue
            case .temperature: temperature = newValue
            case .tint: tint = newValue
            case .clarity: clarity = newValue
            case .sharpen: sharpen = newValue
            case .vignette: vignette = newValue
            case .grain: grain = newValue
            case .sepia: sepia = newValue
            }
        }
    }
}

// MARK: - Control metadata

extension Adjustments.Key {

    /// How the slider is drawn.
    public enum Appearance: String, Sendable {
        /// A plain track.
        case plain
        /// Tinted to show what the control does: a hue wheel, a blue-to-amber
        /// warmth ramp, a green-to-magenta tint ramp, and so on. Showing the
        /// effect on the control is faster to read than any label.
        case hue, temperature, tint, sepia, sharpen
    }

    /// User-facing name.
    public var title: String {
        switch self {
        case .exposure: "Exposure"
        case .brightness: "Brightness"
        case .contrast: "Contrast"
        case .highlights: "Highlights"
        case .shadows: "Shadows"
        case .whites: "Whites"
        case .blacks: "Blacks"
        case .saturation: "Saturation"
        case .vibrance: "Vibrance"
        case .hue: "Hue"
        case .temperature: "Temperature"
        case .tint: "Tint"
        case .clarity: "Clarity"
        case .sharpen: "Sharpen & Blur"
        case .vignette: "Vignette"
        case .grain: "Grain"
        case .sepia: "Sepia"
        }
    }

    public var appearance: Appearance {
        switch self {
        case .hue: .hue
        case .temperature: .temperature
        case .tint: .tint
        case .sepia: .sepia
        case .sharpen: .sharpen
        default: .plain
        }
    }

    /// The control's range and increment.
    public var range: ClosedRange<Double> {
        switch self {
        case .hue: -180...180
        case .vibrance: -50...50
        case .vignette, .grain, .sepia: 0...100
        default: -100...100
        }
    }

    public var step: Double { 1 }

    /// Where the control rests, and where a double-click returns it to.
    public var neutralValue: Double { 0 }

    /// Whether the track should fill outward from the centre rather than from
    /// the left. True for every control that can go negative.
    public var isBipolar: Bool { range.lowerBound < 0 }

    /// A spoken description of the current value, for VoiceOver.
    ///
    /// Reads the units a photographer thinks in rather than the slider's
    /// internal number: "plus one third of a stop", not "plus 33".
    public func accessibilityValue(_ value: Double) -> String {
        if self == .exposure {
            let stops = value / 50
            if stops == 0 { return "Neutral" }
            let formatted = String(format: "%.2f", abs(stops))
            return "\(stops > 0 ? "Plus" : "Minus") \(formatted) stops"
        }

        if value == neutralValue { return "Neutral" }
        let sign = value > 0 ? "Plus " : "Minus "
        let magnitude = String(format: "%g", abs(value))
        return isBipolar ? "\(sign)\(magnitude)" : magnitude
    }

    /// Sections the inspector groups controls into.
    public enum Group: String, Sendable, CaseIterable, Identifiable {
        case light, whiteBalance, colour, detail

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .light: "Light"
            case .whiteBalance: "White Balance"
            case .colour: "Color"
            case .detail: "Detail"
            }
        }

        /// Controls in this group, in display order.
        public var keys: [Adjustments.Key] {
            switch self {
            case .light: [.exposure, .brightness, .contrast, .highlights, .shadows, .whites, .blacks]
            // White balance is its own group, ahead of the rest of colour.
            // It is a correction — there is a right answer, and it is the
            // first decision made, because saturation and vibrance judged over
            // an uncorrected cast have to be judged again afterwards.
            case .whiteBalance: [.temperature, .tint]
            case .colour: [.saturation, .vibrance, .hue]
            case .detail: [.clarity, .sharpen, .vignette, .grain, .sepia]
            }
        }
    }
}
