public import CoreImage
public import CoreGraphics
import Foundation
import Metal

/// The Core Image context every render goes through, and the colour management
/// decisions baked into it.
///
/// Three choices here account for most of what the native app can do that the
/// web version cannot.
///
/// **A 16-bit float working format.** The browser pipeline is `Uint8ClampedArray`
/// end to end, which means an S-Log3 frame — fifteen stops packed into `0...1` —
/// is decoded and graded at 8 bits. Log shadows band, and no amount of curve
/// tuning fixes it. `RGBAh` ends that outright, and it costs nothing on Apple
/// silicon.
///
/// **A linear working colour space.** Core Image converts into it on the way in
/// and out, so blurs, blends and halation happen in light rather than in
/// display code values. It is the difference between a highlight bloom that
/// looks like light and one that looks like a screen blend.
///
/// **Display P3 output.** The engine already decodes wide-gamut sources; the
/// browser then discards the gamut on the way to the canvas. Here it survives
/// to the screen.
public final class RenderContext: @unchecked Sendable {

    /// The underlying Core Image context.
    public let ciContext: CIContext

    /// The Metal device backing it, when one is available.
    public let device: (any MTLDevice)?

    /// The colour space the pipeline computes in.
    ///
    /// Extended linear sRGB: linear light, with primaries that match the sRGB
    /// gamut but a range that is *not* clamped to `0...1`. Wide-gamut sources
    /// land outside that range once converted, and clamping them here would
    /// discard exactly the colour the wide gamut was for.
    public static let workingColorSpace: CGColorSpace = {
        CGColorSpace(name: CGColorSpace.extendedLinearSRGB)
            // Only fails if the system is missing a built-in colour space,
            // which would mean far more is broken than this app.
            ?? CGColorSpaceCreateDeviceRGB()
    }()

    /// The colour space renders are delivered in.
    public static let outputColorSpace: CGColorSpace = {
        CGColorSpace(name: CGColorSpace.displayP3) ?? CGColorSpaceCreateDeviceRGB()
    }()

    /// Creates a context, preferring GPU rendering.
    ///
    /// - Parameter forceSoftware: Renders on the CPU instead. Slower by orders
    ///   of magnitude, but deterministic across machines, which is what the
    ///   conformance suite needs — a GPU result that varies by driver cannot be
    ///   compared against a fixed reference.
    public init(forceSoftware: Bool = false) {
        var options: [CIContextOption: Any] = [
            .workingColorSpace: Self.workingColorSpace,
            .outputColorSpace: Self.outputColorSpace,
            // Half-float working format. `RGBAf` would be full 32-bit and is
            // not worth double the bandwidth: 16-bit float carries about 11
            // bits of mantissa, far beyond what any display or export format
            // resolves, and well beyond where banding could return.
            .workingFormat: CIFormat.RGBAh,
            // Core Image caches intermediate images between renders. During a
            // slider drag every frame differs, so the cache only costs memory.
            .cacheIntermediates: false,
        ]

        if forceSoftware {
            options[.useSoftwareRenderer] = true
            device = nil
            ciContext = CIContext(options: options)
            return
        }

        if let device = MTLCreateSystemDefaultDevice() {
            self.device = device
            ciContext = CIContext(mtlDevice: device, options: options)
        } else {
            self.device = nil
            ciContext = CIContext(options: options)
        }
    }

    /// A context suitable for verification: software-rendered, so results are
    /// reproducible on any machine.
    public static func deterministic() -> RenderContext {
        RenderContext(forceSoftware: true)
    }

    // MARK: - Rendering

    /// Renders an image to 8-bit RGBA bytes in the given colour space.
    ///
    /// - Parameters:
    ///   - image: The image to render.
    ///   - rect: The region to render, in image coordinates.
    ///   - colorSpace: Defaults to the context's output space.
    /// - Returns: Tightly packed RGBA bytes, four per pixel, row-major.
    public func renderToBytes(
        _ image: CIImage,
        in rect: CGRect,
        colorSpace: CGColorSpace? = nil
    ) -> [UInt8] {
        let width = Int(rect.width.rounded())
        let height = Int(rect.height.rounded())
        guard width > 0, height > 0 else { return [] }

        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        bytes.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            ciContext.render(
                image,
                toBitmap: base,
                rowBytes: width * 4,
                bounds: rect,
                format: .RGBA8,
                colorSpace: colorSpace ?? Self.outputColorSpace
            )
        }
        return bytes
    }

    /// Renders to a `CGImage`, for export and for handing to AppKit.
    public func makeCGImage(_ image: CIImage, in rect: CGRect) -> CGImage? {
        ciContext.createCGImage(image, from: rect, format: .RGBA8, colorSpace: Self.outputColorSpace)
    }

    /// Discards cached GPU resources.
    ///
    /// Worth calling when a document closes: Core Image holds onto texture
    /// memory that is otherwise only reclaimed under pressure.
    public func reclaimResources() {
        ciContext.clearCaches()
    }
}
