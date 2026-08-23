public import SwiftUI

/// Where the floating chrome sits, in one place.
///
/// Read by the window when it insets the canvas, and by the occlusion check
/// when it asserts that no part of the photograph ends up underneath. Two
/// copies of these numbers would eventually disagree, and the check would then
/// be confirming the wrong rectangle — which is worse than having no check.
public enum CanvasChrome {

    /// Height reserved at the top of the window.
    ///
    /// The window buttons and the document controls share this line, the way a
    /// title bar's contents used to. Tall enough for a control, not for a bar.
    public static let topInset: Double = 46

    /// Space kept clear on the leading edge for the window buttons themselves.
    public static let windowButtonWidth: Double = 78

    /// Inset from the window's edges for anything floating on the canvas.
    public static let margin: Double = 12
}

/// A group of controls floating over the canvas.
///
/// One style for all of them, so the zoom readout at the bottom and the
/// document actions at the top read as the same kind of object. They are the
/// only chrome that sits over the photograph, so they stay small, quiet, and
/// the same neutral as the surround they float on.
public struct CanvasControlCluster<Content: View>: View {

    private let content: () -> Content

    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    public var body: some View {
        HStack(spacing: 0, content: content)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(.white.opacity(0.08)))
    }
}

/// One button inside a cluster.
///
/// The frame and the content shape are both required and neither is decorative.
/// `.buttonStyle(.plain)` makes the hit region the *drawn glyph* — for an SF
/// Symbol that is a stroke a couple of points across — so a button laid out at
/// 30×26 would otherwise accept clicks in a small fraction of the area it
/// appears to occupy. This has been reported twice.
public struct CanvasControlButton: View {

    private let symbol: String
    private let label: String
    private let help: String
    private let isEnabled: Bool
    private let action: () -> Void

    public init(
        symbol: String,
        label: String,
        help: String,
        isEnabled: Bool = true,
        action: @escaping () -> Void
    ) {
        self.symbol = symbol
        self.label = label
        self.help = help
        self.isEnabled = isEnabled
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .frame(width: 32, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isEnabled ? .secondary : .tertiary)
        .disabled(!isEnabled)
        .help(help)
        .accessibilityLabel(label)
    }
}
