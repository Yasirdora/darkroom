public import SwiftUI
import DarkroomCore

/// The measuring instruments.
public struct ScopePanel: View {

    @Bindable public var editor: Editor

    public init(editor: Editor) {
        self.editor = editor
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Histogram")
            HistogramView(histogram: editor.histogram)
                .frame(height: 120)
                .padding(.horizontal, 16)
                .padding(.bottom, 20)

            SectionHeader(title: "Vectorscope")
            VectorscopeView(vectorscope: editor.vectorscope)
                .aspectRatio(1, contentMode: .fit)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)

            Text("Distance from centre is saturation. The diagonal is the skin-tone line.")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
                .padding(.bottom, 18)
        }
    }
}

/// Tonal distribution, all four channels overlaid.
public struct HistogramView: View {

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
public struct VectorscopeView: View {

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

    private func drawTrace(context: GraphicsContext, size: CGSize) {
        guard vectorscope.peak > 0 else { return }

        let cell = size.width / Double(vectorscope.size)
        let peak = Double(vectorscope.peak)

        for y in 0..<vectorscope.size {
            for x in 0..<vectorscope.size {
                let count = vectorscope.bins[y * vectorscope.size + x]
                guard count > 0 else { continue }

                // Square root again: without it a single dominant colour
                // saturates the plot and everything else vanishes.
                let intensity = (Double(count) / peak).squareRoot()
                context.fill(
                    Path(CGRect(
                        x: Double(x) * cell, y: Double(y) * cell,
                        width: cell + 0.5, height: cell + 0.5
                    )),
                    with: .color(.green.opacity(intensity * 0.85))
                )
            }
        }
    }
}
