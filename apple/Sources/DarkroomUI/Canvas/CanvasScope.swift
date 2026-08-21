public import SwiftUI
import DarkroomCore

/// The histogram, floating in the corner of the photograph.
///
/// A histogram is read *while* adjusting, not afterwards — it is the check on
/// whether a highlight is about to clip, and that question arises with a hand
/// already on a slider. Keeping the only copy behind a tab meant choosing
/// between seeing the measurement and seeing the control, which is not a choice
/// anyone should be asked to make about their own image.
///
/// Two decisions keep it from being a nuisance.
///
/// It **never takes a click**. Every interaction on the canvas — dragging,
/// zooming, and the crop and qualifier tools still to come — passes straight
/// through it. A panel that floats over the work and quietly swallows gestures
/// is worse than no panel, and this project has already paid for that lesson
/// more than once. Its only control is the menu item that summons it.
///
/// It stays **dim and neutral**. It sits over the photograph, and anything with
/// colour or brightness of its own next to an image being judged shifts how
/// that image reads.
struct CanvasScope: View {

    let histogram: Histogram

    /// Small enough to ignore, large enough to read a clipped highlight in.
    private static let size = CGSize(width: 168, height: 62)

    var body: some View {
        HistogramView(histogram: histogram)
            .equatable()
            .frame(width: Self.size.width, height: Self.size.height)
            .padding(6)
            .background {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color.black.opacity(0.42))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
            }
            .padding(16)
            // Transparent to every gesture, deliberately. See above.
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
