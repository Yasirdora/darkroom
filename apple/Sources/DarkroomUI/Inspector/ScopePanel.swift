public import SwiftUI
import DarkroomCore

/// The measuring instruments.
public struct ScopePanel: View {

    @Bindable public var editor: Editor

    public init(editor: Editor) {
        self.editor = editor
    }

    public var body: some View {
        GlassPaneStack {
            InspectorCard(title: "Histogram", id: "scope.histogram", editor: editor) {
                HistogramView(histogram: editor.histogram)
                    // `.equatable()` so these redraw only when the measurement
                    // changes. Without it every observable change on the editor
                    // — moving a slider, or merely clicking zoom — redraws both
                    // scopes, and the vectorscope is thousands of fills. That
                    // was the cause of zoom feeling like it hung: nothing about
                    // the render was slow, the panel beside it was being
                    // rebuilt.
                    .equatable()
                    .frame(height: 120)
            }

            InspectorCard(title: "Vectorscope", id: "scope.vectorscope", editor: editor) {
                VStack(alignment: .leading, spacing: 8) {
                    VectorscopeView(vectorscope: editor.vectorscope)
                        .equatable()
                        .aspectRatio(1, contentMode: .fit)

                    Text("Distance from centre is saturation. The diagonal is the skin-tone line.")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, InspectorGeometry.panelInset)
    }
}

/// Tonal distribution, all four channels overlaid.
public struct HistogramView: View, Equatable {

    public let histogram: Histogram

    public init(histogram: Histogram) {
        self.histogram = histogram
    }

    public var body: some View {
        Canvas { context, size in
            let background = Path(
                roundedRect: CGRect(origin: .zero, size: size),
                cornerRadius: 5
            )
            context.fill(background, with: .color(.white.opacity(0.04)))

            guard histogram.peak > 0 else { return }

            // Overlaid with a lighten blend rather than stacked: where all three
            // channels coincide the result reads white, which is exactly the
            // information wanted — it shows where the image is neutral.
            for (channel, colour) in [
                (histogram.red, Color.red),
                (histogram.green, Color.green),
                (histogram.blue, Color.blue),
            ] {
                context.fill(
                    path(for: channel, in: size),
                    with: .color(colour.opacity(0.55))
                )
            }

            context.stroke(
                path(for: histogram.luminance, in: size),
                with: .color(.white.opacity(0.65)),
                lineWidth: 1
            )
        }
        .drawingGroup()
        .accessibilityLabel("Histogram")
        .accessibilityValue(summary)
    }

    private func path(for bins: [UInt32], in size: CGSize) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: size.height))

        let peak = Double(histogram.peak)
        for (index, count) in bins.enumerated() {
            let x = size.width * Double(index) / Double(bins.count - 1)
            // Square root, not linear. A photograph's histogram is dominated by
            // its midtones, and on a linear scale the shadow and highlight
            // detail that actually needs judging is flattened into the baseline.
            let height = (Double(count) / peak).squareRoot() * size.height
            path.addLine(to: CGPoint(x: x, y: size.height - height))
        }

        path.addLine(to: CGPoint(x: size.width, y: size.height))
        path.closeSubpath()
        return path
    }

    /// Spoken description, for VoiceOver.
    ///
    /// Clipping is the thing a histogram exists to reveal, so that is what gets
    /// said — not a recital of 256 numbers nobody could hold in their head.
    private var summary: String {
        guard histogram.peak > 0 else { return "No image" }

        let total = histogram.luminance.reduce(0) { $0 + Int($1) }
        guard total > 0 else { return "No image" }

        let shadows = histogram.luminance[0..<16].reduce(0) { $0 + Int($1) }
        let highlights = histogram.luminance[240..<256].reduce(0) { $0 + Int($1) }

        var parts: [String] = []
        if Double(shadows) / Double(total) > 0.02 {
            parts.append("\(Int(Double(shadows) / Double(total) * 100))% clipped in shadow")
        }
        if Double(highlights) / Double(total) > 0.02 {
            parts.append("\(Int(Double(highlights) / Double(total) * 100))% clipped in highlight")
        }
        return parts.isEmpty ? "No clipping" : parts.joined(separator: ", ")
    }
}

/// Chroma distribution on the Cb/Cr plane.
public struct VectorscopeView: View, Equatable {

    public let vectorscope: Vectorscope

