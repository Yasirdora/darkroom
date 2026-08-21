public import SwiftUI
import DarkroomCore

/// The tone curve, edited by hand.
///
/// The first direct-manipulation surface in the app, and it sets the pattern for
/// crop and the qualifier after it. Three decisions carry most of the feel:
///
/// **The histogram sits behind the curve.** A curve is a statement about where
/// an image's tones are, and pulling one blind is guesswork. Every serious
/// grading tool puts the distribution behind the control for this reason.
///
/// **Points are grabbed, not aimed at.** The hit radius is generously larger
/// than the dot, because a 4-point dot is a target you have to concentrate on
/// and concentration spent on aiming is concentration not spent on the picture.
///
/// **The diagonal is always visible.** It is the identity — where the curve does
/// nothing — and seeing the departure from it is how the size of an adjustment
/// is read.
public struct CurveEditor: View {

    @Bindable public var editor: Editor

    /// Which channel is being edited.
    @State private var channel: Channel = .master

    /// Bookkeeping for the gesture in progress.
    ///
    /// A reference type held in `@State`, and that is deliberate: updating a
    /// `@State` *value* during `onChanged` re-evaluates the body on every
    /// pointer move, which rebuilds the very gesture that is running. Mutating
    /// a class instance does not invalidate anything, so the gesture survives
    /// its own updates.
    @State private var session = DragSession()

    final class DragSession {
        /// The decision-making lives in `DarkroomCore`, where it can be driven
        /// through every sequence without a screen. This view only relays
        /// pointer positions to it and applies what comes back.
        var gesture = CurveGesture()
    }

    /// Index of the selected point. Changes only at the start and end of a
    /// gesture, so redrawing for it costs nothing.
    @State private var selected: Int?

    /// The plot's side length, defined once in `CurveEditing` so the geometry
    /// and the checks over it cannot drift apart.
    ///
    /// A constant rather than a `GeometryReader` measurement, and that is
    /// deliberate: every point moved mutates the editor, which invalidates the
    /// window body, re-lays out the reader and rebuilds the canvas and its
    /// gesture *while the drag is still running*. A fixed frame keeps the view
    /// identity stable, so an in-flight gesture is not torn down underneath
    /// itself.
    static var plotSize: Double { CurveEditing.plotSize }

    public init(editor: Editor) {
        self.editor = editor
    }

    public enum Channel: String, CaseIterable, Identifiable {
        case master, red, green, blue

        public var id: String { rawValue }

        var title: String {
            switch self {
            case .master: "RGB"
            case .red: "R"
            case .green: "G"
            case .blue: "B"
            }
        }

        var tint: Color {
            switch self {
            case .master: .white
            case .red: Color(red: 1, green: 0.35, blue: 0.35)
            case .green: Color(red: 0.35, green: 0.9, blue: 0.45)
            case .blue: Color(red: 0.4, green: 0.6, blue: 1)
            }
        }
    }

    // MARK: - Body

    public var body: some View {
        InspectorCard(
            title: "Tone Curve",
            id: "curves",
            editor: editor,
            reset: {
                editor.update({ setCurve(nil, in: &$0) }, label: "Reset Curve")
                selected = nil
            },
            isModified: currentCurve != nil
        ) {
            VStack(alignment: .leading, spacing: 10) {
                channelPicker
                plot
                footer
            }
        }
        .padding(.horizontal, 10)
        // Focus lives on the container, not the canvas. Attaching `.focusable()`
        // to the canvas made it compete with the drag for the first click.
        .focusable()
        .focusEffectDisabled()
        .onKeyPress(.delete) { removeSelected() }
        .onKeyPress(.deleteForward) { removeSelected() }
    }

    private var channelPicker: some View {
        HStack(spacing: 4) {
            ForEach(Channel.allCases) { option in
                Button {
                    channel = option
                    selected = nil
                } label: {
                    Text(option.title)
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 5)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(channel == option ? option.tint : .secondary)
                .background {
                    // Concentric with the pane holding it: the pane's radius
                    // less the inset between them. A constant radius here would
                    // pinch the gap at the corners, which is the commonest way
                    // a rounded interface looks subtly wrong.
                    RoundedRectangle(
                        cornerRadius: InspectorGeometry.nestedRadius,
                        style: .continuous
                    )
                    .fill(channel == option
                        ? option.tint.opacity(0.18)
                        : Color.primary.opacity(0.05))
                }
                .accessibilityLabel(channelName(option))
                .accessibilityAddTraits(channel == option ? [.isSelected] : [])
            }
        }
    }

    private func channelName(_ option: Channel) -> String {
        switch option {
        case .master: "All channels"
        case .red: "Red channel"
        case .green: "Green channel"
        case .blue: "Blue channel"
        }
    }

