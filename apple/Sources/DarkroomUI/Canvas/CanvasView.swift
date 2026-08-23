public import SwiftUI
import MetalKit
import CoreImage
import DarkroomCore
import DarkroomRender

/// The image, drawn through Metal.
///
/// An `MTKView` rather than SwiftUI's `Canvas`: the image is already a
/// `CIImage` living on the GPU, and drawing it means handing Core Image a
/// drawable to render into. Going through SwiftUI would mean a round trip to a
/// `CGImage` and back on every frame, which is the difference between a slider
/// that tracks the cursor and one that lags behind it.
public struct CanvasView: NSViewRepresentable {

    public var image: CIImage?
    public var context: RenderContext

    /// Zoom factor, or `nil` to fit the window.
    public var zoom: Double?

    public init(image: CIImage?, context: RenderContext, zoom: Double? = nil) {
        self.image = image
        self.context = context
        self.zoom = zoom
    }

    public func makeNSView(context nsContext: Context) -> MTKView {
        let view = MTKView()
        view.device = self.context.device ?? MTLCreateSystemDefaultDevice()
        view.framebufferOnly = false
        view.delegate = nsContext.coordinator

        // Drawn on demand rather than at 60 Hz. Nothing moves unless the grade
        // changes, and an idle editor should not keep a GPU awake.
        view.isPaused = true
        view.enableSetNeedsDisplay = true

        // The surround is opaque and neutral by decision, not by default.
        // Colour judgement is relative: a translucent or tinted background
        // shifts how every colour in the image is perceived, which is why
        // grading suites paint their walls a specific grey. Liquid Glass
        // belongs on the chrome, never behind the picture.
        view.layer?.isOpaque = true
        view.clearColor = MTLClearColor(red: 0.10, green: 0.10, blue: 0.105, alpha: 1)

        // Wide gamut, and more than 8 bits per channel. Without this the window
        // would clamp a Display P3 grade back to sRGB at the very last step,
        // undoing the one thing the pipeline works in float to preserve.
        view.colorPixelFormat = .rgba16Float
        view.colorspace = RenderContext.outputColorSpace

        nsContext.coordinator.update(image: image, context: self.context, zoom: zoom)
        return view
    }

    public func updateNSView(_ view: MTKView, context nsContext: Context) {
        nsContext.coordinator.update(image: image, context: self.context, zoom: zoom)
        view.setNeedsDisplay(view.bounds)
    }

    public func makeCoordinator() -> Renderer { Renderer() }

    /// Draws the image, fitted or zoomed, into the drawable.
    public final class Renderer: NSObject, MTKViewDelegate {
        private var image: CIImage?
        private var context: RenderContext?
        private var zoom: Double?
        private var commandQueue: (any MTLCommandQueue)?

        func update(image: CIImage?, context: RenderContext, zoom: Double?) {
            self.image = image
            self.context = context
            self.zoom = zoom
            if commandQueue == nil {
                commandQueue = context.device?.makeCommandQueue()
            }
        }

        public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

        public func draw(in view: MTKView) {
            guard let drawable = view.currentDrawable,
                  let context,
                  let commandQueue,
                  let commands = commandQueue.makeCommandBuffer()
            else { return }

            let target = CGRect(
                origin: .zero,
                size: CGSize(width: drawable.texture.width, height: drawable.texture.height)
            )

            // The composition lives in DarkroomRender so it can be checked; see
            // CanvasComposition for why every pixel of the target must be
            // written on every frame.
            let composited = CanvasComposition.compose(
                image,
                in: target,
                zoom: zoom,
                contentScale: view.drawableSize.width / max(view.bounds.width, 1)
            )

            context.ciContext.render(
                composited,
                to: drawable.texture,
                commandBuffer: commands,
                bounds: target,
                colorSpace: RenderContext.outputColorSpace
            )

            commands.present(drawable)
            commands.commit()
        }
    }
}

/// How the canvas draws.
public enum CanvasRendering: Sendable {
    /// Metal, drawing the Core Image chain straight to a drawable. What the app
    /// uses: nothing is copied and nothing is quantised on the way to the screen.
    case live
    /// A rendered still. Slower and read-only, but it works anywhere a normal
    /// view works — inside a `cacheDisplay` pass, a print context, or a
    /// thumbnail. A Metal layer draws in none of those.
    case still
}

/// The canvas and everything shown over it.
public struct CanvasArea: View {

    @Bindable public var editor: Editor
    public var rendering: CanvasRendering

    /// The part of the canvas that floating chrome sits over.
    ///
    /// The canvas runs edge to edge — under the inspector, behind the window
    /// buttons — so that the window reads as one surface with things floating
    /// on it rather than as panels butted together. The photograph is confined
    /// to what is left, because a picture hidden behind a panel is a picture
    /// you cannot judge, and a translucent panel with a photograph behind it
    /// takes its colour from whatever you are grading.
    ///
    /// The surround passes underneath quite happily: it is a fixed neutral and
    /// has nothing to give away.
    public var occlusion: EdgeInsets

    public init(
        editor: Editor,
        rendering: CanvasRendering = .live,
        occlusion: EdgeInsets = EdgeInsets()
    ) {
        self.editor = editor
        self.rendering = rendering
        self.occlusion = occlusion
    }

