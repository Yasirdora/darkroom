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
/// The material comes from ``View/inspectorPane(cornerRadius:)``, which is
/// Liquid Glass where the system can draw it and a hand-built approximation of
/// the same idea below macOS 26.
public struct InspectorCard<Content: View, Accessory: View>: View {

    public let title: String

    /// Identity for remembering whether this pane is open. Stable across
    /// launches, so it must not be the localised title.
    public let id: String

    @Bindable public var editor: Editor

    /// Shown only when the group has been touched, and clears just this group.
    public var reset: (() -> Void)?
    public var isModified: Bool = false

    /// Panes that are only ever open — the scopes, which are a readout rather
    /// than a group of controls.
    public var isCollapsible: Bool = true

    /// A control belonging to the group as a whole rather than to any one row
    /// in it — Auto white balance, say. Sits on the title line, where Apple
    /// puts the same thing, because an action that applies to everything below
    /// it should not look like it belongs to the first row.
    @ViewBuilder public var accessory: () -> Accessory

    @ViewBuilder public var content: () -> Content

    /// A pane with a control of its own on the title line.
    public init(
        title: String,
        id: String,
        editor: Editor,
        reset: (() -> Void)? = nil,
        isModified: Bool = false,
        isCollapsible: Bool = true,
        @ViewBuilder accessory: @escaping () -> Accessory,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.id = id
        self.editor = editor
        self.reset = reset
        self.isModified = isModified
        self.isCollapsible = isCollapsible
        self.accessory = accessory
        self.content = content
    }

    @State private var isHoveringReset = false

    /// Three states, not two: unavailable, available, and under the pointer.
    /// The middle one has to be clearly live or the control reads as disabled
    /// all the time.
    private var resetTint: HierarchicalShapeStyle {
        guard isModified else { return .quaternary }
        return isHoveringReset ? .primary : .secondary
    }

    private var isExpanded: Bool { !isCollapsible || editor.isSectionExpanded(id) }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if isExpanded {
                content()
                    .padding(.horizontal, InspectorGeometry.paneInset)
                    .padding(.bottom, InspectorGeometry.paneInset)
                    // Opacity only — no `.move`.
                    //
                    // Sliding the content while the pane also shrinks is two
                    // motions at once, and it reads as the contents being
                    // yanked out rather than covered up. A real disclosure
                    // behaves like a blind: what is inside stays where it is and
                    // is progressively hidden by the edge coming down over it.
                    // The clip below does that; all the content has to do is
                    // stop being visible before the edge reaches it.
                    //
                    // The two directions are timed differently on purpose.
                    // Collapsing, the content goes quickly and the pane closes
                    // over an already-empty space — fading in step with the
                    // height would smear the last frames. Expanding, the space
                    // opens first and the content arrives into the room made
                    // for it, which is why the insertion waits.
                    .transition(.asymmetric(
                        insertion: .opacity.animation(.easeOut(duration: 0.18).delay(0.08)),
                        removal: .opacity.animation(.easeIn(duration: 0.10))
                    ))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // `inspectorPane()` clips as well as fills. Deliberately one call: the
        // clip is what stops a collapsing pane drawing its contents over its
        // neighbours, and it was lost once already by living separately.
        .inspectorPane()
    }

    private var header: some View {
        HStack(spacing: 6) {
            if isCollapsible {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.tertiary)
                    // Turns with the pane rather than on its own schedule. A
                    // chevron that finishes before the pane does makes the pane
                    // look slow.
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }

            Text(title)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(.primary)

            Spacer(minLength: 4)

            accessory()

            // Always occupies its place; only its weight changes.
            //
            // Appearing on the first edit meant the title row re-laid out
            // exactly as a slider was being dragged — the reset arrived, the
            // title shifted, and the panel twitched under the pointer at the
            // worst moment. A control that is sometimes there is a control that
            // moves everything else, and reserving space costs a fifth of an
            // inch that was doing nothing anyway.
            //
            // Its dimmed state also does the job the modified dot used to: a
            // pane whose reset is live has something in it, collapsed or not.
            if let reset {
                Button(action: reset) {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 10, weight: .semibold))
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(resetTint)
                .onHover { isHoveringReset = $0 }
                .disabled(!isModified)
                .help(isModified ? "Reset \(title)" : "\(title) is already at its defaults")
                .accessibilityLabel("Reset \(title)")
                .accessibilityHidden(!isModified)
            }
        }
        .padding(.horizontal, InspectorGeometry.paneInset)
        .padding(.top, 12)
        .padding(.bottom, isExpanded ? 10 : 12)
        // The whole row toggles, not just the chevron — a 9-point chevron is a
        // target you have to aim at, and the title beside it reads as part of
        // the same control.
        .contentShape(Rectangle())
        .onTapGesture {
            guard isCollapsible else { return }
            // No bounce. `.snappy` overshoots slightly, which is right for
            // something arriving and wrong for a height: an overshooting pane
            // springs past its closed size and settles back, and every pane
            // below it wobbles in sympathy. `.smooth` is the same spring
            // critically damped — it arrives and stops.
            withAnimation(.smooth(duration: 0.3)) {
                editor.setSectionExpanded(id, !isExpanded)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(title)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }
}


public extension InspectorCard where Accessory == EmptyView {

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
