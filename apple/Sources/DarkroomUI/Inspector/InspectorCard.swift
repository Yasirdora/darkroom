public import SwiftUI
import AppKit

/// A real AppKit vibrancy layer.
///
/// SwiftUI's `.regularMaterial` renders as a flat fill when the window behind
/// it is opaque, which is most of the time here — the canvas fills the window
/// and is deliberately opaque. `NSVisualEffectView` blending *behind* the
/// window is the genuine article, and it is what Finder, Mail and Photos use
/// for their sidebars.
///
/// It also settles a real objection to glass in a grading tool. A translucent
/// panel that samples the *photograph* takes on that photograph's colour, and
/// colour is judged relative to everything in view — the panel would shift as
/// you graded, which is the whole reason the canvas surround is neutral. This
/// samples what is behind the *window*, so its tint is fixed by the desktop and
/// stays put no matter what the image does.
struct VisualEffectBackground: NSViewRepresentable {

    var material: NSVisualEffectView.Material = .sidebar
    var blending: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blending
        // Active regardless of window focus. A panel that greys out when the
        // window loses focus changes the surround around the photograph, and
        // clicking away to check a reference should not alter what you are
        // comparing it against.
        view.state = .active
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
        view.blendingMode = blending
    }
}

/// One group of controls, in its own pane.
///
/// The inspector used to be a single column with flat headings, which reads as
/// one long list however carefully it is spaced. Grouping into panes lets the
/// eye find a section instead of scanning for it, and collapsing lets someone
/// grading tone put colour out of sight entirely.
///
/// The glass is built in layers, which is what separates it from a rounded grey
/// rectangle: a translucent fill for body, a hairline border, and a highlight
/// along the top edge only. That last one is doing most of the work — real
/// glass catches light on its top edge, and without it the pane reads as
/// painted on rather than sitting above the panel.
struct InspectorCard<Content: View, Accessory: View>: View {

    let title: String

    /// Identity for remembering whether this pane is open. Stable across
    /// launches, so it must not be the localised title.
    let id: String

    @Bindable var editor: Editor

    /// Shown only when the group has been touched, and clears just this group.
    var reset: (() -> Void)?
    var isModified: Bool = false

    /// Panes that are only ever open — the scopes, which are a readout rather
    /// than a group of controls.
    var isCollapsible: Bool = true

    /// A control belonging to the group as a whole rather than to any one row
    /// in it — Auto white balance, say. Sits on the title line, where Apple
    /// puts the same thing, because an action that applies to everything below
    /// it should not look like it belongs to the first row.
    @ViewBuilder var accessory: () -> Accessory

    @ViewBuilder var content: () -> Content

    @State private var isHoveringReset = false

    private var isExpanded: Bool { !isCollapsible || editor.isSectionExpanded(id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if isExpanded {
                content()
                    .padding(.horizontal, 14)
                    .padding(.bottom, 14)
                    // Fades on the way out and in, so a collapsing pane reads as
                    // its contents leaving rather than the pane snapping shut.
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.white.opacity(0.05))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
        }
        .overlay(alignment: .top) {
            // The lit top edge. Two points tall and almost invisible on its
            // own; take it away and the pane goes flat.
            LinearGradient(
                colors: [Color.white.opacity(0.10), Color.white.opacity(0)],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 2)
            .mask {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
            }
            .allowsHitTesting(false)
        }
        .shadow(color: .black.opacity(0.22), radius: 3, y: 1)
        .clipped(antialiased: true)
    }

    private var header: some View {
        HStack(spacing: 6) {
            if isCollapsible {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }

            Text(title)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(.primary)

            // A collapsed pane still has to say whether anything is set inside
            // it, or closing a group becomes a way to lose track of an edit.
            if isModified, !isExpanded {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 5, height: 5)
            }

            Spacer(minLength: 4)

            accessory()

            if isModified, let reset {
                Button(action: reset) {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 10, weight: .semibold))
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(isHoveringReset ? .primary : .tertiary)
                .onHover { isHoveringReset = $0 }
                .help("Reset \(title)")
                .accessibilityLabel("Reset \(title)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 11)
        .padding(.bottom, isExpanded ? 9 : 11)
        // The whole row toggles, not just the chevron — a 9-point chevron is a
        // target you have to aim at, and the title beside it reads as part of
        // the same control.
        .contentShape(Rectangle())
        .onTapGesture {
            guard isCollapsible else { return }
            withAnimation(.snappy(duration: 0.26, extraBounce: 0.02)) {
                editor.setSectionExpanded(id, !isExpanded)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(title)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }
}


extension InspectorCard where Accessory == EmptyView {

    /// A pane with nothing on its title line but the title.
    init(
        title: String,
        id: String,
        editor: Editor,
        reset: (() -> Void)? = nil,
        isModified: Bool = false,
        isCollapsible: Bool = true,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(
            title: title,
            id: id,
            editor: editor,
            reset: reset,
            isModified: isModified,
            isCollapsible: isCollapsible,
            accessory: { EmptyView() },
            content: content
        )
    }
}
