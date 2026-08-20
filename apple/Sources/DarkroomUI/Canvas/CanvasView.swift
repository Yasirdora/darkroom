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

            guard let image, !image.extent.isInfinite, !image.extent.isEmpty else {
                // Nothing to draw, but the drawable still needs presenting or
                // the window keeps whatever was there before.
                commands.present(drawable)
                commands.commit()
                return
            }

            let placed = place(image, in: target, scale: view.drawableSize.width / view.bounds.width)

            context.ciContext.render(
                placed,
                to: drawable.texture,
                commandBuffer: commands,
                bounds: target,
                colorSpace: RenderContext.outputColorSpace
            )

            commands.present(drawable)
            commands.commit()
        }

        /// Scales and centres the image within the drawable.
        private func place(_ image: CIImage, in target: CGRect, scale: CGFloat) -> CIImage {
            let extent = image.extent

            let factor: CGFloat
            if let zoom {
                factor = CGFloat(zoom) * scale
            } else {
                // Fit, but never enlarge: scaling a small image up to fill the
                // window shows its pixels, not its grade.
                factor = min(
                    min(target.width / extent.width, target.height / extent.height),
                    scale
                )
            }

            let scaled = image.transformed(by: CGAffineTransform(scaleX: factor, y: factor))
            let bounds = scaled.extent

            return scaled.transformed(
                by: CGAffineTransform(
                    translationX: target.midX - bounds.midX,
                    y: target.midY - bounds.midY
                )
            )
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

    public init(editor: Editor, rendering: CanvasRendering = .live) {
        self.editor = editor
        self.rendering = rendering
    }

    public var body: some View {
        ZStack {
            surround

            if editor.hasImage {
                canvas.padding(24)
            } else {
                EmptyCanvas()
            }

            if editor.isComparing {
                comparisonBadge
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var canvas: some View {
        switch rendering {
        case .live:
            CanvasView(image: editor.displayImage, context: editor.renderContext)
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
