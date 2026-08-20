public import SwiftUI
import DarkroomCore

/// One adjustment control.
///
/// Three things separate this from a plain `Slider`, and each of them is the
/// difference between a control that can be used quickly and one that cannot.
///
/// The track fills **outward from the centre** for anything that can go
/// negative, so the direction and size of a change read at a glance rather than
/// having to be inferred from a number.
///
/// The value appears only when it is not neutral, so a panel of untouched
/// controls stays quiet and the ones that have been moved stand out.
///
/// **Double-clicking returns it to neutral**, which is what everyone tries
/// first and is otherwise a fiddly drag.
public struct AdjustmentSlider: View {

    public let key: Adjustments.Key
    @Binding public var value: Double

    /// Called when a drag ends, so the gesture records one undo step rather
    /// than one per frame.
    public var onCommit: () -> Void

    @State private var isDragging = false

    public init(
        key: Adjustments.Key,
        value: Binding<Double>,
        onCommit: @escaping () -> Void = {}
    ) {
        self.key = key
        self._value = value
        self.onCommit = onCommit
    }

    private var isNeutral: Bool { value == key.neutralValue }

    public var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(key.title)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(isNeutral ? .secondary : .primary)

                Spacer(minLength: 4)

                // Only shown when it says something. A column of zeroes is
                // noise that makes the two controls actually in use harder to
                // find.
                if !isNeutral {
                    Text(formatted)
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.primary)
                }
            }

            track
        }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) {
            value = key.neutralValue
            onCommit()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(key.title)
        .accessibilityValue(key.accessibilityValue(value))
        .accessibilityAdjustableAction { direction in
            let step = key.step
            switch direction {
            case .increment: value = min(key.range.upperBound, value + step)
            case .decrement: value = max(key.range.lowerBound, value - step)
            @unknown default: break
            }
            onCommit()
        }
    }

    private var track: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let fraction = (value - key.range.lowerBound)
                / (key.range.upperBound - key.range.lowerBound)
            let thumbX = width * fraction

            ZStack(alignment: .leading) {
                // For a control whose axis *is* a colour — temperature, tint,
                // hue — the gradient runs the full width of the track. Putting
                // it on the fill instead crushes it into a stub beside the
                // thumb at small values, where it reads as a smudge rather than
                // as blue-to-amber. The axis is the information; the fill is
                // only the amount.
                if let axis = axisGradient {
                    // Dimmed on purpose. A saturated gradient sitting beside
                    // the photograph is exactly the chromatic contamination the
                    // neutral surround exists to avoid — colour is judged
                    // relative to everything in view, not just the frame. At
                    // this weight the axis still reads instantly and stops
                    // competing with the image for the eye.
                    Capsule()
                        .fill(axis)
                        .frame(height: 3)
                        .opacity(0.6)
                } else {
                    Capsule()
                        .fill(Color.primary.opacity(0.10))
                        .frame(height: 3)

                    // Fills outward from the centre for bipolar controls, from
                    // the left for the rest. Exposure at −40 and exposure at
                    // +40 should not look alike, and with a left-anchored fill
                    // they nearly do.
                    if key.isBipolar {
                        let centre = width / 2
                        Capsule()
                            .fill(Color.accentColor)
                            .frame(width: abs(thumbX - centre), height: 3)
                            .offset(x: min(thumbX, centre))
                    } else {
                        Capsule()
                            .fill(Color.accentColor)
                            .frame(width: thumbX, height: 3)
                    }
                }

                Circle()
                    .fill(.white)
                    .frame(width: isDragging ? 13 : 11)
                    .shadow(color: .black.opacity(0.45), radius: 1.5, y: 0.5)
                    .offset(x: thumbX - (isDragging ? 6.5 : 5.5))
                    .animation(.easeOut(duration: 0.12), value: isDragging)
            }
            .frame(height: 14)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { gesture in
                        isDragging = true
                        let position = (gesture.location.x / width)
                            .clamped(to: 0...1)
                        let raw = key.range.lowerBound
                            + position * (key.range.upperBound - key.range.lowerBound)
                        value = (raw / key.step).rounded() * key.step
                    }
                    .onEnded { _ in
                        isDragging = false
                        onCommit()
                    }
            )
        }
        .frame(height: 14)
    }

    /// The gradient for a control whose axis is itself a colour.
    ///
    /// A temperature track running blue to amber says what the control does
    /// without a label, and is faster to reach for than a row of identical grey
    /// tracks. Returns `nil` for controls whose axis is an amount rather than a
    /// colour, which get a neutral track and an accent fill instead.
    private var axisGradient: AnyShapeStyle? {
        switch key.appearance {
        case .temperature:
            AnyShapeStyle(LinearGradient(
                colors: [Color(red: 0.35, green: 0.6, blue: 1), Color(red: 1, green: 0.72, blue: 0.35)],
                startPoint: .leading, endPoint: .trailing
            ))
        case .tint:
            AnyShapeStyle(LinearGradient(
                colors: [Color(red: 0.4, green: 0.85, blue: 0.45), Color(red: 0.9, green: 0.45, blue: 0.85)],
                startPoint: .leading, endPoint: .trailing
            ))
        case .hue:
            AnyShapeStyle(LinearGradient(
                colors: [.red, .yellow, .green, .cyan, .blue, .purple, .red],
                startPoint: .leading, endPoint: .trailing
            ))
        case .sepia:
            AnyShapeStyle(LinearGradient(
                colors: [Color(white: 0.5), Color(red: 0.62, green: 0.48, blue: 0.32)],
                startPoint: .leading, endPoint: .trailing
            ))
        case .sharpen:
            AnyShapeStyle(LinearGradient(
                colors: [Color(red: 0.45, green: 0.55, blue: 0.7), Color(red: 0.95, green: 0.95, blue: 1)],
                startPoint: .leading, endPoint: .trailing
            ))
        case .plain:
            nil
        }
    }

    /// The value, in the units the control means.
    private var formatted: String {
        if key == .exposure {
            // Stops, not slider units. A photographer thinks in stops, and the
            // internal ±100 is an implementation detail they should never meet.
            let stops = value / 50
            return String(format: "%+.2f EV", stops)
        }
        return key.isBipolar ? String(format: "%+.0f", value) : String(format: "%.0f", value)
    }
}

extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double {
        Swift.min(range.upperBound, Swift.max(range.lowerBound, self))
    }
}

extension CGFloat {
    func clamped(to range: ClosedRange<Double>) -> Double {
        Double(self).clamped(to: range)
    }
}