    public var body: some View {
        ZStack {
            // The surround alone runs the full width and height of the window,
            // beneath the inspector and behind the window buttons. It is a
            // fixed neutral, so it has nothing to give away by being seen
            // through translucent chrome.
            surround

            if editor.hasImage {
                // Everything else is inset by the occlusion, so the photograph
                // and the controls that describe it stay in the part of the
                // window nothing is floating over.
                canvas
                    .padding(editor.zoom == nil ? 24 : 0)
                    .padding(occlusion)
            } else {
                EmptyCanvas().padding(occlusion)
            }

            if editor.isComparing {
                comparisonBadge.padding(occlusion)
            }

            if editor.hasImage, !editor.state.look.isNone, !editor.isComparing {
                lookBadge.padding(occlusion)
            }

            if editor.hasImage {
                zoomControl.padding(occlusion)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var canvas: some View {
        switch rendering {
        case .live:
            CanvasView(
                image: editor.displayImage,
                context: editor.renderContext,
                zoom: editor.zoom
            )
        case .still:
            if let image = stillImage {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else {
                Color.clear
            }
        }
    }

    /// The graded image as a `CGImage`, at a size suited to viewing rather than
    /// to export.
    private var stillImage: CGImage? {
        guard let image = editor.displayImage, !image.extent.isInfinite else { return nil }
        let extent = image.extent
        let scale = min(1, 2400 / max(extent.width, extent.height))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return editor.renderContext.makeCGImage(scaled, in: scaled.extent)
    }

    /// The neutral ground the image sits on.
    ///
    /// A fixed grey rather than a system material, and the same grey in light
    /// mode and dark. Colour is judged relative to its surroundings, so a
    /// surround that changes with the system theme would change how every grade
    /// reads — the appearance setting would become a colour control.
    private var surround: some View {
        Color(red: 0.10, green: 0.10, blue: 0.105)
            .ignoresSafeArea()
    }

    /// The zoom readout, bottom-right over the canvas.
    ///
    /// Over the canvas rather than in the toolbar, because it describes what is
    /// on the canvas. It stays quiet at Fit and only asserts itself once the
    /// view is no longer showing the whole photograph — which is the state worth
    /// being reminded of.
    private var zoomControl: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                HStack(spacing: 0) {
                    zoomButton("minus", label: "Zoom out") { editor.zoomOut() }

                    Button {
                        editor.zoom == nil ? editor.zoomToActualSize() : editor.zoomToFit()
                    } label: {
                        Text(editor.zoomDescription)
                            .font(.system(size: 10, weight: .medium, design: .rounded))
                            .monospacedDigit()
                            .frame(width: 46, height: 24)
                            // Without this the clickable region is the glyphs
                            // themselves. See `zoomButton`.
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(editor.zoom == nil ? "Zoom to 100%" : "Fit to window")
                    .accessibilityLabel("Zoom \(editor.zoomDescription)")

                    zoomButton("plus", label: "Zoom in") { editor.zoomIn() }
                }
                .foregroundStyle(editor.zoom == nil ? .secondary : .primary)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(.white.opacity(0.08)))
                .padding(12)
            }
        }
        // The container must not swallow clicks meant for the canvas beneath it.
        // Spacers fill the whole canvas area, and without this the whole ZStack
        // layer would be hit-testable rather than just the capsule.
        .allowsHitTesting(true)
    }

    /// One of the zoom stepper buttons.
    ///
    /// `.contentShape(Rectangle())` is the point of this existing, and its
    /// absence is why the control felt unresponsive. With `.buttonStyle(.plain)`
    /// the hit region is the label's *rendered shape*, not its frame — for an
    /// SF Symbol "minus" that is a bar a few points tall, so a click landed only
    /// if it hit the stroke. `.frame` sets layout size and does not touch hit
    /// testing; the content shape does.
    private func zoomButton(
        _ symbol: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 26, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var comparisonBadge: some View {
        VStack {
            Text("Before")
                .font(.system(size: 11, weight: .semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(.regularMaterial, in: Capsule())
                .padding(.top, 16)
            Spacer()
        }
    }

    /// The active look, named on the canvas it grades.
    ///
    /// A look is otherwise invisible state: the row that selected it may be
    /// scrolled out of view, and the canvas is the thing actually being
    /// looked at. The chip answers "what is on this image?" without a trip
    /// to the inspector — the same way Find My labels the selected dot on
    /// the map rather than making you check the list.
    ///
    /// Intensity appears only when it departs from full strength — quiet at
    /// the default, for the same reason the zoom readout is quiet at Fit.
    /// Hidden while comparing: the before image carries no look, and naming
    /// one over it would be a lie.
    private var lookBadge: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                Text(badgeText)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(.regularMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(.white.opacity(0.08)))
                    .padding(12)
                Spacer()
            }
        }
        // A status, not a control: it must never swallow a click meant for
        // the canvas beneath it.
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    private var badgeText: String {
        let title = editor.state.look.title
        let intensity = Int(editor.state.lookIntensity.rounded())
        return intensity == 100 ? title : "\(title) · \(intensity)%"
    }
}

/// What fills the window before a photograph is open.
struct EmptyCanvas: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "photo")
                .font(.system(size: 40, weight: .thin))
                .foregroundStyle(.tertiary)
            Text("Open a photograph")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.secondary)
            Text("or drag one here")
                .font(.system(size: 12))
                .foregroundStyle(.tertiary)
        }
    }
}
