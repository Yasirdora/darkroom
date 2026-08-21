public import SwiftUI
import DarkroomCore
import DarkroomRender

/// The automatic white balance control, above Temperature and Tint.
///
/// One automatic control, and only this one, on purpose. A cast is a
/// *measurement* — there is a correct answer, the model inverts to it exactly,
/// and the result can be checked by eye in a second. Automatic contrast or
/// automatic colour would be guesses at intent dressed as measurements, and a
/// tool that guesses at intent is one you spend your time undoing.
struct AutoWhiteBalanceButton: View {

    @Bindable var editor: Editor

    /// Held by the pane rather than here, so the caveat can be shown beside the
    /// sliders while the button sits on the title line.
    @Binding var estimate: NeutralSampler.Estimate?

    var body: some View {
        Button {
            estimate = editor.autoWhiteBalance()
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "wand.and.stars.inverse")
                    .font(.system(size: 9, weight: .semibold))
                Text("Auto")
                    .font(.system(size: 10, weight: .semibold))
            }
        }
        .buttonStyle(GlassCapsuleButtonStyle(isEnabled: editor.hasImage))
        .foregroundStyle(editor.hasImage ? Color.accentColor : Color.secondary)
        .disabled(!editor.hasImage)
        .help("Neutralise the cast, measured from the image")
        .accessibilityLabel("Auto white balance")
    }
}

/// What the last automatic correction rested on.
///
/// Said plainly when the reading is weak, rather than left for someone to
/// discover by mistrusting the result. A frame with no neutral surface in it
/// has nothing to measure, and pretending otherwise is how automatic
/// corrections lose people's confidence.
struct WhiteBalanceNote: View {

    let estimate: NeutralSampler.Estimate?

    var body: some View {
        if let note {
            Text(note)
                .font(.system(size: 9.5))
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.opacity)
        }
    }

    private var note: String? {
        guard let estimate else { return nil }
        if estimate.isGreyWorld {
            return "No neutral surface found — averaged the whole frame. Check the result."
        }
        if estimate.coverage < 0.05 {
            return "Measured from \(percentage(estimate.coverage)) of the frame."
        }
        return nil
    }

    private func percentage(_ value: Double) -> String {
        value < 0.01
            ? String(format: "%.1f%%", value * 100)
            : String(format: "%.0f%%", value * 100)
    }
}