    private var footer: some View {
        HStack {
            // The hint changes with what is possible, rather than stating
            // everything at once. A control that explains itself only when the
            // explanation is useful stays quiet the rest of the time.
            Text(hint)
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)

            Spacer()

            // A visible way to remove a point, not only a key. Delete works, but
            // a keyboard-only affordance is one nobody discovers.
            //
            // Always in place, dimmed when there is nothing to remove. It used
            // to appear on selection, which nudged the row every time a point
            // was clicked — a footer that jumps while you work the plot above it
            // is a distraction earned for nothing.
            Button("Remove Point") { _ = removeSelected() }
                .font(.system(size: 10))
                .buttonStyle(.plain)
                .foregroundStyle(canRemove ? Color.accentColor : Color.secondary.opacity(0.45))
                .contentShape(Rectangle())
                .disabled(!canRemove)
                .accessibilityHidden(!canRemove)
        }
        // One line, whatever it says. The hint changes with what is possible,
        // and a two-line reading would otherwise lift the plot as it appeared.
        .frame(height: 15)
    }

    /// Whether the selection is a point that may be removed.
    private var canRemove: Bool {
        guard let index = selected else { return false }
        return isRemovable(index)
    }

    // MARK: - Plot

    private var plot: some View {
        let rect = CGRect(x: 0, y: 0, width: Self.plotSize, height: Self.plotSize)

        return Canvas { context, _ in
            drawBackground(context: context, in: rect)
            drawHistogram(context: context, in: rect)
            drawIdentity(context: context, in: rect)
            drawCurve(context: context, in: rect)
            drawHandles(context: context, in: rect)
            drawPoints(context: context, in: rect)
        }
        .frame(width: Self.plotSize, height: Self.plotSize)
        // The whole square is clickable, not just what has been drawn on it.
        // Without this a click only registers where a stroke happens to be.
        .contentShape(Rectangle())
        // One gesture for everything the plot does. A
        // `DragGesture(minimumDistance: 0)` and an `onTapGesture` on the same
        // view do not coexist — the drag wins arbitration and the tap never
        // fires — so clicks, drags and double-clicks all come from this one.
        //
        // `.highPriorityGesture`, never `.gesture`. The inspector is a
        // `ScrollView`, and a plain gesture loses arbitration to its scrolling
        // ancestor: a vertical drag on the plot scrolls the panel instead of
        // moving the point, which reads as the curve editor ignoring half of
        // what is done to it. This has now regressed once, in a commit whose
        // stated purpose was fixing this very control.
        .highPriorityGesture(plotGesture(in: rect))
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(channelName(channel)) tone curve")
        .accessibilityValue(
            points.count == 2 ? "Straight, no adjustment" : "\(points.count) control points"
        )
    }

    private func drawBackground(context: GraphicsContext, in rect: CGRect) {
        context.fill(
            Path(roundedRect: rect, cornerRadius: 6),
            with: .color(.white.opacity(0.04))
        )

        // Quarter gridlines. Enough to judge position, few enough not to
        // compete with the curve for attention.
        var grid = Path()
        for step in 1..<4 {
            let offset = rect.width * Double(step) / 4
            grid.move(to: CGPoint(x: offset, y: 0))
            grid.addLine(to: CGPoint(x: offset, y: rect.height))
            grid.move(to: CGPoint(x: 0, y: offset))
            grid.addLine(to: CGPoint(x: rect.width, y: offset))
        }
        context.stroke(grid, with: .color(.white.opacity(0.06)), lineWidth: 1)
    }

    /// The luminance distribution, behind the curve.
    ///
    /// Drawn faintly and filled rather than outlined: it is context, not the
    /// subject. A histogram competing with the curve for attention would defeat
    /// the point of putting it there.
    private func drawHistogram(context: GraphicsContext, in rect: CGRect) {
        let histogram = editor.histogram
        guard histogram.peak > 0 else { return }

        let bins = channel == .master ? histogram.luminance
            : channel == .red ? histogram.red
            : channel == .green ? histogram.green
            : histogram.blue

        // Normalised against a high percentile, not the peak.
        //
        // A photograph with a large flat area — a studio backdrop, a sky — puts
        // an enormous spike in one bin, and scaling to that crushes everything
        // else into the baseline. The distribution then reads as empty exactly
        // when it is most wanted: this portrait's entire shadow range vanished
        // under the backdrop's spike.
        //
        // The 98th percentile keeps the shape legible and lets the one spike
        // clip off the top, which costs nothing — nobody reads a curve editor's
        // background histogram for its absolute maximum.
        let occupied = bins.filter { $0 > 0 }.sorted()
        guard !occupied.isEmpty else { return }
        let reference = Double(occupied[Int(Double(occupied.count - 1) * 0.98)])
        guard reference > 0 else { return }

        var path = Path()
        path.move(to: CGPoint(x: 0, y: rect.height))

        for (index, count) in bins.enumerated() {
            let x = rect.width * Double(index) / Double(bins.count - 1)
            // Square root, as elsewhere: a linear scale flattens the shadow and
            // highlight detail a curve is usually being pulled to address.
            let height = min(1, (Double(count) / reference).squareRoot())
                * rect.height * 0.8
            path.addLine(to: CGPoint(x: x, y: rect.height - height))
        }
        path.addLine(to: CGPoint(x: rect.width, y: rect.height))
        path.closeSubpath()

        context.fill(path, with: .color(channel.tint.opacity(0.16)))
    }

    private func drawIdentity(context: GraphicsContext, in rect: CGRect) {
        var diagonal = Path()
        diagonal.move(to: CGPoint(x: 0, y: rect.height))
        diagonal.addLine(to: CGPoint(x: rect.width, y: 0))
        context.stroke(
            diagonal,
            with: .color(.white.opacity(0.14)),
            style: StrokeStyle(lineWidth: 1, dash: [3, 3])
        )
    }

    private func drawCurve(context: GraphicsContext, in rect: CGRect) {
        let curve = currentCurve ?? .identity
        var path = Path()

        // Sampled rather than reconstructed from the control points, so what is
        // drawn is what the renderer will actually compute — including the
        // Bézier handles the engine supports.
        let samples = 128
        for step in 0...samples {
            let x = Double(step) / Double(samples)
            let y = curve.value(at: x).clamped(to: 0...1)
            let point = CGPoint(x: rect.width * x, y: rect.height * (1 - y))
            if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }

        context.stroke(
            path,
            with: .color(channel.tint.opacity(0.95)),
            style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)
        )
    }

    /// The selected point's Bézier handles.
    ///
    /// Only the selected point's, deliberately. Every point's handles at once
    /// is a thicket that hides the curve the handles exist to shape, and the
    /// curve is the thing being judged.
    private func drawHandles(context: GraphicsContext, in rect: CGRect) {
        guard let index = selected, points.indices.contains(index) else { return }
        let anchor = CGPoint(
            x: rect.width * points[index].x,
            y: rect.height * (1 - points[index].y)
        )

        for side in [CurveEditing.HandleSide.incoming, .outgoing] {
            // A collapsed handle sits exactly on its anchor and cannot be
            // shaped without changing the curve. Drawing it would put a knob
            // under the point that moves nothing when dragged.
            guard !CurveEditing.isHandleCollapsed(index, side: side, in: points),
                  let position = CurveEditing.handlePosition(
                      index, side: side, in: points, size: Double(rect.width)
                  )
            else { continue }

            let knob = CGPoint(x: position.x, y: position.y)

            var stem = Path()
            stem.move(to: anchor)
            stem.addLine(to: knob)
            context.stroke(stem, with: .color(channel.tint.opacity(0.5)), lineWidth: 1)

            // Hollow, and smaller than a control point. A handle is subordinate
            // to the point it belongs to, and should not read as another point.
            let radius: Double = 3.5
            let dot = Path(ellipseIn: CGRect(
                x: knob.x - radius, y: knob.y - radius,
                width: radius * 2, height: radius * 2
            ))
            context.fill(dot, with: .color(.black.opacity(0.55)))
            context.stroke(dot, with: .color(channel.tint.opacity(0.9)), lineWidth: 1.5)
        }
    }

    private func drawPoints(context: GraphicsContext, in rect: CGRect) {
        for (index, point) in points.enumerated() {
            let centre = CGPoint(x: rect.width * point.x, y: rect.height * (1 - point.y))
            // Only `selected` drives this. The dragged index lives in the
            // gesture session, which deliberately does not invalidate the view
            // — reading it here would draw from state the redraw cannot see
            // change. Selection is set when a drag begins, so the highlight is
            // correct either way.
            let isActive = selected == index
            let radius: Double = isActive ? 5.5 : 4

            let dot = Path(ellipseIn: CGRect(
                x: centre.x - radius, y: centre.y - radius,
                width: radius * 2, height: radius * 2
            ))
            context.fill(dot, with: .color(.white))
            if isActive {
                context.stroke(dot, with: .color(channel.tint), lineWidth: 2)
            }
        }
    }

    /// What to tell the user, given what they can currently do.
    ///
    /// One thing at a time, and only the thing that is possible right now. A
    /// control that recites its whole vocabulary up front is read once and
    /// never again.
    private var hint: String {
        if let index = selected, CurveEditing.hasShapeableHandle(index, in: points) {
            return "Drag a handle to shape · ⌥ for a corner"
        }
        if selected != nil { return "Double-click a point to remove it" }
        if points.count == 2 { return "Click and drag to add a point" }
        return "\(points.count) points"
    }

    private func isRemovable(_ index: Int) -> Bool {
        CurveEditing.isRemovable(index, in: points)
    }

    /// Removes the selected point, if it is one that may be removed.
    private func removeSelected() -> KeyPress.Result {
        guard let index = selected, isRemovable(index) else { return .ignored }

        let updated = CurveEditing.removing(index, from: points)
        editor.update({ setCurve(ToneCurve(updated), in: &$0) }, label: "Remove Curve Point")
        selected = nil
        return .handled
    }

    // MARK: - Interaction

    private func plotGesture(in rect: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                apply(session.gesture.changed(
                    start: PlotPoint(x: value.startLocation.x, y: value.startLocation.y),
                    current: PlotPoint(x: value.location.x, y: value.location.y),
                    in: points,
                    size: rect.width,
                    selected: selected,
                    modifiers: modifiers(),
                    // The event's own timestamp, not `Date()`. A double-click is
                    // measured between the presses themselves, and reading the
                    // clock when the effect is handled folds in whatever the
                    // render took.
                    time: value.time.timeIntervalSinceReferenceDate
                ), in: rect)
            }
            .onEnded { value in
                apply(session.gesture.ended(
                    at: PlotPoint(x: value.location.x, y: value.location.y)
                ), in: rect)
            }
    }

    /// Modifier keys as the gesture understands them.
    ///
    /// `DragGesture.Value` carries no modifier state, so it is read from the
    /// current event. Sampled at the moment the gesture is handled, which is
    /// inside AppKit's dispatch of that very event.
    private func modifiers() -> CurveGesture.Modifiers {
        NSEvent.modifierFlags.contains(.option) ? [.option] : []
    }

    /// Carries out what the gesture decided.
    private func apply(_ effects: [CurveGesture.Effect], in rect: CGRect) {
        for effect in effects {
            switch effect {
            case .select(let index):
                selected = index

            case .beginInteraction:
                editor.beginInteraction(label: "Tone Curve")

            case .move(let index, let location):
                movePoint(index, to: CGPoint(x: location.x, y: location.y), in: rect)

            case .add(let location):
                addPoint(at: CGPoint(x: location.x, y: location.y), in: rect)

            case .moveHandle(let index, let side, let location, let linked):
                moveHandle(index, side: side,
                           to: CGPoint(x: location.x, y: location.y),
                           in: rect, linked: linked)

            case .remove(let index):
                let updated = CurveEditing.removing(index, from: points)
                editor.update(
                    { setCurve(ToneCurve(updated), in: &$0) },
                    label: "Remove Curve Point"
                )

            case .endInteraction:
                editor.endInteraction()
            }
        }
    }

    private func movePoint(_ index: Int, to location: CGPoint, in rect: CGRect) {
        let updated = CurveEditing.moving(
            index,
            to: (x: Double(location.x), y: Double(location.y)),
            in: points,
            size: Double(rect.width)
        )
        editor.preview { setCurve(ToneCurve(updated), in: &$0) }
    }

    /// Inserts a point mid-gesture.
    ///
    /// `preview`, not `update`: the press has already opened an interaction, and
    /// the drag that follows places the point. Recording the insertion as its
    /// own undo step would split one motion into two, so undoing after adding
    /// and dragging a point would leave the point behind at its birthplace.
    private func addPoint(at location: CGPoint, in rect: CGRect) {
        let result = CurveEditing.adding(
            at: (x: Double(location.x), y: Double(location.y)),
            to: points,
            size: Double(rect.width)
        )
        editor.preview { setCurve(ToneCurve(result.points), in: &$0) }
    }

    private func moveHandle(
        _ index: Int,
        side: CurveEditing.HandleSide,
        to location: CGPoint,
        in rect: CGRect,
        linked: Bool
    ) {
        let updated = CurveEditing.movingHandle(
            index,
            side: side,
            to: (x: Double(location.x), y: Double(location.y)),
            in: points,
            size: Double(rect.width),
            linked: linked
        )
        editor.preview { setCurve(ToneCurve(updated), in: &$0) }
    }

    // MARK: - Curve access

    private var currentCurve: ToneCurve? {
        switch channel {
        case .master: editor.state.curves.master
        case .red: editor.state.curves.red
        case .green: editor.state.curves.green
        case .blue: editor.state.curves.blue
        }
    }

    private var points: [ToneCurve.ControlPoint] {
        currentCurve?.points ?? ToneCurve.identity.points
    }

    private func setCurve(_ curve: ToneCurve?, in state: inout EditState) {
        // A curve reduced to its two endpoints, both at rest, is the identity —
        // stored as nil so the render skips the stage entirely.
        let stored: ToneCurve? = {
            guard let curve else { return nil }
            return curve == .identity ? nil : curve
        }()

        switch channel {
        case .master: state.curves.master = stored
        case .red: state.curves.red = stored
        case .green: state.curves.green = stored
        case .blue: state.curves.blue = stored
        }
    }
}