    public init(vectorscope: Vectorscope) {
        self.vectorscope = vectorscope
    }

    public var body: some View {
        Canvas { context, size in
            let radius = min(size.width, size.height) / 2
            let centre = CGPoint(x: size.width / 2, y: size.height / 2)

            context.fill(
                Path(ellipseIn: CGRect(
                    x: centre.x - radius, y: centre.y - radius,
                    width: radius * 2, height: radius * 2
                )),
                with: .color(.white.opacity(0.04))
            )

            drawGraticule(context: context, centre: centre, radius: radius)
            drawSkinToneLine(context: context, centre: centre, radius: radius)
            drawTrace(context: context, size: size)
        }
        .drawingGroup()
        .accessibilityLabel("Vectorscope")
    }

    private func drawGraticule(context: GraphicsContext, centre: CGPoint, radius: Double) {
        for ring in [0.33, 0.66, 1.0] {
            let r = radius * ring
            context.stroke(
                Path(ellipseIn: CGRect(x: centre.x - r, y: centre.y - r, width: r * 2, height: r * 2)),
                with: .color(.white.opacity(ring == 1.0 ? 0.18 : 0.07)),
                lineWidth: 1
            )
        }

        var axes = Path()
        axes.move(to: CGPoint(x: centre.x - radius, y: centre.y))
        axes.addLine(to: CGPoint(x: centre.x + radius, y: centre.y))
        axes.move(to: CGPoint(x: centre.x, y: centre.y - radius))
        axes.addLine(to: CGPoint(x: centre.x, y: centre.y + radius))
        context.stroke(axes, with: .color(.white.opacity(0.09)), lineWidth: 1)
    }

    /// The Rec.709 skin-tone line.
    ///
    /// Skin of every complexion falls along this line — what differs between
    /// light and dark skin is luminance, not hue. Drawing it lets faces be
    /// checked against a reference instead of against memory, which is the
    /// single most useful thing a vectorscope does in portrait work.
    private func drawSkinToneLine(context: GraphicsContext, centre: CGPoint, radius: Double) {
        let range = Vectorscope.chromaRange
        func point(_ offset: (cb: Double, cr: Double)) -> CGPoint {
            CGPoint(
                x: centre.x + (offset.cb / range) * radius,
                y: centre.y - (offset.cr / range) * radius
            )
        }

        var line = Path()
        line.move(to: centre)
        line.addLine(to: point(Vectorscope.SkinToneLine.light))
        context.stroke(
            line,
            with: .color(Color(red: 1, green: 0.72, blue: 0.55).opacity(0.42)),
            style: StrokeStyle(lineWidth: 1, dash: [3, 3])
        )
    }

    /// Draws the chroma trace.
    ///
    /// Bins are grouped into a handful of intensity bands and each band drawn as
    /// a single path, rather than one fill per bin. A 96×96 scope is 9,216 bins,
    /// and nine thousand separate fills through `GraphicsContext` is slow enough
    /// to be felt — it made an unrelated click elsewhere in the window appear to
    /// hang, because the panel was being rebuilt behind it.
    ///
    /// Banding costs nothing visible: the trace is read as a shape and a
    /// density, and the eye does not resolve a continuous alpha ramp across
    /// two-pixel cells.
    private func drawTrace(context: GraphicsContext, size: CGSize) {
        guard vectorscope.peak > 0 else { return }

        let cell = size.width / Double(vectorscope.size)
        let peak = Double(vectorscope.peak)
        let bandCount = 6

        var bands = [Path](repeating: Path(), count: bandCount)

        for y in 0..<vectorscope.size {
            for x in 0..<vectorscope.size {
                let count = vectorscope.bins[y * vectorscope.size + x]
                guard count > 0 else { continue }

                // Square root again: without it a single dominant colour
                // saturates the plot and everything else vanishes.
                let intensity = (Double(count) / peak).squareRoot()
                let band = min(bandCount - 1, Int(intensity * Double(bandCount)))
                bands[band].addRect(CGRect(
                    x: Double(x) * cell, y: Double(y) * cell,
                    width: cell + 0.5, height: cell + 0.5
                ))
            }
        }

        for (index, path) in bands.enumerated() where !path.isEmpty {
            let intensity = Double(index + 1) / Double(bandCount)
            context.fill(path, with: .color(.green.opacity(intensity * 0.85)))
        }
    }
}
