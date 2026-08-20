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

    /// Index of the point being dragged, if any.
    @State private var dragging: Int?

    /// Index of the selected point, which the Delete key removes.
    @State private var selected: Int?

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
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Tone Curve")
            channelPicker
            plot
            footer
        }
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
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(channel == option ? option.tint : .secondary)
                .background {
                    RoundedRectangle(cornerRadius: 5)
                        .fill(channel == option
                            ? option.tint.opacity(0.16)
                            : Color.primary.opacity(0.05))
                }
                .accessibilityLabel(channelName(option))
                .accessibilityAddTraits(channel == option ? [.isSelected] : [])
            }
        }
        .padding(.horizontal, 16)
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

            Button("Reset") {
                editor.update({ setCurve(nil, in: &$0) }, label: "Reset Curve")
                selected = nil
            }
            .font(.system(size: 10))
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(currentCurve == nil)
        }
        .padding(.horizontal, 16)
    }

    // MARK: - Plot

    private var plot: some View {
        GeometryReader { geometry in
            let size = min(geometry.size.width, geometry.size.height)
            let rect = CGRect(x: 0, y: 0, width: size, height: size)

            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    drawBackground(context: context, in: rect)
                    drawHistogram(context: context, in: rect)
                    drawIdentity(context: context, in: rect)
                    drawCurve(context: context, in: rect)
                    drawPoints(context: context, in: rect)
                }
                .frame(width: size, height: size)
                .contentShape(Rectangle())
                .gesture(dragGesture(in: rect))
                .onTapGesture { location in
                    addPoint(at: location, in: rect)
                }
                // Focusable so the plot can take key events at all. Without it
                // Delete goes to whatever else holds focus, and a selected point
                // simply cannot be removed.
                .focusable()
                .focusEffectDisabled()
                .onKeyPress(.delete) { removeSelected() }
                .onKeyPress(.deleteForward) { removeSelected() }
            }
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .aspectRatio(1, contentMode: .fit)
        .padding(.horizontal, 16)
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

    private func drawPoints(context: GraphicsContext, in rect: CGRect) {
        for (index, point) in points.enumerated() {
            let centre = CGPoint(x: rect.width * point.x, y: rect.height * (1 - point.y))
            let isActive = dragging == index || selected == index
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
    private var hint: String {
        if selected != nil, isRemovable(selected!) { return "Delete removes the point" }
        if points.count == 2 { return "Click to add a point" }
        return "\(points.count) points"
    }

    /// Whether a point can be removed.
    ///
    /// The two endpoints cannot: a curve needs a value at both ends of the
    /// range, and removing one would leave the tones beyond it undefined.
    private func isRemovable(_ index: Int) -> Bool {
        index > 0 && index < points.count - 1
    }

    /// Removes the selected point, if it is one that may be removed.
    private func removeSelected() -> KeyPress.Result {
        guard let index = selected, isRemovable(index) else { return .ignored }

        var updated = points
        updated.remove(at: index)
        editor.update({ setCurve(ToneCurve(updated), in: &$0) }, label: "Remove Curve Point")
        selected = nil
        return .handled
    }

    // MARK: - Interaction

    private func dragGesture(in rect: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { gesture in
                if dragging == nil {
                    dragging = nearestPoint(to: gesture.startLocation, in: rect)
                    if let dragging {
                        selected = dragging
                        editor.beginInteraction(label: "Tone Curve")
                    }
                }
                guard let index = dragging else { return }
                movePoint(index, to: gesture.location, in: rect)
            }
            .onEnded { _ in
                if dragging != nil { editor.endInteraction() }
                dragging = nil
            }
    }

    /// The point under the cursor, if one is close enough to grab.
    ///
    /// The radius is far larger than the dot on purpose. Aiming at a 4-point
    /// target is a task in itself, and every moment spent on it is a moment not
    /// spent looking at the photograph.
    private func nearestPoint(to location: CGPoint, in rect: CGRect) -> Int? {
        let grabRadius: Double = 14

        var best: (index: Int, distance: Double)?
        for (index, point) in points.enumerated() {
            let centre = CGPoint(x: rect.width * point.x, y: rect.height * (1 - point.y))
            let distance = Double(hypot(centre.x - location.x, centre.y - location.y))
            if distance <= grabRadius, best == nil || distance < best!.distance {
                best = (index, distance)
            }
        }
        return best?.index
    }

    private func movePoint(_ index: Int, to location: CGPoint, in rect: CGRect) {
        var updated = points
        guard index < updated.count else { return }

        let x = (location.x / rect.width).clamped(to: 0...1)
        let y = (1 - location.y / rect.height).clamped(to: 0...1)

        // The endpoints keep their x. Letting them slide inward leaves the curve
        // undefined outside them, and the engine holds the endpoint value there
        // — which reads as the curve mysteriously flattening at one end.
        if index == 0 {
            updated[index] = .init(x: 0, y: y)
        } else if index == updated.count - 1 {
            updated[index] = .init(x: 1, y: y)
        } else {
            // Interior points stay ordered. A curve is a function: two points
            // sharing an x would make it ambiguous, and the interpolator would
            // pick one arbitrarily.
            let lower = updated[index - 1].x + 0.01
            let upper = updated[index + 1].x - 0.01
            updated[index] = .init(x: x.clamped(to: lower...max(lower, upper)), y: y)
        }

        editor.preview { setCurve(ToneCurve(updated), in: &$0) }
    }

    private func addPoint(at location: CGPoint, in rect: CGRect) {
        // A click on an existing point selects rather than adds. Adding a second
        // point on top of one already there is never what was meant.
        if let existing = nearestPoint(to: location, in: rect) {
            selected = existing
            return
        }

        let x = (location.x / rect.width).clamped(to: 0.02...0.98)
        let y = (1 - location.y / rect.height).clamped(to: 0...1)

        var updated = points
        let insertion = updated.firstIndex { $0.x > x } ?? updated.count
        updated.insert(.init(x: x, y: y), at: insertion)

        editor.update({ setCurve(ToneCurve(updated), in: &$0) }, label: "Add Curve Point")
        selected = insertion
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
